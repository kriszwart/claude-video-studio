# Web app image (Next.js production server). No provider keys are required at build time.
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @vs/web build
ENV NODE_ENV=production STUDIO_AUTH_MODE=password HOST=0.0.0.0 PORT=3000
RUN useradd -m web
USER web
EXPOSE 3000
CMD ["pnpm", "--filter", "@vs/web", "start"]
