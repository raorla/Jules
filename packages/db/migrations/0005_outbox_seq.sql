DROP INDEX "outbox_serial_key_idx";--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_serial_key_idx" ON "outbox" USING btree ("serial_key","seq");