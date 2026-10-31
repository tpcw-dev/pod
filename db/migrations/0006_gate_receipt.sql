CREATE TABLE "ledger"."gate_receipt" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gate_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"scope" text NOT NULL,
	"spec_revision_id" text NOT NULL,
	"candidate_sha" text NOT NULL,
	"deployed_revision" text,
	"keeper" text NOT NULL,
	"outcome" text NOT NULL,
	"source" jsonb NOT NULL,
	"sync_state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gate_receipt_outcome_check" CHECK ("ledger"."gate_receipt"."outcome" in ('PASS', 'FAIL')),
	CONSTRAINT "gate_receipt_sync_state_check" CHECK ("ledger"."gate_receipt"."sync_state" in ('pending', 'synced', 'voided'))
);
--> statement-breakpoint
ALTER TABLE "ledger"."gate_receipt" ADD CONSTRAINT "gate_receipt_run_id_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "ledger"."run"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."gate_receipt" ADD CONSTRAINT "gate_receipt_task_id_task_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ledger"."task"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."gate_receipt" ADD CONSTRAINT "gate_receipt_spec_revision_id_revision_id_fk" FOREIGN KEY ("spec_revision_id") REFERENCES "config"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gate_receipt_run_idx" ON "ledger"."gate_receipt" USING btree ("run_id");--> statement-breakpoint
CREATE FUNCTION "ledger"."gate_receipt_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'DELETE on ledger.gate_receipt is not allowed';
	END IF;
	IF (NEW.id, NEW.gate_id, NEW.run_id, NEW.task_id, NEW.scope, NEW.spec_revision_id, NEW.candidate_sha, NEW.deployed_revision, NEW.keeper, NEW.outcome, NEW.source, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.gate_id, OLD.run_id, OLD.task_id, OLD.scope, OLD.spec_revision_id, OLD.candidate_sha, OLD.deployed_revision, OLD.keeper, OLD.outcome, OLD.source, OLD.created_at) THEN
		RAISE EXCEPTION 'UPDATE on ledger.gate_receipt may change only sync_state';
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "gate_receipt_guard" BEFORE UPDATE OR DELETE ON "ledger"."gate_receipt" FOR EACH ROW EXECUTE FUNCTION "ledger"."gate_receipt_guard"();
