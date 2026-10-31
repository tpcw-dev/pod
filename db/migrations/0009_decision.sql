CREATE TABLE "ledger"."decision" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"category" text NOT NULL,
	"effect" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"manifest_id" text NOT NULL,
	"state" text NOT NULL,
	"outcome" jsonb,
	"reason" text,
	"binding" text NOT NULL,
	"budget" jsonb NOT NULL,
	"spent" jsonb NOT NULL,
	"supersedes_decision_id" text,
	"adoption" text DEFAULT 'pending' NOT NULL,
	"adoption_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "decision_effect_check" CHECK ("ledger"."decision"."effect" in ('accept_plan', 'change_spec')),
	CONSTRAINT "decision_state_check" CHECK ("ledger"."decision"."state" in ('requested', 'round:1', 'round:2', 'round:3', 'agreed', 'needs_human', 'cancelled')),
	CONSTRAINT "decision_reason_check" CHECK ("ledger"."decision"."reason" in ('policy-required', 'disagreement', 'context-missing', 'runtime-failure', 'agreed', 'cancelled', 'denied')),
	CONSTRAINT "decision_binding_check" CHECK ("ledger"."decision"."binding" = 'run'),
	CONSTRAINT "decision_adoption_check" CHECK ("ledger"."decision"."adoption" in ('pending', 'adopted', 'reworked', 'reversed'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."decision_round" (
	"decision_id" text NOT NULL,
	"round" integer NOT NULL,
	"decider_dispatch_id" text NOT NULL,
	"auditor_dispatch_id" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"audit" jsonb NOT NULL,
	"stance" text NOT NULL,
	"manifest_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	CONSTRAINT "decision_round_decision_id_round_pk" PRIMARY KEY("decision_id","round"),
	CONSTRAINT "decision_round_round_check" CHECK ("ledger"."decision_round"."round" between 1 and 3),
	CONSTRAINT "decision_round_stance_check" CHECK ("ledger"."decision_round"."stance" in ('agree', 'disagree', 'escalate'))
);
--> statement-breakpoint
ALTER TABLE "config"."revision" DROP CONSTRAINT "revision_kind_check";--> statement-breakpoint
ALTER TABLE "ledger"."dispatch" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger"."dispatch" ADD COLUMN "decision_id" text;--> statement-breakpoint
ALTER TABLE "ledger"."decision" ADD CONSTRAINT "decision_run_id_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "ledger"."run"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."decision" ADD CONSTRAINT "decision_task_id_task_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ledger"."task"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."decision" ADD CONSTRAINT "decision_manifest_id_evidence_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "ledger"."evidence_manifest"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."decision" ADD CONSTRAINT "decision_supersedes_decision_id_decision_id_fk" FOREIGN KEY ("supersedes_decision_id") REFERENCES "ledger"."decision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."decision_round" ADD CONSTRAINT "decision_round_decision_id_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "ledger"."decision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."decision_round" ADD CONSTRAINT "decision_round_decider_dispatch_id_dispatch_dispatch_id_fk" FOREIGN KEY ("decider_dispatch_id") REFERENCES "ledger"."dispatch"("dispatch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."decision_round" ADD CONSTRAINT "decision_round_auditor_dispatch_id_dispatch_dispatch_id_fk" FOREIGN KEY ("auditor_dispatch_id") REFERENCES "ledger"."dispatch"("dispatch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."decision_round" ADD CONSTRAINT "decision_round_manifest_id_evidence_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "ledger"."evidence_manifest"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_open_task_idx" ON "ledger"."decision" USING btree ("task_id") WHERE "ledger"."decision"."state" in ('requested', 'round:1', 'round:2', 'round:3');--> statement-breakpoint
ALTER TABLE "ledger"."dispatch" ADD CONSTRAINT "dispatch_decision_id_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "ledger"."decision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config"."revision" ADD CONSTRAINT "revision_kind_check" CHECK ("config"."revision"."kind" in ('crew', 'process', 'policy', 'task', 'decision'));--> statement-breakpoint
ALTER TABLE "ledger"."dispatch" ADD CONSTRAINT "dispatch_owner_check" CHECK (("ledger"."dispatch"."task_id" is null) = ("ledger"."dispatch"."decision_id" is not null));