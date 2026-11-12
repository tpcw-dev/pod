-- Hand-edited after drizzle-kit generate: refuse_digest_proposal_change keeps a proposal's content fixed, lets shown_on and ruling be set once, and refuses DELETE.
CREATE TABLE "ledger"."digest_proposal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"proposal_key" text NOT NULL,
	"scope" text NOT NULL,
	"posted_on" date NOT NULL,
	"theme" text NOT NULL,
	"text" text NOT NULL,
	"learning_ids" jsonb NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"shown_on" date,
	"ruling" text,
	"ruled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "digest_proposal_ruling_check" CHECK ("ledger"."digest_proposal"."ruling" in ('accept', 'reject')),
	CONSTRAINT "digest_proposal_ruled_check" CHECK (("ledger"."digest_proposal"."ruling" is null) = ("ledger"."digest_proposal"."ruled_at" is null) and ("ledger"."digest_proposal"."ruling" is null or "ledger"."digest_proposal"."shown_on" is not null))
);
--> statement-breakpoint
ALTER TABLE "ledger"."event" DROP CONSTRAINT "event_type_check";--> statement-breakpoint
ALTER TABLE "ledger"."operation" DROP CONSTRAINT "operation_intent_check";--> statement-breakpoint
CREATE UNIQUE INDEX "digest_proposal_open_key_idx" ON "ledger"."digest_proposal" USING btree ("proposal_key") WHERE "ledger"."digest_proposal"."ruling" is null;--> statement-breakpoint
CREATE INDEX "digest_proposal_scope_idx" ON "ledger"."digest_proposal" USING btree ("scope","posted_on");--> statement-breakpoint
ALTER TABLE "ledger"."event" ADD CONSTRAINT "event_type_check" CHECK ("ledger"."event"."type" in ('start', 'delivery', 'receipt', 'activation', 'activation_requested', 'decision', 'self_decision', 'push', 'pr', 'deploy', 'release', 'takeover', 'escalate', 'cancel', 'stop', 'drain', 'hold', 'resume', 'retry', 'ignored', 'unknown_launch', 'learning', 'outcome', 'close', 'retro', 'digest', 'ruling'));--> statement-breakpoint
ALTER TABLE "ledger"."operation" ADD CONSTRAINT "operation_intent_check" CHECK ("ledger"."operation"."intent" in ('run_create', 'project', 'dispatch', 'retry', 'decide_seat', 'decide', 'config_apply', 'config_activate', 'verdict', 'hqa', 'release', 'takeover', 'drain', 'learning', 'close', 'retro', 'digest', 'ruling'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ledger"."refuse_digest_proposal_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'DELETE on %.% is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME;
	END IF;
	IF NEW.proposal_key IS DISTINCT FROM OLD.proposal_key
		OR NEW.scope IS DISTINCT FROM OLD.scope
		OR NEW.posted_on IS DISTINCT FROM OLD.posted_on
		OR NEW.theme IS DISTINCT FROM OLD.theme
		OR NEW.text IS DISTINCT FROM OLD.text
		OR NEW.learning_ids IS DISTINCT FROM OLD.learning_ids
		OR NEW.evidence_refs IS DISTINCT FROM OLD.evidence_refs
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR (OLD.shown_on IS NOT NULL AND NEW.shown_on IS DISTINCT FROM OLD.shown_on)
		OR (OLD.ruling IS NOT NULL AND (NEW.ruling IS DISTINCT FROM OLD.ruling OR NEW.ruled_at IS DISTINCT FROM OLD.ruled_at)) THEN
		RAISE EXCEPTION 'UPDATE on %.% is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME;
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "digest_proposal_guard" BEFORE UPDATE OR DELETE ON "ledger"."digest_proposal" FOR EACH ROW EXECUTE FUNCTION "ledger"."refuse_digest_proposal_change"();
