ALTER TYPE "public"."campaign_status" ADD VALUE 'SCHEDULED' BEFORE 'QUEUED';--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "campaigns_status_scheduled_at_idx" ON "campaigns" USING btree ("status","scheduled_at");