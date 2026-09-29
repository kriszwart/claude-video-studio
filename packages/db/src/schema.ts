import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull().default(""),
  /** scrypt hash "salt:hash" — null for the local-dev owner. */
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role", { enum: ["owner", "editor", "viewer"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_ws_user").on(t.workspaceId, t.userId)],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256 of the opaque cookie token
  userId: text("user_id").notNull().references(() => users.id),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

export const templates = pgTable(
  "templates",
  {
    id: text("id").primaryKey(),
    /** Null for built-in templates available to every workspace. */
    workspaceId: text("workspace_id").references(() => workspaces.id),
    family: text("family").notNull(),
    preset: text("preset"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    builtin: boolean("builtin").notNull().default(false),
    latestVersion: integer("latest_version").notNull().default(1),
    archived: boolean("archived").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("templates_ws").on(t.workspaceId)],
);

/** Immutable once published. Projects pin (templateId, version). */
export const templateVersions = pgTable(
  "template_versions",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id").notNull().references(() => templates.id),
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull(),
    definitionHash: text("definition_hash").notNull(),
    previewAssetId: text("preview_asset_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("template_versions_tpl_ver").on(t.templateId, t.version)],
);

export const brandKits = pgTable("brand_kits", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  data: jsonb("data").notNull(),
  archived: boolean("archived").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const creativeProfiles = pgTable("creative_profiles", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  latestVersion: integer("latest_version").notNull().default(1),
  createdAt: createdAt(),
});

export const creativeProfileVersions = pgTable(
  "creative_profile_versions",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull().references(() => creativeProfiles.id),
    version: integer("version").notNull(),
    data: jsonb("data").notNull(),
    /** Evidence (reference analysis) and the diff from the previous version. */
    evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
    changeSummary: jsonb("change_summary").notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("profile_versions_pv").on(t.profileId, t.version)],
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    title: text("title").notNull(),
    templateId: text("template_id").notNull(),
    templateVersion: integer("template_version").notNull(),
    family: text("family").notNull(),
    currentRevisionId: text("current_revision_id"),
    status: text("status", { enum: ["active", "archived", "deleted"] }).notNull().default("active"),
    isSample: boolean("is_sample").notNull().default(false),
    /** Variant siblings share a group id (A18). */
    variantGroupId: text("variant_group_id"),
    variantLabel: text("variant_label"),
    budget: jsonb("budget").notNull(),
    deletedAt: ts("deleted_at"),
    purgeAfter: ts("purge_after"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("projects_ws_status").on(t.workspaceId, t.status)],
);

export const projectRevisions = pgTable(
  "project_revisions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    seq: integer("seq").notNull(),
    parentRevisionId: text("parent_revision_id"),
    schemaVersion: integer("schema_version").notNull(),
    document: jsonb("document").notNull(),
    documentHash: text("document_hash").notNull(),
    author: text("author", { enum: ["user", "assistant", "bulk", "system", "planner"] }).notNull(),
    action: text("action").notNull(),
    operations: jsonb("operations").notNull().default(sql`'[]'::jsonb`),
    history: jsonb("history").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("revisions_project_seq").on(t.projectId, t.seq)],
);

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    kind: text("kind", { enum: ["image", "svg", "video", "audio", "font", "render", "document", "other"] }).notNull(),
    status: text("status", { enum: ["pending", "ready", "failed"] }).notNull().default("pending"),
    storageKey: text("storage_key").notNull(),
    contentHash: text("content_hash"),
    mime: text("mime"),
    bytes: bigint("bytes", { mode: "number" }),
    originalName: text("original_name").notNull().default(""),
    /** Probed media metadata: width, height, durationSec, codecs, audio presence, fps. */
    media: jsonb("media").notNull().default(sql`'{}'::jsonb`),
    /** Source URL/upload/provider, retrieval date, license, generation params. */
    provenance: jsonb("provenance").notNull().default(sql`'{}'::jsonb`),
    /** Derived keys: thumbnail, proxy, waveform, rasterised svg. */
    derived: jsonb("derived").notNull().default(sql`'{}'::jsonb`),
    rightsAcknowledged: boolean("rights_acknowledged").notNull().default(false),
    generated: boolean("generated").notNull().default(false),
    isSample: boolean("is_sample").notNull().default(false),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("assets_ws").on(t.workspaceId),
    uniqueIndex("assets_ws_hash").on(t.workspaceId, t.contentHash).where(sql`${t.contentHash} is not null and ${t.status} = 'ready' and ${t.kind} <> 'render'`),
  ],
);

