-- Hand-edited after drizzle-kit generate: dispatch_activity gets the append-only trigger.
CREATE TABLE "ledger"."dispatch_activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dispatch_id" text NOT NULL,
	"activity" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "dispatch_activity_activity_check" CHECK ("ledger"."dispatch_activity"."activity" in ('running', 'waiting', 'settled'))
);
--> statement-breakpoint
ALTER TABLE "config"."revision" DROP CONSTRAINT "revision_kind_check";--> statement-breakpoint
ALTER TABLE "config"."snapshot" ADD COLUMN "rate_revision_id" text;--> statement-breakpoint
ALTER TABLE "ledger"."dispatch_activity" ADD CONSTRAINT "dispatch_activity_dispatch_id_dispatch_dispatch_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "ledger"."dispatch"("dispatch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispatch_activity_dispatch_idx" ON "ledger"."dispatch_activity" USING btree ("dispatch_id","at","id");--> statement-breakpoint
ALTER TABLE "config"."snapshot" ADD CONSTRAINT "snapshot_rate_revision_id_revision_id_fk" FOREIGN KEY ("rate_revision_id") REFERENCES "config"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config"."revision" ADD CONSTRAINT "revision_kind_check" CHECK ("config"."revision"."kind" in ('crew', 'process', 'policy', 'task', 'decision', 'host', 'project', 'rate'));--> statement-breakpoint
CREATE TRIGGER "dispatch_activity_append_only" BEFORE UPDATE OR DELETE ON "ledger"."dispatch_activity" FOR EACH ROW EXECUTE FUNCTION "ledger"."refuse_change"();