CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"role" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"token_hash" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"container_id" text,
	"budget_usd" numeric(12, 4) NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"model_requests" integer DEFAULT 0 NOT NULL,
	"provider_errors" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"target_id" text,
	"reason" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"input" jsonb NOT NULL,
	"effect" text NOT NULL,
	"rule_id" text NOT NULL,
	"reason" text NOT NULL,
	"output" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "base_sha" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "head_sha" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "budget_usd" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "resume_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stops" ADD CONSTRAINT "stops_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_task_kind_version_idx" ON "artifacts" USING btree ("task_id","kind","version");--> statement-breakpoint
CREATE INDEX "runs_task_idx" ON "runs" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "stops_active_idx" ON "stops" USING btree ("org_id","scope") WHERE "stops"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "tool_calls_run_idx" ON "tool_calls" USING btree ("run_id","capability");