import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPublicAddress, safeFetch, UnsafeUrlError } from "../src/net/safeFetch";

const opts = { maxBytes: 1024 * 1024, allowedTypes: /^image\/(png|jpeg)$/ };

describe("A15: SSRF protection", () => {
  it("classifies addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fd00::1", "fe80::1", "224.0.0.1", "64:ff9b::10.0.0.1"]) expect(isPublicAddress(a), a).toBe(false);
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) expect(isPublicAddress(a), a).toBe(true);
  });

  it("rejects private, metadata, obfuscated and non-web targets before connecting", async () => {
    const urls = ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://2130706433/", "http://0x7f.1/", "http://[::ffff:127.0.0.1]/", "http://[::1]:80/", "http://10.0.0.5/", "https://example.com:5432/", "file:///etc/passwd", "gopher://x/", "http://user:pw@example.com/"];
    for (const u of urls) await expect(safeFetch(u, opts), u).rejects.toBeInstanceOf(UnsafeUrlError);
    // A public-looking name that resolves (even partly) to a private address is refused.
    await expect(safeFetch("http://rebind.test/", { ...opts, resolve: async () => ["93.184.216.34", "127.0.0.1"] })).rejects.toMatchObject({ code: "blocked_address" });
    await expect(safeFetch("http://localhost/", opts)).rejects.toMatchObject({ code: "blocked_address" });
  });

  describe("redirects and limits (local fixture server trusted as 'public' for the first hop only)", () => {
    let server: http.Server;
    let port = 0;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === "/to-metadata") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
        if (req.url === "/to-localhost") return res.writeHead(302, { location: "http://localhost/secret" }).end();
        if (req.url === "/huge") return res.writeHead(200, { "content-type": "image/png", "content-length": String(5 * 1024 * 1024) }).end();
        if (req.url === "/html") return res.writeHead(200, { "content-type": "text/html" }).end("<html>");
        res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => server.close());
    // The fixture listens on a high port; route the test hostname to it via a pinned resolver.
    const local = (path: string) => `http://fixture.test${path}`;
    const withFixture = (extra: object = {}) => ({ ...opts, resolve: async (h: string) => (h === "fixture.test" ? ["127.0.0.1"] : []), trustAddresses: ["127.0.0.1"], ...extra });

    it("refuses non-standard ports even for trusted addresses", async () => {
      await expect(safeFetch(`http://127.0.0.1:${port}/ok.png`, withFixture())).rejects.toMatchObject({ code: "blocked_port" });
    });

    it("pins to the fixture and enforces redirect targets, size and type", async () => {
      const real = http.request;
      // Redirect fixture requests from :80 to the fixture's port (test harness only).
      (http as unknown as { request: typeof http.request }).request = ((url: URL, o: http.RequestOptions, cb: (r: http.IncomingMessage) => void) => {
        const u = new URL(url);
        if (u.hostname === "fixture.test") u.port = String(port);
        return real(u, { ...o }, cb);
      }) as typeof http.request;
      try {
        const ok = await safeFetch(local("/ok.png"), withFixture());
        expect(ok.contentType).toBe("image/png");
        expect(ok.address).toBe("127.0.0.1");
        await expect(safeFetch(local("/to-metadata"), withFixture())).rejects.toMatchObject({ code: "blocked_address" });
        // localhost is NOT trusted even though the fixture address is: only exact trusted addresses pass.
        await expect(safeFetch(local("/to-localhost"), withFixture({ resolve: async (h: string) => (h === "fixture.test" ? ["127.0.0.1"] : ["127.0.0.2"]) }))).rejects.toMatchObject({ code: "blocked_address" });
        await expect(safeFetch(local("/huge"), withFixture())).rejects.toMatchObject({ code: "too_large" });
        await expect(safeFetch(local("/html"), withFixture())).rejects.toMatchObject({ code: "bad_type" });
      } finally {
        (http as unknown as { request: typeof http.request }).request = real;
      }
    });
  });
});
