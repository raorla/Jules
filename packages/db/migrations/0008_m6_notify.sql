-- Temps réel (SSE) : l'api écoute les changements de tâches ; le worker écoute les commandes à appliquer.
CREATE TRIGGER tasks_notify
AFTER INSERT OR UPDATE ON "tasks"
FOR EACH ROW EXECUTE FUNCTION jules_notify_insert('jules_tasks');
--> statement-breakpoint
CREATE FUNCTION jules_notify_pending_command() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision = 'pending' THEN
    PERFORM pg_notify('jules_commands', NEW.id::text);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commands_notify
AFTER INSERT ON "commands"
FOR EACH ROW EXECUTE FUNCTION jules_notify_pending_command();
