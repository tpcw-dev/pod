CREATE TABLE "ledger"."usage_observation" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"seat" text,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"value" numeric,
	"coverage" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source" jsonb NOT NULL,
	CONSTRAINT "usage_observation_coverage_check" CHECK ("ledger"."usage_observation"."coverage" in ('measured', 'partial', 'no_source'))
);
--> statement-breakpoint
CREATE INDEX "usage_observation_provider_idx" ON "ledger"."usage_observation" USING btree ("provider","observed_at");--> statement-breakpoint
CREATE TRIGGER "usage_observation_append_only" BEFORE UPDATE OR DELETE ON "ledger"."usage_observation" FOR EACH ROW EXECUTE FUNCTION "ledger"."refuse_change"();
