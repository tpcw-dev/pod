CREATE TABLE "ledger"."outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"op_key" text NOT NULL,
	"target" text NOT NULL,
	"payload" jsonb NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"acked_at" timestamp with time zone,
	"readback" jsonb,
	CONSTRAINT "outbox_target_check" CHECK ("ledger"."outbox"."target" in ('tracker'))
);
--> statement-breakpoint
ALTER TABLE "ledger"."story" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "ledger"."story" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "ledger"."story" ADD COLUMN "kickoff_line" text;--> statement-breakpoint
ALTER TABLE "ledger"."outbox" ADD CONSTRAINT "outbox_op_key_operation_op_key_fk" FOREIGN KEY ("op_key") REFERENCES "ledger"."operation"("op_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "ledger"."outbox" USING btree ("id") WHERE "ledger"."outbox"."acked_at" is null;