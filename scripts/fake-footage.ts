/**
 * TEST-ONLY stand-in for the four footage APIs (Internet Archive, Wikimedia Commons, Pexels,
 * Pixabay), answering with the response shapes those APIs document, and serving synthetic
 * SAMPLE media (ffmpeg test patterns). The app only talks to it when the FOOTAGE_*_BASE_URL
 * variables point here, which is ignored in production.
 *
 *   FAKE_FOOTAGE_PORT=3901 tsx scripts/fake-footage.ts
 *   FOOTAGE_IA_BASE_URL=http://127.0.0.1:3901/ia        FOOTAGE_WIKIMEDIA_BASE_URL=http://127.0.0.1:3901/wm
 *   FOOTAGE_PEXELS_BASE_URL=http://127.0.0.1:3901/px    FOOTAGE_PIXABAY_BASE_URL=http://127.0.0.1:3901/pb
 * Keys accepted: Pexels "pexels-test-key", Pixabay "pixabay-test-key". Stats: GET /__stats
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.FAKE_FOOTAGE_PORT ?? 3901);
const B = `http://127.0.0.1:${PORT}`;
const DIR = join(tmpdir(), "fake-footage");
mkdirSync(DIR, { recursive: true });
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function make(name: string, args: string[]) {
  const out = join(DIR, name);
  if (!existsSync(out)) execFileSync("ffmpeg", ["-v", "error", "-y", ...args, out]);
  return out;
}
const label = (t: string) => `drawtext=fontfile=${FONT}:text='SAMPLE ${t}':x=20:y=20:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5`;
const FILES: Record<string, { path: string; type: string }> = {
  "harbour.mp4": { path: make("harbour.mp4", ["-f", "lavfi", "-i", `testsrc2=s=854x480:r=25:d=4,${label("archive harbour")}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast"]), type: "video/mp4" },
  "street.mp4": { path: make("street.mp4", ["-f", "lavfi", "-i", `testsrc=s=1280x720:r=25:d=3,${label("stock street")}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast"]), type: "video/mp4" },
  "waves.webm": { path: make("waves.webm", ["-f", "lavfi", "-i", `smptebars=s=640x360:r=25:d=3,${label("commons waves")}`, "-c:v", "libvpx-vp9", "-b:v", "300k", "-deadline", "realtime"]), type: "video/webm" },
  "photo.jpg": { path: make("photo.jpg", ["-f", "lavfi", "-i", `testsrc2=s=1600x900:d=1,${label("stock photo")}`, "-frames:v", "1"]), type: "image/jpeg" },
};
const stats = { iaSearch: 0, iaMeta: 0, wm: 0, pexels: 0, pexelsAuthFailures: 0, pixabay: 0, pixabayAuthFailures: 0, downloads: 0 };

const IA_ITEMS: Record<string, { title: string; creator?: string; licenseurl?: string }> = {
  PrelingerHarbour1950: { title: "Harbour Life (1950)", creator: "Sample Films", licenseurl: "http://creativecommons.org/publicdomain/mark/1.0/" },
  HarbourNoLicense: { title: "Harbour Home Movie", creator: "Unknown" },
  HarbourNonCommercial: { title: "Harbour Documentary", creator: "Sample Studio", licenseurl: "https://creativecommons.org/licenses/by-nc/4.0/" },
};

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const u = new URL(req.url ?? "/", B);
    const p = u.pathname;
    if (p === "/__stats") return send(res, 200, stats);
    if (p.startsWith("/files/") || p.startsWith("/ia/download/") || p.startsWith("/ia/services/img/")) {
      const name = p.startsWith("/ia/services/img/") ? "photo.jpg" : p.split("/").pop()!;
      const f = FILES[name];
      if (!f) return send(res, 404, { error: "no such file" });
      stats.downloads++;
      const buf = readFileSync(f.path);
      res.writeHead(200, { "content-type": f.type, "content-length": buf.length });
      return res.end(buf);
    }
    // Internet Archive: advancedsearch + metadata
    if (p === "/ia/advancedsearch.php") {
      stats.iaSearch++;
      const docs = Object.entries(IA_ITEMS).map(([identifier, v]) => ({ identifier, ...v }));
      return send(res, 200, { responseHeader: { params: { q: u.searchParams.get("q") } }, response: { numFound: docs.length, start: 0, docs } });
    }
    if (p.startsWith("/ia/metadata/")) {
      stats.iaMeta++;
      const id = decodeURIComponent(p.slice("/ia/metadata/".length));
      const it = IA_ITEMS[id];
      if (!it) return send(res, 200, {});
      return send(res, 200, { metadata: { identifier: id, mediatype: "movies", ...it }, files: [{ name: "harbour.mpeg", format: "MPEG2", source: "original", size: "900000000" }, { name: "harbour.mp4", format: "h.264", source: "derivative", size: String(readFileSync(FILES["harbour.mp4"]!.path).length), width: "854", height: "480", length: "4.0" }] });
    }
    // Wikimedia Commons: MediaWiki query API
    if (p === "/wm/w/api.php") {
      stats.wm++;
      const page = (pageid: number, file: string, mime: string, lic: string) => ({
        pageid,
        ns: 6,
        title: `File:${file}`,
        index: pageid,
        imageinfo: [{ url: `${B}/files/${file}`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${file}`, thumburl: `${B}/files/photo.jpg`, mime, width: 640, height: 360, duration: 3, size: 1000, extmetadata: { ObjectName: { value: "Waves at the pier" }, LicenseShortName: { value: lic }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" }, Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Sample">Sample Photographer</a>' }, AttributionRequired: { value: "true" } } }],
      });
      const pages = { 101: page(101, "waves.webm", "video/webm", "CC BY-SA 4.0") };
      const ids = u.searchParams.get("pageids");
      if (ids) return send(res, 200, { query: { pages: ids === "101" ? pages : { [ids]: { ns: 6, title: "x", missing: "" } } } });
      return send(res, 200, { batchcomplete: "", query: { pages } });
    }
    // Pexels
    if (p.startsWith("/px/")) {
      stats.pexels++;
      if (req.headers.authorization !== "pexels-test-key") {
        stats.pexelsAuthFailures++;
        return send(res, 401, { error: "Unauthorized" });
      }
      const video = { id: 4000001, width: 1280, height: 720, duration: 3, url: "https://www.pexels.com/video/busy-city-street-at-night-4000001/", image: `${B}/files/photo.jpg`, user: { name: "Sample Videographer", url: "https://www.pexels.com/@sample" }, video_files: [{ id: 1, quality: "hd", file_type: "video/mp4", width: 1280, height: 720, link: `${B}/files/street.mp4` }], video_pictures: [] };
      if (p === "/px/videos/search") return send(res, 200, { page: 1, per_page: 24, total_results: 1, videos: [video] });
      if (p === "/px/videos/videos/4000001") return send(res, 200, video);
      return send(res, 404, { error: "not found" });
    }
    // Pixabay
    if (p.startsWith("/pb/api")) {
      stats.pixabay++;
      if (u.searchParams.get("key") !== "pixabay-test-key") {
        stats.pixabayAuthFailures++;
        return send(res, 400, "[ERROR 400] Invalid or missing API key");
      }
      const img = { id: 5000001, pageURL: "https://pixabay.com/photos/lighthouse-coast-5000001/", tags: "lighthouse, coast, sea", previewURL: `${B}/files/photo.jpg`, webformatURL: `${B}/files/photo.jpg`, largeImageURL: `${B}/files/photo.jpg`, imageWidth: 1600, imageHeight: 900, user: "SamplePix" };
      if (u.searchParams.get("id") && u.searchParams.get("id") !== "5000001") return send(res, 200, { total: 0, totalHits: 0, hits: [] });
      return send(res, 200, { total: 1, totalHits: 1, hits: [img] });
    }
    send(res, 404, { error: "not found" });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake footage APIs on ${B}`));
