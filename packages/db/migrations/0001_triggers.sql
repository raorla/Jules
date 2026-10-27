-- Organisation par défaut : l'instance, tant que le multi-organisation n'est pas activé (ADR 0013).
INSERT INTO "orgs" ("id", "slug", "name")
VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'default')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Journal d'audit append-only : toute modification, suppression ou troncature est refusée.
-- La chaîne de hash (packages/audit) détecte en plus ce qui contournerait ce trigger.
CREATE FUNCTION jules_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log est append-only (%)', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION jules_audit_log_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON "audit_log"
FOR EACH STATEMENT EXECUTE FUNCTION jules_audit_log_append_only();
--> statement-breakpoint

-- Réveil du worker (LISTEN/NOTIFY) : nouvel événement reçu, nouvel effet à produire.
CREATE FUNCTION jules_notify_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(TG_ARGV[0], NEW.id::text);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER events_notify
AFTER INSERT ON "events"
FOR EACH ROW EXECUTE FUNCTION jules_notify_insert('jules_events');
--> statement-breakpoint
CREATE TRIGGER outbox_notify
AFTER INSERT ON "outbox"
FOR EACH ROW EXECUTE FUNCTION jules_notify_insert('jules_outbox');
