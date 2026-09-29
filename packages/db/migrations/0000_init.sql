CREATE TABLE "analytics_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" text,
	"mime" text,
	"bytes" bigint,
	"original_name" text DEFAULT '' NOT NULL,
	"media" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"derived" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rights_acknowledged" boolean DEFAULT false NOT NULL,
	"generated" boolean DEFAULT false NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_kits" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"reference_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"style_notes" text DEFAULT '' NOT NULL,
	"accepted_variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cleanup_tasks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"run_after" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"id" text PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"asset_id" text,
	"source_name" text NOT NULL,
	"content_hash" text,
	"bytes" bigint,
	"duration_sec" real,
	"status" text DEFAULT 'pending' NOT NULL,
	"transcript_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"limits" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_profile_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"change_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"video_asset_id" text NOT NULL,
	"thumbnail_asset_id" text,
	"captions_srt_asset_id" text,
	"captions_vtt_asset_id" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"duration_sec" real NOT NULL,
	"bundle_hash" text NOT NULL,
	"verification" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exports_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "graphics_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"backend" text NOT NULL,
	"asset_id" text NOT NULL,
	"meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"project_id" text,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text,
	"revision_id" text,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"progress" real,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"idempotency_key" text,
	"provider_request_id" text,
	"parent_job_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"seq" integer NOT NULL,
	"parent_revision_id" text,
	"schema_version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"document_hash" text NOT NULL,
	"author" text NOT NULL,
	"action" text NOT NULL,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"history" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"family" text NOT NULL,
	"current_revision_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL,
	"variant_group_id" text,
	"variant_label" text,
	"budget" jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"encrypted_secret" text,
	"key_hint" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_check" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_key" text NOT NULL,
	"request_id" text,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"job_id" text NOT NULL,
	"verdict" text NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"provider" text NOT NULL,
	"language" text,
	"granularity" text NOT NULL,
	"segments" jsonb NOT NULL,
	"corrected" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"preview_asset_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"family" text NOT NULL,
	"preset" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"collection_id" text,
	"transcript_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"start_sec" real NOT NULL,
	"end_sec" real NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text,
	"job_id" text,
	"operation_id" text NOT NULL,
	"provider" text NOT NULL,
	"capability" text NOT NULL,
	"status" text NOT NULL,
	"estimated_micros" bigint,
	"reserved_micros" bigint,
	"actual_micros" bigint,
	"currency" text DEFAULT 'USD' NOT NULL,
	"price_timestamp" text,
	"price_basis" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "worker_capabilities" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"capabilities" jsonb NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_profile_versions" ADD CONSTRAINT "creative_profile_versions_profile_id_creative_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."creative_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_profiles" ADD CONSTRAINT "creative_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_ws" ON "assets" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_ws_hash" ON "assets" USING btree ("workspace_id","content_hash") WHERE "assets"."content_hash" is not null and "assets"."status" = 'ready' and "assets"."kind" <> 'render';--> statement-breakpoint
CREATE UNIQUE INDEX "collection_items_hash" ON "collection_items" USING btree ("collection_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_versions_pv" ON "creative_profile_versions" USING btree ("profile_id","version");--> statement-breakpoint
CREATE INDEX "exports_project" ON "exports" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "job_events_project" ON "job_events" USING btree ("project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idem" ON "jobs" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_project" ON "jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "jobs_status" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_ws_user" ON "memberships" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "outbox_unpublished" ON "outbox" USING btree ("published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "revisions_project_seq" ON "project_revisions" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "projects_ws_status" ON "projects" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_ws" ON "provider_configs" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_events_key" ON "provider_events" USING btree ("provider","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_tpl_ver" ON "template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE INDEX "templates_ws" ON "templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "segments_collection" ON "transcript_segments" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "segments_fts" ON "transcript_segments" USING gin (to_tsvector('english', "text"));--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_operation" ON "usage_ledger" USING btree ("workspace_id","operation_id");