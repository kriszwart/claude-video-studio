# Render/media worker image: Node 22, FFmpeg, Chromium headless shell (via Playwright), local TTS/ASR.
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng libttspico-utils pocketsphinx pocketsphinx-en-us fontconfig \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
ENV PUPPETEER_SKIP_DOWNLOAD=true PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN pnpm install --frozen-lockfile && npx playwright-core install --with-deps chromium-headless-shell
# The worker runs as an unprivileged user; Chrome runs without its own sandbox, so the
# container is the isolation boundary: no provider keys beyond what jobs need, no host mounts.
RUN useradd -m worker && mkdir -p /data && chown worker /data
USER worker
CMD ["node", "--import", "tsx", "apps/worker/src/index.ts"]
