# Deployment

This guide covers running Video Studio for people other than yourself. For local
development see the README.

## Topology

```
            HTTPS (reverse proxy: TLS, request size limits)
                 │
          ┌──────▼──────┐        ┌──────────────┐
          │  web (Next)  │◀──────▶│  PostgreSQL  │  authoritative state, jobs, ledger
          └──────┬──────┘        └──────▲───────┘
                 │ outbox → queue        │
          ┌──────▼──────┐        ┌───────┴──────┐
          │    Redis     │◀──────▶│   worker(s)  │  FFmpeg + headless Chromium renders
          └─────────────┘        └───────┬──────┘
                                         │
                                  blob storage (local volume or S3)
```

Web and worker are separate processes/images (`infra/web.Dockerfile`,
`infra/worker.Dockerfile`). Scale workers horizontally; each claims jobs with a lease.

## Required settings

| Variable | Notes |
| --- | --- |
| `STUDIO_AUTH_MODE=password` | Mandatory for any non-loopback deployment. Local mode refuses non-loopback requests (tested) but is not an authentication system. |
| `APP_SECRET` | ≥ 32 random chars. Signs download URLs and provider webhook tokens. The server refuses to start requests without it in production. |
| `APP_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts provider keys at rest (AES-256-GCM). Required in production. |
| `SETUP_TOKEN` | Needed once to claim the owner account at `/setup`; the endpoint refuses once an owner exists. |
| `DATABASE_URL`, `REDIS_URL` | Private network only; never expose to the internet. |
| `STORAGE_DRIVER`, `DATA_DIR` / `S3_*` | Durable media storage. |
| `PUBLIC_BASE_URL` | Enables provider webhooks (otherwise generation uses polling). |

Additional workspace owners (operators only, no HTTP route): `tsx scripts/create-user.ts <email> <password> [workspace]`.

Web and worker must share `APP_SECRET`, `APP_ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_URL` and storage configuration.

## Secrets

- Provider keys are entered by the owner in **Settings** (encrypted with `APP_ENCRYPTION_KEY`)
  or provided as server environment variables. They are never returned by the API or logged
  (request logs redact them).
- **Rotation of `APP_ENCRYPTION_KEY`:** deploy with the new key in `APP_ENCRYPTION_KEY` and the
  old one in `APP_ENCRYPTION_KEY_PREVIOUS`, run `tsx scripts/rotate-secrets.ts`, then remove
  the previous key. (Unit-tested in `packages/db/test/crypto.test.ts`.)
- Rotating `APP_SECRET` invalidates outstanding signed URLs and in-flight webhook URLs only;
  in-flight generation jobs fall back to polling.
- `.dockerignore` keeps `.env`, `data/`, `artifacts/` and build output out of images.

## Composition and render isolation

Compositions are produced only by the compositor from validated project data: user text is
HTML-escaped, inline JSON is script-safe, colours and font names are allow-listed, and assets
are referenced by id and staged into a per-job bundle (see `packages/compositor/test`).
Rendering runs in the worker, never in the web process.

The worker image runs as an unprivileged user; Chromium runs without its own sandbox, so
**the container is the isolation boundary**. Recommended runtime settings:

- CPU/memory limits and `pids-limit` on the worker container; `shm_size: 2gb` for Chromium.
- Read-only root filesystem with a writable `DATA_DIR` volume and `/tmp`.
- Network egress restricted to: PostgreSQL, Redis, object storage, and the provider APIs you
  enable (api.anthropic.com, api.elevenlabs.io, queue.fal.run + fal media CDN). URL import and
  provider-output downloads additionally pass the SSRF guard (public addresses only,
  pinned connections, per-hop redirect checks, size/type limits).
- No host mounts; no Docker socket.
- Job-level time limits: renders and FFmpeg calls have explicit timeouts; leases expire after
  90 s without a heartbeat and the job is retried or reconciled (A07 test).

Known limits: web and worker share the database credentials (jobs are coordinated through
PostgreSQL). A compromised worker could therefore read other workspaces' rows; keep workers on
a private network and treat them as trusted infrastructure.

## Redraw (private package)

Redraw's license forbids redistribution. Only build the worker image with the tarball in
`vendor/redraw/` for a **private** registry, set `REDRAW_TARBALL` and `REDRAW_SHA256`, and never
publish that image or the tarball. Public images should be built without it; the studio then
reports the capability as unavailable and refuses (with an explicit error) projects that
contain Redraw layers. Template exports never include runtime packages.

Redraw needs WebGPU. Without a GPU the worker uses Chromium's software (SwiftShader) adapter:
correct and deterministic but slow (~10 minutes for 5 s at 960×540 in our measurements). For
production Redraw rendering, run those workers on GPU hosts.

## Backups, retention, restore

- **Database:** nightly `pg_dump -Fc` (or managed PITR). It holds projects, revisions, jobs,
  ledger, transcripts and encrypted provider keys (useless without `APP_ENCRYPTION_KEY`, so
  back that key up separately, e.g. in your secrets manager).
- **Media:** object storage with versioning, or snapshots of `DATA_DIR/storage`.
- **Retention:** deleted projects are recoverable for `DELETE_RECOVERY_DAYS` (default 7) and
  then purged with their exports by the cleanup job; uploaded assets are workspace-owned.
- **Restore test (do this before going public):**
  1. Provision an empty database and storage.
  2. `pg_restore -d $DATABASE_URL backup.dump`, restore the media volume/bucket.
  3. Start web + worker with the same `APP_SECRET`/`APP_ENCRYPTION_KEY`.
  4. `pnpm db:migrate` (no-op if up to date), log in, open a project, render a draft, and
     download an older export.

## Health and operations

- `GET /api/health` — web liveness.
- Workers report capabilities (renderer, FFmpeg, TTS voices, Skia/Redraw availability)
  every heartbeat; the template gallery only marks a template "ready" when a live worker has
  what it needs.
- Logs: web and worker log JSON lines; errors shown to users are sanitised (no SQL, stack or
  provider bodies).
