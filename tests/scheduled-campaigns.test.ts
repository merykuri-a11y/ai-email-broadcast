import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { runTick } from "@/lib/worker";
import { POST as scheduleCampaign } from "@/app/api/campaigns/[id]/schedule/route";
import { POST as rescheduleCampaign } from "@/app/api/campaigns/[id]/reschedule/route";
import { POST as cancelCampaign } from "@/app/api/campaigns/[id]/cancel/route";
import { POST as sendCampaign } from "@/app/api/campaigns/[id]/send/route";
import { startFakeSmtp, type FakeSmtp } from "./smtp-server";
import {
  addContact, countByStatus, createCampaign, createList, getCampaign, resetDatabase,
} from "./helpers";

/**
 * Same auth-bypass pattern as campaign-lifecycle.test.ts: the guards
 * themselves are covered by api-auth.test.ts, so these exercise the route
 * logic directly.
 */
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: "test-admin", email: "admin@example.test" }),
    requireAdminMutation: async () => ({ id: "test-admin", email: "admin@example.test" }),
    assertSameOrigin: async () => undefined,
  };
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonRequest = (body: unknown = {}) =>
  new Request("https://mail.example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let smtp: FakeSmtp;

beforeEach(async () => {
  await resetDatabase();
  smtp = await startFakeSmtp();

  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_SECURITY = "none";
  process.env.SMTP_USER = "tester";
  process.env.SMTP_PASSWORD = "secret";
  process.env.SMTP_FROM_EMAIL = "sender@example.test";
  process.env.SMTP_FROM_NAME = "Test Sender";
  process.env.SMTP_MAX_EMAILS_PER_HOUR = "5000";
  process.env.WORKER_TICK_INTERVAL_SECONDS = "3600";
  process.env.WORKER_BATCH_CAP = "50";
});

afterEach(async () => { await smtp.close(); });
afterAll(async () => { await sql.end(); });

/** A DRAFT campaign with one real recipient behind it, ready to send/schedule. */
async function draftCampaignWithRecipient(email = "a@example.test"): Promise<string> {
  const listId = await createList("Test list");
  await addContact(listId, email, "Ann");
  return createCampaign({ status: "DRAFT", listIds: [listId] });
}

/* ---------------------------------------------------------- POST /schedule */

describe("POST /api/campaigns/:id/schedule", () => {
  it("moves a DRAFT campaign to SCHEDULED and stores the instant, without generating recipients yet", async () => {
    const campaignId = await draftCampaignWithRecipient();
    const future = new Date(Date.now() + 60 * 60 * 1000);

    const response = await scheduleCampaign(jsonRequest({ scheduledAt: future.toISOString() }), ctx(campaignId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.campaign.status).toBe("SCHEDULED");

    const campaign = await getCampaign(campaignId);
    expect(campaign.status).toBe("SCHEDULED");
    expect(new Date(campaign.scheduled_at as string).getTime()).toBe(future.getTime());
    // Recipients are only materialized once the worker actually activates it.
    expect(await countByStatus(campaignId)).toEqual({});
  });

  it("rejects a past date on the backend, independent of any frontend check", async () => {
    const campaignId = await draftCampaignWithRecipient();
    const past = new Date(Date.now() - 60_000);

    const response = await scheduleCampaign(jsonRequest({ scheduledAt: past.toISOString() }), ctx(campaignId));

    expect(response.status).toBe(400);
    expect((await getCampaign(campaignId)).status).toBe("DRAFT");
  });

  it("rejects a missing or unparseable date", async () => {
    const campaignId = await draftCampaignWithRecipient();
    expect((await scheduleCampaign(jsonRequest({}), ctx(campaignId))).status).toBe(400);
    expect((await scheduleCampaign(jsonRequest({ scheduledAt: "not-a-date" }), ctx(campaignId))).status).toBe(400);
  });

  it("refuses to schedule a campaign that is not a draft", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    const future = new Date(Date.now() + 60 * 60 * 1000);

    const response = await scheduleCampaign(jsonRequest({ scheduledAt: future.toISOString() }), ctx(campaignId));
    expect(response.status).toBe(409);
  });

  it("requires SMTP to be configured, exactly like send now", async () => {
    delete process.env.SMTP_HOST;
    const campaignId = await draftCampaignWithRecipient();
    const future = new Date(Date.now() + 60 * 60 * 1000);

    const response = await scheduleCampaign(jsonRequest({ scheduledAt: future.toISOString() }), ctx(campaignId));
    expect(response.status).toBe(400);
  });

  it("stores the same absolute instant no matter what UTC offset it arrives in", async () => {
    const campaignId = await draftCampaignWithRecipient();
    const future = new Date(Date.now() + 3 * 60 * 60 * 1000);

    // Express that same instant as a UTC+2 wall-clock time (e.g. Europe/Madrid
    // in summer) instead of a bare "Z" string.
    const plusTwo = new Date(future.getTime() + 2 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const pad3 = (n: number) => String(n).padStart(3, "0");
    const offsetIso =
      `${plusTwo.getUTCFullYear()}-${pad(plusTwo.getUTCMonth() + 1)}-${pad(plusTwo.getUTCDate())}` +
      `T${pad(plusTwo.getUTCHours())}:${pad(plusTwo.getUTCMinutes())}:${pad(plusTwo.getUTCSeconds())}` +
      `.${pad3(plusTwo.getUTCMilliseconds())}+02:00`;

    const response = await scheduleCampaign(jsonRequest({ scheduledAt: offsetIso }), ctx(campaignId));
    expect(response.status).toBe(200);

    const campaign = await getCampaign(campaignId);
    expect(new Date(campaign.scheduled_at as string).getTime()).toBe(future.getTime());
  });
});

/* -------------------------------------------------------- POST /reschedule */

describe("POST /api/campaigns/:id/reschedule", () => {
  it("updates scheduledAt while still SCHEDULED", async () => {
    const original = new Date(Date.now() + 60 * 60 * 1000);
    const campaignId = await createCampaign({ status: "SCHEDULED", scheduledAt: original });
    const updated = new Date(Date.now() + 2 * 60 * 60 * 1000);

    const response = await rescheduleCampaign(jsonRequest({ scheduledAt: updated.toISOString() }), ctx(campaignId));
    expect(response.status).toBe(200);

    const campaign = await getCampaign(campaignId);
    expect(new Date(campaign.scheduled_at as string).getTime()).toBe(updated.getTime());
  });

  it("rejects a past date", async () => {
    const campaignId = await createCampaign({ status: "SCHEDULED", scheduledAt: new Date(Date.now() + 60_000) });
    const past = new Date(Date.now() - 60_000);

    const response = await rescheduleCampaign(jsonRequest({ scheduledAt: past.toISOString() }), ctx(campaignId));
    expect(response.status).toBe(400);
  });

  it.each(["QUEUED", "SENDING", "COMPLETED", "CANCELLED"] as const)(
    "refuses to reschedule a campaign that is %s",
    async (status) => {
      const campaignId = await createCampaign({ status });
      const future = new Date(Date.now() + 60 * 60 * 1000);

      const response = await rescheduleCampaign(jsonRequest({ scheduledAt: future.toISOString() }), ctx(campaignId));
      expect(response.status).toBe(409);
      expect((await getCampaign(campaignId)).status).toBe(status);
    },
  );

  it("stops the old scheduled time from activating the campaign once rescheduled", async () => {
    const campaignId = await draftCampaignWithRecipient();
    await scheduleCampaign(jsonRequest({ scheduledAt: new Date(Date.now() + 60_000).toISOString() }), ctx(campaignId));

    // Let the original instant fall into the past, as if the worker were
    // about to pick it up, then push it back out before any tick runs.
    await sql`UPDATE campaigns SET scheduled_at = now() - interval '1 minute' WHERE id = ${campaignId}`;
    const pushedOut = new Date(Date.now() + 60 * 60 * 1000);
    const response = await rescheduleCampaign(jsonRequest({ scheduledAt: pushedOut.toISOString() }), ctx(campaignId));
    expect(response.status).toBe(200);

    const result = await runTick({ timeBudgetMs: 5_000 });

    expect(result.activatedScheduled).toBe(0);
    expect((await getCampaign(campaignId)).status).toBe("SCHEDULED");
    expect(smtp.messages).toHaveLength(0);
  });

  it("automatic activation uses the new time once the campaign has been rescheduled", async () => {
    const campaignId = await draftCampaignWithRecipient("rescheduled@example.test");
    await scheduleCampaign(
      jsonRequest({ scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
      ctx(campaignId),
    );
    await rescheduleCampaign(jsonRequest({ scheduledAt: new Date(Date.now() + 60_000).toISOString() }), ctx(campaignId));

    // Neither the original far-future time nor "now" is due yet.
    expect((await runTick({ timeBudgetMs: 5_000 })).activatedScheduled).toBe(0);
    expect((await getCampaign(campaignId)).status).toBe("SCHEDULED");

    // Fast-forward to the rescheduled instant and confirm it — not the
    // original one — is what drives activation.
    await sql`UPDATE campaigns SET scheduled_at = now() - interval '1 minute' WHERE id = ${campaignId}`;
    const result = await runTick({ timeBudgetMs: 10_000 });

    expect(result.activatedScheduled).toBe(1);
    expect(smtp.messages.flatMap((m) => m.to)).toEqual(["rescheduled@example.test"]);
    expect((await getCampaign(campaignId)).status).toBe("COMPLETED");
  });

  it("never double-activates when a reschedule races an overdue tick", async () => {
    const listId = await createList("Test list");
    for (let i = 0; i < 5; i++) await addContact(listId, `racer${i}@example.test`);
    const campaignId = await createCampaign({
      status: "SCHEDULED",
      scheduledAt: new Date(Date.now() - 1000),
      listIds: [listId],
    });
    const pushedOut = new Date(Date.now() + 60 * 60 * 1000);

    // Both requests race the same row: the reschedule's conditional UPDATE
    // (status = 'SCHEDULED') and the tick's (status = 'SCHEDULED' AND
    // scheduled_at <= now()) can only ever have one winner under Postgres's
    // read-committed row locking, so exactly one of the two takes effect.
    const [rescheduleResponse, tickResult] = await Promise.all([
      rescheduleCampaign(jsonRequest({ scheduledAt: pushedOut.toISOString() }), ctx(campaignId)),
      runTick({ timeBudgetMs: 10_000 }),
    ]);

    const campaign = await getCampaign(campaignId);
    if (rescheduleResponse.status === 200) {
      // Reschedule won: the tick must not have touched this campaign.
      expect(tickResult.activatedScheduled).toBe(0);
      expect(campaign.status).toBe("SCHEDULED");
      expect(new Date(campaign.scheduled_at as string).getTime()).toBe(pushedOut.getTime());
      expect(smtp.messages).toHaveLength(0);
    } else {
      // The tick won: it activated (and fully sent) before the reschedule
      // could apply, so the conditional UPDATE correctly rejected it.
      expect(rescheduleResponse.status).toBe(409);
      expect(tickResult.activatedScheduled).toBe(1);
      expect(campaign.status).toBe("COMPLETED");
      expect(smtp.messages).toHaveLength(5);
    }
    // Whichever side won, no recipient is ever emailed more than once.
    expect(new Set(smtp.messages.flatMap((m) => m.to)).size).toBe(smtp.messages.length);
  });
});

/* ---------------------------------------------------------- cancellation */

describe("cancelling a scheduled campaign", () => {
  it("SCHEDULED -> CANCELLED, and an overdue cancelled campaign is never activated", async () => {
    const campaignId = await draftCampaignWithRecipient();
    await scheduleCampaign(jsonRequest({ scheduledAt: new Date(Date.now() + 60_000).toISOString() }), ctx(campaignId));

    const cancelResponse = await cancelCampaign(jsonRequest(), ctx(campaignId));
    expect(cancelResponse.status).toBe(200);
    expect((await getCampaign(campaignId)).status).toBe("CANCELLED");

    // Move the (now irrelevant) scheduled time into the past and tick: a
    // cancelled campaign must never be picked up by the promotion query.
    await sql`UPDATE campaigns SET scheduled_at = now() - interval '1 minute' WHERE id = ${campaignId}`;
    const result = await runTick({ timeBudgetMs: 5_000 });

    expect(result.activatedScheduled).toBe(0);
    expect((await getCampaign(campaignId)).status).toBe("CANCELLED");
    expect(smtp.messages).toHaveLength(0);
  });
});

/* --------------------------------------------------- automatic activation */

describe("automatic activation of due campaigns", () => {
  it("leaves a not-yet-due campaign untouched", async () => {
    const campaignId = await draftCampaignWithRecipient();
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await scheduleCampaign(jsonRequest({ scheduledAt: future.toISOString() }), ctx(campaignId));

    const result = await runTick({ timeBudgetMs: 5_000 });

    expect(result.activatedScheduled).toBe(0);
    expect((await getCampaign(campaignId)).status).toBe("SCHEDULED");
    expect(smtp.messages).toHaveLength(0);
  });

  it("activates a due campaign, generates its queue, and sends through the normal rate-limited pipeline", async () => {
    const campaignId = await draftCampaignWithRecipient("due@example.test");
    await scheduleCampaign(jsonRequest({ scheduledAt: new Date(Date.now() + 60_000).toISOString() }), ctx(campaignId));
    // Fast-forward, as if the scheduled instant has now passed.
    await sql`UPDATE campaigns SET scheduled_at = now() - interval '1 minute' WHERE id = ${campaignId}`;

    const result = await runTick({ timeBudgetMs: 10_000 });

    expect(result.activatedScheduled).toBe(1);
    expect(smtp.messages.flatMap((m) => m.to)).toEqual(["due@example.test"]);
    expect((await getCampaign(campaignId)).status).toBe("COMPLETED");
  });

  it("recovers an overdue scheduled campaign on the next tick, as after a server restart", async () => {
    // Nothing in memory ever knew about this campaign's schedule — the row
    // itself, created directly (as if it already existed when the process
    // started), is the only state a fresh runTick() has to go on.
    const listId = await createList("Test list");
    await addContact(listId, "overdue@example.test", "Ann");
    const campaignId = await createCampaign({
      status: "SCHEDULED",
      scheduledAt: new Date(Date.now() - 5 * 60 * 1000),
      listIds: [listId],
    });

    const result = await runTick({ timeBudgetMs: 10_000 });

    expect(result.activatedScheduled).toBe(1);
    expect(smtp.messages.flatMap((m) => m.to)).toEqual(["overdue@example.test"]);
    expect((await getCampaign(campaignId)).status).toBe("COMPLETED");
  });

  it("never activates the same scheduled campaign twice, even under overlapping ticks", async () => {
    const listId = await createList("Test list");
    for (let i = 0; i < 5; i++) await addContact(listId, `u${i}@example.test`);
    await createCampaign({
      status: "SCHEDULED",
      scheduledAt: new Date(Date.now() - 1000),
      listIds: [listId],
    });

    const results = await Promise.all([
      runTick({ timeBudgetMs: 10_000 }),
      runTick({ timeBudgetMs: 10_000 }),
      runTick({ timeBudgetMs: 10_000 }),
    ]);

    const totalActivated = results.reduce((sum, r) => sum + r.activatedScheduled, 0);
    expect(totalActivated).toBe(1);
    expect(smtp.messages).toHaveLength(5);
    expect(new Set(smtp.messages.flatMap((m) => m.to)).size).toBe(5);
  });

  it("still obeys the hourly SMTP rate limit once a scheduled campaign is activated", async () => {
    process.env.SMTP_MAX_EMAILS_PER_HOUR = "10";
    const listId = await createList("Test list");
    for (let i = 0; i < 20; i++) await addContact(listId, `u${i}@example.test`);
    const campaignId = await createCampaign({
      status: "SCHEDULED",
      scheduledAt: new Date(Date.now() - 1000),
      listIds: [listId],
    });

    const result = await runTick({ timeBudgetMs: 10_000 });

    // 10/hour with the 0.95 safety factor allows 9 — same arithmetic as "send now".
    expect(result.sent).toBe(9);
    expect(result.rateLimited).toBe(true);
    expect((await getCampaign(campaignId)).status).toBe("SENDING");
  });

  it("closes out a due campaign with no recipients instead of leaving it stuck QUEUED forever", async () => {
    const campaignId = await createCampaign({ status: "SCHEDULED", scheduledAt: new Date(Date.now() - 1000) });

    const result = await runTick({ timeBudgetMs: 5_000 });

    expect(result.activatedScheduled).toBe(1);
    expect((await getCampaign(campaignId)).status).toBe("COMPLETED");
  });
});

/* --------------------------------------------------- send-now regression */

describe("POST /api/campaigns/:id/send (regression)", () => {
  it("still queues and sends immediately, unaffected by scheduling support", async () => {
    const campaignId = await draftCampaignWithRecipient("now@example.test");

    const response = await sendCampaign(jsonRequest(), ctx(campaignId));
    expect(response.status).toBe(200);
    expect((await getCampaign(campaignId)).status).toBe("QUEUED");

    const result = await runTick({ timeBudgetMs: 10_000 });
    expect(result.sent).toBe(1);
    expect(smtp.messages.flatMap((m) => m.to)).toEqual(["now@example.test"]);
  });
});
