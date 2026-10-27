CREATE TABLE "change_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid,
	"server_id" uuid NOT NULL,
	"run_id" uuid,
	"deployment_id" uuid,
	"plan" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"plan_hash" text NOT NULL,
	"environment" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_source" text,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"ref" text NOT NULL,
	"previous_ref" text,
	"status" text NOT NULL,
	"playbook" text NOT NULL,
	"plan_id" uuid,
	"promoted_from" uuid,
	"github_deployment_id" bigint,
	"pull_requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"merged_at" timestamp with time zone,
	"reason" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"phase" text NOT NULL,
	"label" text NOT NULL,
	"playbook" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"exit_code" integer,
	"output" text,
	"duration_ms" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "server_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"run_id" uuid,
	"plan_id" uuid,
	"source" text NOT NULL,
	"command" text NOT NULL,
	"command_class" text NOT NULL,
	"decision" text NOT NULL,
	"rule_id" text NOT NULL,
	"exit_code" integer,
	"timed_out" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"output" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text NOT NULL,
	"environment" text NOT NULL,
	"level" text DEFAULT 'D0' NOT NULL,
	"repo_id" uuid,
	"host_key_status" text DEFAULT 'pending' NOT NULL,
	"host_key_fingerprint" text,
	"offered_fingerprint" text,
	"offered_algorithm" text,
	"frozen" boolean DEFAULT false NOT NULL,
	"lock_plan_id" uuid,
	"lock_until" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "four_eyes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "github_production_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "change_plans" ADD CONSTRAINT "change_plans_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_plans" ADD CONSTRAINT "change_plans_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_plans" ADD CONSTRAINT "change_plans_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_plans" ADD CONSTRAINT "change_plans_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_plans" ADD CONSTRAINT "change_plans_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_plans" ADD CONSTRAINT "change_plans_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_plan_id_change_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."change_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_commands" ADD CONSTRAINT "server_commands_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_commands" ADD CONSTRAINT "server_commands_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_commands" ADD CONSTRAINT "server_commands_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_commands" ADD CONSTRAINT "server_commands_plan_id_change_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."change_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_plans_server_status_idx" ON "change_plans" USING btree ("server_id","status");--> statement-breakpoint
CREATE INDEX "change_plans_task_idx" ON "change_plans" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "deployments_repo_env_idx" ON "deployments" USING btree ("repo_id","environment","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_steps_plan_position_idx" ON "plan_steps" USING btree ("plan_id","position");--> statement-breakpoint
CREATE INDEX "server_commands_server_idx" ON "server_commands" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_org_name_idx" ON "servers" USING btree ("org_id","name");--> statement-breakpoint
-- Temps réel : un plan à approuver ou un déploiement qui avance rafraîchit l'interface (SSE).
CREATE TRIGGER change_plans_notify
AFTER INSERT OR UPDATE ON "change_plans"
FOR EACH ROW EXECUTE FUNCTION jules_notify_insert('jules_tasks');
--> statement-breakpoint
CREATE TRIGGER deployments_notify
AFTER INSERT OR UPDATE ON "deployments"
FOR EACH ROW EXECUTE FUNCTION jules_notify_insert('jules_tasks');
