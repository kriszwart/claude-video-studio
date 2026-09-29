CREATE TABLE "generation_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text,
	"job_id" text,
	"operation_id" text NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"capability" text NOT NULL,
	"request_id" text,
	"state" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"asset_id" text,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "generation_operation" ON "generation_requests" USING btree ("workspace_id","operation_id");--> statement-breakpoint
CREATE INDEX "generation_request" ON "generation_requests" USING btree ("provider","request_id");