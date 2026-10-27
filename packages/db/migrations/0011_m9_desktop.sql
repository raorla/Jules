CREATE TABLE "desktop_logins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"challenge" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"client_state" text NOT NULL,
	"code_hash" text,
	"user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_logins_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "desktop_logins" ADD CONSTRAINT "desktop_logins_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_logins" ADD CONSTRAINT "desktop_logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;