export const characters = pgTable("characters", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  referenceAssetIds: jsonb("reference_asset_ids").notNull().default(sql`'[]'::jsonb`),
  styleNotes: text("style_notes").notNull().default(""),
  acceptedVariants: jsonb("accepted_variants").notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    projectId: text("project_id"),
    revisionId: text("revision_id"),
    type: text("type").notNull(),
    status: text("status", { enum: ["queued", "running", "waiting_provider", "cancel_requested", "succeeded", "failed", "canceled", "uncertain"] })
      .notNull()
      .default("queued"),
    stage: text("stage").notNull().default("queued"),
    /** Only set when measured (e.g. frames captured / total). */
    progress: real("progress"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<{ code: string; message: string; retryable?: boolean; recovery?: string }>(),
    idempotencyKey: text("idempotency_key"),
    providerRequestId: text("provider_request_id"),
    parentJobId: text("parent_job_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: ts("lease_expires_at"),
    runAfter: ts("run_after").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    cancelRequestedAt: ts("cancel_requested_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_idem").on(t.workspaceId, t.idempotencyKey),
    index("jobs_project").on(t.projectId),
    index("jobs_status").on(t.status, t.runAfter),
  ],
);

/** Transactional outbox: written in the same transaction as the job row. */
export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: text("job_id").notNull(),
    publishedAt: ts("published_at"),
    createdAt: createdAt(),
  },
  (t) => [index("outbox_unpublished").on(t.publishedAt)],
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: text("job_id").notNull(),
    projectId: text("project_id"),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind").notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("job_events_project").on(t.projectId, t.id)],
);

export const exportsTable = pgTable(
  "exports",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    revisionId: text("revision_id").notNull(),
    jobId: text("job_id").notNull().unique(),
    kind: text("kind", { enum: ["preview", "final"] }).notNull(),
    videoAssetId: text("video_asset_id").notNull(),
    thumbnailAssetId: text("thumbnail_asset_id"),
    captionsSrtAssetId: text("captions_srt_asset_id"),
    captionsVttAssetId: text("captions_vtt_asset_id"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    durationSec: real("duration_sec").notNull(),
    bundleHash: text("bundle_hash").notNull(),
    verification: jsonb("verification").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("exports_project").on(t.projectId)],
);

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id"),
    jobId: text("job_id"),
    /** Stable logical operation key; duplicate provider events settle the same row (A08). */
    operationId: text("operation_id").notNull(),
    provider: text("provider").notNull(),
    capability: text("capability").notNull(),
    status: text("status", { enum: ["reserved", "settled", "released", "unknown_price"] }).notNull(),
    estimatedMicros: bigint("estimated_micros", { mode: "number" }),
    reservedMicros: bigint("reserved_micros", { mode: "number" }),
    actualMicros: bigint("actual_micros", { mode: "number" }),
    currency: text("currency").notNull().default("USD"),
    priceTimestamp: text("price_timestamp"),
    priceBasis: text("price_basis"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ledger_operation").on(t.workspaceId, t.operationId)],
);

export const providerConfigs = pgTable(
  "provider_configs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    provider: text("provider").notNull(),
    /** AES-256-GCM ciphertext (iv:tag:data, base64). Never returned by the API. */
    encryptedSecret: text("encrypted_secret"),
    keyHint: text("key_hint"),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    lastCheck: jsonb("last_check"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("provider_ws").on(t.workspaceId, t.provider)],
);

