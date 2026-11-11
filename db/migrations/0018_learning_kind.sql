-- Hand-edited after drizzle-kit generate: kind and adoption_at are added with a default for the backfill and the default is then dropped, each existing learning gets one backfilled occurrence, refuse_learning_change also guards kind and expected, and learning_occurrence gets the append-only trigger.
CREATE TABLE "ledger"."learning_occurrence" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"learning_id" bigint NOT NULL,
	"story" text NOT NULL,
	"occurred_on" date NOT NULL,
	"reporter" text NOT NULL,
	"wording" text NOT NULL,
	"evidence_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "learning_occurrence_reporter_check" CHECK ("ledger"."learning_occurrence"."reporter" in ('lead', 'retro', 'healthcheck'))
);
--> statement-breakpoint
ALTER TABLE "ledger"."learning" DROP CONSTRAINT "learning_adoption_check";--> statement-breakpoint
ALTER TABLE "ledger"."learning" ADD COLUMN "kind" text NOT NULL DEFAULT 'lead';--> statement-breakpoint
ALTER TABLE "ledger"."learning" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ledger"."learning" ADD COLUMN "expected" text;--> statement-breakpoint
ALTER TABLE "ledger"."learning" ADD COLUMN "theme" text;--> statement-breakpoint
ALTER TABLE "ledger"."learning" ADD COLUMN "action_story" text;--> statement-breakpoint
ALTER TABLE "ledger"."learning" ADD COLUMN "adoption_at" timestamp with time zone;--> statement-breakpoint
UPDATE "ledger"."learning" SET "adoption_at" = "created_at";--> statement-breakpoint
ALTER TABLE "ledger"."learning" ALTER COLUMN "adoption_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger"."learning_occurrence" ADD CONSTRAINT "learning_occurrence_learning_id_learning_id_fk" FOREIGN KEY ("learning_id") REFERENCES "ledger"."learning"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "learning_occurrence_evidence_idx" ON "ledger"."learning_occurrence" USING btree ("learning_id","evidence_id");--> statement-breakpoint
ALTER TABLE "ledger"."learning" ADD CONSTRAINT "learning_adoption_check" CHECK ("ledger"."learning"."adoption" in ('new', 'proposed', 'adopted', 'rejected', 'done'));--> statement-breakpoint
INSERT INTO "ledger"."learning_occurrence" ("learning_id", "story", "occurred_on", "reporter", "wording", "evidence_id", "created_at")
SELECT l."id", l."source_story", l."created_at"::date, 'lead', l."text",
	CASE
		WHEN jsonb_typeof(l."evidence_refs") = 'array'
			AND jsonb_array_length(l."evidence_refs") > 0
			AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l."evidence_refs") x WHERE jsonb_typeof(x) <> 'string')
		THEN array_to_string(array(SELECT DISTINCT e COLLATE "C" FROM jsonb_array_elements_text(l."evidence_refs") e ORDER BY 1), ' ')
		ELSE 'learning:' || l."id"
	END,
	l."created_at"
FROM "ledger"."learning" l;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ledger"."refuse_learning_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'DELETE on %.% is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME;
	END IF;
	IF NEW.source_story IS DISTINCT FROM OLD.source_story
		OR NEW.evidence_refs IS DISTINCT FROM OLD.evidence_refs
		OR NEW.text IS DISTINCT FROM OLD.text
		OR NEW.area IS DISTINCT FROM OLD.area
		OR NEW.project_id IS DISTINCT FROM OLD.project_id
		OR NEW.kind IS DISTINCT FROM OLD.kind
		OR NEW.expected IS DISTINCT FROM OLD.expected THEN
		RAISE EXCEPTION 'UPDATE on %.% is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME;
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "learning_occurrence_append_only" BEFORE UPDATE OR DELETE ON "ledger"."learning_occurrence" FOR EACH ROW EXECUTE FUNCTION "ledger"."refuse_change"();
