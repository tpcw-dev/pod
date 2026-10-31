CREATE TABLE "ledger"."learning" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_story" text NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"text" text NOT NULL,
	"adoption" text NOT NULL,
	"area" text NOT NULL,
	"project_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "learning_adoption_check" CHECK ("ledger"."learning"."adoption" in ('new', 'adopted', 'rejected')),
	CONSTRAINT "learning_area_check" CHECK ("ledger"."learning"."area" in ('product', 'design', 'impl', 'process'))
);
--> statement-breakpoint
CREATE FUNCTION "ledger"."refuse_learning_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'DELETE on %.% is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME;
	END IF;
	IF NEW.source_story IS DISTINCT FROM OLD.source_story
		OR NEW.evidence_refs IS DISTINCT FROM OLD.evidence_refs
		OR NEW.text IS DISTINCT FROM OLD.text
		OR NEW.area IS DISTINCT FROM OLD.area
		OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
		RAISE EXCEPTION 'UPDATE on %.% is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME;
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "learning_immutable" BEFORE UPDATE OR DELETE ON "ledger"."learning" FOR EACH ROW EXECUTE FUNCTION "ledger"."refuse_learning_change"();