/**
 * One billable provider request (image/video generation). The provider request id is
 * persisted the moment it is known; an unknown outcome is recorded as "uncertain" and is
 * never blindly resubmitted (§12).
 */
export const generationRequests = pgTable(
  "generation_requests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id"),
    jobId: text("job_id"),
    /** Stable logical key (project:shot:variant); one row per billable attempt. */
    operationId: text("operation_id").notNull(),
    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),
    capability: text("capability", { enum: ["image", "video"] }).notNull(),
    requestId: text("request_id"),
    state: text("state", { enum: ["submitting", "submitted", "succeeded", "failed", "canceled", "uncertain"] }).notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    assetId: text("asset_id"),
    error: jsonb("error"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("generation_operation").on(t.workspaceId, t.operationId), index("generation_request").on(t.provider, t.requestId)],
);

export const providerEvents = pgTable(
  "provider_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: text("provider").notNull(),
    /** Deduplication key: provider event id or request id + status. */
    eventKey: text("event_key").notNull(),
    requestId: text("request_id"),
    payload: jsonb("payload").notNull(),
    processedAt: ts("processed_at"),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("provider_events_key").on(t.provider, t.eventKey)],
);

export const sourceTranscripts = pgTable("source_transcripts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  assetId: text("asset_id").notNull(),
  provider: text("provider").notNull(),
  language: text("language"),
  /** "word" when the engine produced measured word timings, otherwise "segment". */
  granularity: text("granularity", { enum: ["word", "segment"] }).notNull(),
  /** Immutable machine transcript. */
  segments: jsonb("segments").notNull(),
  /** User-corrected transcript (derived; the original is never overwritten). */
  corrected: jsonb("corrected"),
  createdAt: createdAt(),
});

export const collections = pgTable("collections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  limits: jsonb("limits").notNull(),
  createdAt: createdAt(),
});

export const collectionItems = pgTable(
  "collection_items",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id").notNull().references(() => collections.id),
    workspaceId: text("workspace_id").notNull(),
    assetId: text("asset_id"),
    sourceName: text("source_name").notNull(),
    contentHash: text("content_hash"),
    bytes: bigint("bytes", { mode: "number" }),
    durationSec: real("duration_sec"),
    status: text("status", { enum: ["pending", "uploaded", "probing", "transcribing", "needs_transcript", "indexed", "failed"] }).notNull().default("pending"),
    transcriptId: text("transcript_id"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("collection_items_hash").on(t.collectionId, t.contentHash)],
);

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    collectionId: text("collection_id"),
    transcriptId: text("transcript_id").notNull(),
    assetId: text("asset_id").notNull(),
    startSec: real("start_sec").notNull(),
    endSec: real("end_sec").notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    index("segments_collection").on(t.collectionId),
    index("segments_fts").using("gin", sql`to_tsvector('english', ${t.text})`),
  ],
);

export const qualityReports = pgTable("quality_reports", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  revisionId: text("revision_id").notNull(),
  jobId: text("job_id").notNull(),
  verdict: text("verdict", { enum: ["ready", "needs_review", "failed"] }).notNull(),
  report: jsonb("report").notNull(),
  createdAt: createdAt(),
});

export const graphicsCache = pgTable("graphics_cache", {
  key: text("key").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  backend: text("backend").notNull(),
  assetId: text("asset_id").notNull(),
  meta: jsonb("meta").notNull(),
  createdAt: createdAt(),
});

export const workerCapabilities = pgTable("worker_capabilities", {
  workerId: text("worker_id").primaryKey(),
  capabilities: jsonb("capabilities").notNull(),
  heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
});

/** Product analytics — never scripts, media, or keys. */
export const analyticsEvents = pgTable("analytics_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  props: jsonb("props").notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

export const cleanupTasks = pgTable("cleanup_tasks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  kind: text("kind").notNull(),
  target: text("target").notNull(),
  runAfter: ts("run_after").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  doneAt: ts("done_at"),
  createdAt: createdAt(),
});
