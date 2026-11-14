-- Hand-edited after drizzle-kit generate: usage_record gets the append-only trigger.
CREATE TABLE "ledger"."usage_record" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"runtime" text NOT NULL,
	"session_id" text NOT NULL,
	"model" text,
	"input" bigint,
	"cached_input" bigint,
	"cache_write" bigint,
	"output" bigint,
	"reasoning" bigint,
	"calls" integer,
	"first_at" timestamp with time zone NOT NULL,
	"through" timestamp with time zone NOT NULL,
	"dispatch_id" text,
	"run_id" text,
	"attribution" text NOT NULL,
	"coverage" text NOT NULL,
	"op_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "usage_record_span_unique" UNIQUE NULLS NOT DISTINCT("runtime","session_id","model","through"),
	CONSTRAINT "usage_record_attribution_check" CHECK ("ledger"."usage_record"."attribution" in ('locator', 'path', 'unattributed') and ("ledger"."usage_record"."attribution" = 'locator') = ("ledger"."usage_record"."dispatch_id" is not null) and ("ledger"."usage_record"."attribution" = 'path') = ("ledger"."usage_record"."run_id" is not null)),
	CONSTRAINT "usage_record_coverage_check" CHECK ("ledger"."usage_record"."coverage" in ('measured', 'partial'))
);
--> statement-breakpoint
ALTER TABLE "ledger"."operation" DROP CONSTRAINT "operation_intent_check";--> statement-breakpoint
ALTER TABLE "ledger"."usage_record" ADD CONSTRAINT "usage_record_dispatch_id_dispatch_dispatch_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "ledger"."dispatch"("dispatch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."usage_record" ADD CONSTRAINT "usage_record_run_id_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "ledger"."run"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."usage_record" ADD CONSTRAINT "usage_record_op_key_operation_op_key_fk" FOREIGN KEY ("op_key") REFERENCES "ledger"."operation"("op_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_record_session_idx" ON "ledger"."usage_record" USING btree ("runtime","session_id","through");--> statement-breakpoint
ALTER TABLE "ledger"."operation" ADD CONSTRAINT "operation_intent_check" CHECK ("ledger"."operation"."intent" in ('run_create', 'project', 'dispatch', 'retry', 'decide_seat', 'decide', 'config_apply', 'config_activate', 'verdict', 'hqa', 'release', 'takeover', 'drain', 'learning', 'close', 'retro', 'digest', 'ruling', 'usage'));--> statement-breakpoint
CREATE TRIGGER "usage_record_append_only" BEFORE UPDATE OR DELETE ON "ledger"."usage_record" FOR EACH ROW EXECUTE FUNCTION "ledger"."refuse_change"();
