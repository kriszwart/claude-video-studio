import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@vs/domain", "@vs/db", "@vs/templates", "@vs/compositor", "@vs/providers"],
  serverExternalPackages: ["pg", "@aws-sdk/client-s3", "@anthropic-ai/claude-agent-sdk"],
  poweredByHeader: false,
  typedRoutes: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
      // Nothing may be framed, except the live-preview player page by the studio itself.
      { source: "/((?!api/projects/[^/]+/live/).*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
      { source: "/api/projects/:id/live/:path*", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
    ];
  },
};
export default config;
