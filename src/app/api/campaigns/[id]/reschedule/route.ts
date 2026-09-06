import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { conflict, futureDate, readJson, withAuthMutation } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Changes the send time of a campaign that has not started yet.
 *
 * Restricted to SCHEDULED via a conditional UPDATE: once the worker has
 * promoted the campaign to QUEUED (or beyond), its processing has already
 * begun and the start time can no longer be moved.
 */
export async function POST(request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const body = await readJson<{ scheduledAt?: string }>(request);
    const scheduledAt = futureDate(body.scheduledAt, "Scheduled time");

    const rows = await db
      .update(campaigns)
      .set({ scheduledAt, updatedAt: new Date() })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, "SCHEDULED")))
      .returning();

    if (rows.length === 0) conflict("Only a scheduled campaign that hasn't started can be rescheduled");
    return NextResponse.json({ ok: true, campaign: rows[0] });
  });
}
