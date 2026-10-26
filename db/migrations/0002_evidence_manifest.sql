CREATE TABLE "ledger"."evidence_manifest" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"decision_id" text,
	"parent_id" text,
	"references" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger"."dispatch" ADD COLUMN "manifest_id" text;--> statement-breakpoint
ALTER TABLE "ledger"."evidence_manifest" ADD CONSTRAINT "evidence_manifest_run_id_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "ledger"."run"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."evidence_manifest" ADD CONSTRAINT "evidence_manifest_task_id_task_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ledger"."task"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."evidence_manifest" ADD CONSTRAINT "evidence_manifest_parent_id_evidence_manifest_id_fk" FOREIGN KEY ("parent_id") REFERENCES "ledger"."evidence_manifest"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."dispatch" ADD CONSTRAINT "dispatch_manifest_id_evidence_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "ledger"."evidence_manifest"("id") ON DELETE no action ON UPDATE no action;