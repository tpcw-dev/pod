CREATE FUNCTION "config"."refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "revision_append_only" BEFORE UPDATE OR DELETE ON "config"."revision" FOR EACH ROW EXECUTE FUNCTION "config"."refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "event_append_only" BEFORE UPDATE OR DELETE ON "ledger"."event" FOR EACH ROW EXECUTE FUNCTION "ledger"."refuse_change"();
