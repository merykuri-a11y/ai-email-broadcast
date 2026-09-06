import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { badRequest, conflict, futureDate, notFound, readJson, withAuthMutation } from "@/lib/api";
import { getSmtpConfig } from "@/lib/settings";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Marks a DRAFT campaign to start automatically later. Nothing is queued or
 * sent here: the worker tick promotes it (SCHEDULED -> QUEUED) once
 * `scheduledAt` passes, then hands it to the exact same pipeline "Send now"
 * uses — see `activateDueCampaigns` in lib/worker.ts.
 *
 * The DRAFT -> SCHEDULED transition is a conditional UPDATE, same guard the
 * send endpoint uses against a double-clicked button or a retried request.
 */
export async function POST(request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const body = await readJson<{ scheduledAt?: string }>(request);
    const scheduledAt = futureDate(body.scheduledAt, "Scheduled time");

    const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    const campaign = rows[0];
    if (!campaign) notFound("Campaign not found");
    if (campaign.status !== "DRAFT") conflict(`This campaign is already ${campaign.status}`);
    if (!campaign.subject.trim()) badRequest("Give the campaign a subject first");
    if (!campaign.compiledHtml.trim()) badRequest("The email body is empty");

    const config = await getSmtpConfig();
    if (!config) badRequest("Configure SMTP in Settings before scheduling");

    const claimed = await db
      .update(campaigns)
      .set({ status: "SCHEDULED", scheduledAt, updatedAt: new Date() })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, "DRAFT")))
      .returning();

    if (claimed.length === 0) conflict("This campaign was already scheduled by another request");

    return NextResponse.json({ ok: true, campaign: claimed[0] });
  });
}
