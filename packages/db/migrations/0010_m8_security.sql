CREATE TABLE "audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"target_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"commit_sha" text,
	"scanners" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"target_id" text NOT NULL,
	"key" text NOT NULL,
	"category" text NOT NULL,
	"component" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"scanner" text NOT NULL,
	"evidence" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"analysis" text,
	"false_positive_suggested" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_audit_id" uuid,
	"resolved_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"accepted_until" timestamp with time zone,
	"decided_by" uuid,
	"decision_note" text,
	"remediation_task_id" uuid,
	"github_issue_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "security_level" text DEFAULT 'S0' NOT NULL;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_last_audit_id_audits_id_fk" FOREIGN KEY ("last_audit_id") REFERENCES "public"."audits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_remediation_task_id_tasks_id_fk" FOREIGN KEY ("remediation_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audits_target_idx" ON "audits" USING btree ("scope","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_org_key_idx" ON "findings" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "findings_target_idx" ON "findings" USING btree ("scope","target_id","status");--> statement-breakpoint
-- Temps réel : un finding nouveau ou décidé rafraîchit la page Sécurité (SSE).
CREATE TRIGGER findings_notify
AFTER INSERT OR UPDATE ON "findings"
FOR EACH ROW EXECUTE FUNCTION jules_notify_insert('jules_tasks');
