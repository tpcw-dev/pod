CREATE SCHEMA "config";
--> statement-breakpoint
CREATE SCHEMA "ledger";
--> statement-breakpoint
CREATE TABLE "config"."activation" (
	"scope" text NOT NULL,
	"scope_ref" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"revision_id" text NOT NULL,
	"bundle_id" text,
	"activated_by" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"previous_revision_id" text,
	CONSTRAINT "activation_scope_scope_ref_kind_name_pk" PRIMARY KEY("scope","scope_ref","kind","name")
);
--> statement-breakpoint
CREATE TABLE "config"."revision" (
	"id" text PRIMARY KEY NOT NULL,
	"parent" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"schema_version" integer NOT NULL,
	"rev" integer NOT NULL,
	"scope" text NOT NULL,
	"scope_ref" text DEFAULT '' NOT NULL,
	"value" jsonb NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revision_kind_name_rev_unique" UNIQUE("kind","name","rev"),
	CONSTRAINT "revision_kind_check" CHECK ("config"."revision"."kind" in ('crew', 'process', 'policy', 'task')),
	CONSTRAINT "revision_scope_check" CHECK ("config"."revision"."scope" in ('global', 'project', 'host', 'run'))
);
--> statement-breakpoint
CREATE TABLE "config"."snapshot" (
	"run_id" text PRIMARY KEY NOT NULL,
	"crew_revision_id" text NOT NULL,
	"process_revision_id" text NOT NULL,
	"policy_revision_id" text NOT NULL,
	"effective_gate_map" jsonb NOT NULL,
	"hash" text NOT NULL,
	"pinned_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger"."dispatch" (
	"dispatch_id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"seat" text NOT NULL,
	"role" text NOT NULL,
	"requested_launch" jsonb NOT NULL,
	"effective_launch" jsonb,
	"model_attribution" text NOT NULL,
	"retry_of" text,
	"op_key" text NOT NULL,
	"settlement" text NOT NULL,
	"terminal_handle" text,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"activity" text NOT NULL,
	"execution_backend" text,
	"owner_host" text,
	"external_execution_id" text,
	"auth_ref" text,
	"output_ref" text,
	CONSTRAINT "dispatch_model_attribution_check" CHECK ("ledger"."dispatch"."model_attribution" in ('receipt', 'unknown')),
	CONSTRAINT "dispatch_activity_check" CHECK ("ledger"."dispatch"."activity" in ('running', 'waiting', 'settled'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"host" text NOT NULL,
	"run_id" text,
	"task_id" text,
	"dispatch_id" text,
	"op_key" text,
	"payload" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	CONSTRAINT "event_type_check" CHECK ("ledger"."event"."type" in ('start', 'delivery', 'receipt', 'activation', 'decision', 'self_decision', 'push', 'pr', 'deploy', 'release', 'takeover', 'escalate', 'cancel', 'stop', 'drain', 'hold', 'resume', 'ignored', 'unknown_launch', 'learning'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."operation" (
	"op_key" text PRIMARY KEY NOT NULL,
	"intent" text NOT NULL,
	"status" text NOT NULL,
	"owner_generation" integer NOT NULL,
	"result_ref" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operation_intent_check" CHECK ("ledger"."operation"."intent" in ('run_create', 'project', 'dispatch', 'retry', 'decide_seat', 'decide', 'config_apply', 'verdict', 'hqa', 'release', 'takeover', 'drain', 'learning')),
	CONSTRAINT "operation_status_check" CHECK ("ledger"."operation"."status" in ('pending', 'unknown', 'done', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."run" (
	"run_id" text PRIMARY KEY NOT NULL,
	"story_provider" text NOT NULL,
	"story_external_id" text NOT NULL,
	"host" text NOT NULL,
	"coordinator" text NOT NULL,
	"owner_generation" integer NOT NULL,
	"snapshot_hash" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_state_check" CHECK ("ledger"."run"."state" in ('active', 'hold', 'drained', 'done'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."story" (
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"size" text NOT NULL,
	"stage" text NOT NULL,
	"run_id" text,
	"dependencies" jsonb NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "story_provider_external_id_pk" PRIMARY KEY("provider","external_id"),
	CONSTRAINT "story_size_check" CHECK ("ledger"."story"."size" in ('xs', 's', 'm', 'l', 'xl'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."task" (
	"task_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"lineage_id" text NOT NULL,
	"role" text NOT NULL,
	"deps" jsonb NOT NULL,
	"spec_revision_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config"."activation" ADD CONSTRAINT "activation_revision_id_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "config"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config"."activation" ADD CONSTRAINT "activation_previous_revision_id_revision_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "config"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config"."revision" ADD CONSTRAINT "revision_parent_revision_id_fk" FOREIGN KEY ("parent") REFERENCES "config"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config"."snapshot" ADD CONSTRAINT "snapshot_crew_revision_id_revision_id_fk" FOREIGN KEY ("crew_revision_id") REFERENCES "config"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config"."snapshot" ADD CONSTRAINT "snapshot_process_revision_id_revision_id_fk" FOREIGN KEY ("process_revision_id") REFERENCES "config"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config"."snapshot" ADD CONSTRAINT "snapshot_policy_revision_id_revision_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "config"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."dispatch" ADD CONSTRAINT "dispatch_task_id_task_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ledger"."task"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."dispatch" ADD CONSTRAINT "dispatch_run_id_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "ledger"."run"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."dispatch" ADD CONSTRAINT "dispatch_op_key_operation_op_key_fk" FOREIGN KEY ("op_key") REFERENCES "ledger"."operation"("op_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."dispatch" ADD CONSTRAINT "dispatch_retry_of_dispatch_dispatch_id_fk" FOREIGN KEY ("retry_of") REFERENCES "ledger"."dispatch"("dispatch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."run" ADD CONSTRAINT "run_story_provider_story_external_id_story_provider_external_id_fk" FOREIGN KEY ("story_provider","story_external_id") REFERENCES "ledger"."story"("provider","external_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."task" ADD CONSTRAINT "task_run_id_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "ledger"."run"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."task" ADD CONSTRAINT "task_spec_revision_id_revision_id_fk" FOREIGN KEY ("spec_revision_id") REFERENCES "config"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_run_ts" ON "ledger"."event" USING btree ("run_id","ts");