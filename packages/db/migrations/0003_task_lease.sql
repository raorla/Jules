ALTER TABLE "tasks" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;