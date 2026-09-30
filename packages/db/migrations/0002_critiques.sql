CREATE TABLE "critiques" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"job_id" text NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "critiques_project_idx" ON "critiques" USING btree ("project_id","created_at");