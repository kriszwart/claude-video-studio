import { describe, expect, it } from "vitest";
import { classifyLicense, footageAdapter, parseLength, pickIaFile, pickPexelsFile, type Fetch } from "../src";

/** A fetch double that records URLs/headers and answers from a route table. */
function fakeFetch(routes: [RegExp, unknown, number?][]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f: Fetch = async (url, init) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const r = routes.find(([re]) => re.test(url));
    if (!r) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(r[1]), { status: r[2] ?? 200, headers: { "content-type": "application/json" } });
  };
  return { f, calls };
}

describe("licence classification", () => {
  it.each([
    ["http://creativecommons.org/publicdomain/mark/1.0/", "public_domain"],
    ["https://creativecommons.org/publicdomain/zero/1.0/", "cc0"],
    ["https://creativecommons.org/licenses/by/4.0/", "attribution"],
    ["https://creativecommons.org/licenses/by-sa/3.0/", "attribution"],
    ["https://creativecommons.org/licenses/by-nc/4.0/", "restricted"],
    ["https://creativecommons.org/licenses/by-nd/4.0/", "restricted"],
    ["CC BY-SA 4.0", "attribution"],
    ["Public domain", "public_domain"],
    ["CC0", "cc0"],
    ["", "unknown"],
    ["Some custom terms", "unknown"],
  ])("%s → %s", (input, status) => expect(classifyLicense(input).status).toBe(status));
  it("names versions", () => {
    expect(classifyLicense("https://creativecommons.org/licenses/by-sa/3.0/").name).toBe("CC BY-SA 3.0");
  });
});

describe("Internet Archive", () => {
  const search = { response: { numFound: 30, docs: [{ identifier: "PrelingerCity1949", title: "City Streets", creator: "Jam Handy", licenseurl: "http://creativecommons.org/publicdomain/mark/1.0/" }, { identifier: "someclip", title: ["Harbour"], licenseurl: "https://creativecommons.org/licenses/by/4.0/" }] } };
  const meta = {
    metadata: { identifier: "PrelingerCity1949", title: "City Streets", creator: "Jam Handy", licenseurl: "http://creativecommons.org/publicdomain/mark/1.0/" },
    files: [
      { name: "City.mpeg", format: "MPEG2", source: "original", size: "900000000" },
      { name: "City.mp4", format: "h.264", source: "derivative", size: "80000000", height: "480", width: "640", length: "00:09:30" },
      { name: "City_512kb.mp4", format: "512Kb MPEG4", source: "derivative", size: "30000000", height: "240", width: "320", length: "570.2" },
    ],
  };
  it("searches movies with an open-licence filter and maps licences", async () => {
    const { f, calls } = fakeFetch([[/advancedsearch/, search]]);
    const r = await footageAdapter("internet_archive", { fetch: f }).search({ q: "city streets", kind: "video", perPage: 24 });
    const q = new URL(calls[0]!.url).searchParams.get("q")!;
    expect(q).toContain("mediatype:(movies)");
    expect(q).toContain("licenseurl:(*publicdomain*");
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ id: "PrelingerCity1949", title: "City Streets", creator: "Jam Handy", pageUrl: "https://archive.org/details/PrelingerCity1949", license: { status: "public_domain", attributionRequired: false } });
    expect(r.items[1]!.license).toMatchObject({ status: "attribution", name: "CC BY 4.0", attributionRequired: true });
    expect(r.items[1]!.license.attribution).toContain("Internet Archive");
    expect(r.nextPage).toBe(2);
  });
  it("resolves to the ≥480p MP4 derivative, not the huge original", async () => {
    const { f } = fakeFetch([[/metadata\/PrelingerCity1949/, meta]]);
    const item = await footageAdapter("internet_archive", { fetch: f }).resolve("PrelingerCity1949", "video");
    expect(item.downloadUrl).toBe("https://archive.org/download/PrelingerCity1949/City.mp4");
    expect(item.durationSec).toBe(570);
    expect(pickIaFile([{ name: "a.mpeg", size: "1" }], "video")).toBeNull();
    expect(parseLength("01:02:03")).toBe(3723);
  });
  it("rejects bad identifiers without calling out", async () => {
    const { f, calls } = fakeFetch([]);
    await expect(footageAdapter("internet_archive", { fetch: f }).resolve("../etc/passwd", "video")).rejects.toMatchObject({ code: "bad_request" });
    expect(calls).toHaveLength(0);
  });
});

describe("Wikimedia Commons", () => {
  const page = (id: number, mime: string, lic: string) => ({
    pageid: id,
    index: id,
    title: `File:Clip ${id}.webm`,
    imageinfo: [{ url: `https://upload.wikimedia.org/x/Clip_${id}.webm`, thumburl: `https://upload.wikimedia.org/t/${id}.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/File:Clip_${id}.webm`, mime, width: 1280, height: 720, duration: 12.5, extmetadata: { LicenseShortName: { value: lic }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" }, Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Ann">Ann &amp; Co</a>' }, AttributionRequired: { value: lic.startsWith("CC BY") ? "true" : "false" } } }],
  });
  it("keeps supported formats with open licences, strips HTML from the artist", async () => {
    const { f, calls } = fakeFetch([[/generator=search/, { query: { pages: { 1: page(1, "video/webm", "CC BY-SA 4.0"), 2: page(2, "application/ogg", "CC0"), 3: page(3, "video/webm", "CC BY-NC 4.0") } }, continue: { gsroffset: 24 } }]]);
    const r = await footageAdapter("wikimedia", { fetch: f }).search({ q: "harbour", kind: "video" });
    expect(new URL(calls[0]!.url).searchParams.get("gsrsearch")).toBe("harbour filetype:video");
    expect(r.items.map((i) => i.id)).toEqual(["1"]);
    expect(r.items[0]).toMatchObject({ creator: "Ann & Co", durationSec: 12.5, license: { status: "attribution", name: "CC BY-SA 4.0", attributionRequired: true } });
    expect(r.items[0]!.license.attribution).toMatch(/Ann & Co.*CC BY-SA 4.0.*Wikimedia Commons/);
    expect(r.nextPage).toBe(2);
  });
  it("refuses Ogg Theora on resolve", async () => {
    const { f } = fakeFetch([[/pageids=2/, { query: { pages: { 2: page(2, "application/ogg", "CC0") } } }]]);
    await expect(footageAdapter("wikimedia", { fetch: f }).resolve("2", "video")).rejects.toMatchObject({ code: "no_supported_file" });
  });
});

describe("Pexels", () => {
  const video = { id: 857251, width: 3840, height: 2160, duration: 14, url: "https://www.pexels.com/video/drone-view-of-a-harbour-857251/", image: "https://images.pexels.com/videos/857251/p.jpg", user: { name: "Kim" }, video_files: [{ id: 1, quality: "uhd", file_type: "video/mp4", width: 3840, height: 2160, link: "https://videos.pexels.com/uhd.mp4" }, { id: 2, quality: "hd", file_type: "video/mp4", width: 1920, height: 1080, link: "https://videos.pexels.com/hd.mp4" }, { id: 3, quality: "sd", file_type: "video/mp4", width: 640, height: 360, link: "https://videos.pexels.com/sd.mp4" }] };
  it("needs a key; sends it as Authorization; picks ≤1080p for import and the smallest for preview", async () => {
    await expect(footageAdapter("pexels", { fetch: fakeFetch([]).f }).search({ q: "harbour", kind: "video" })).rejects.toMatchObject({ code: "not_configured" });
    const { f, calls } = fakeFetch([[/videos\/search/, { total_results: 1, videos: [video] }]]);
    const r = await footageAdapter("pexels", { fetch: f, apiKey: "pk-test" }).search({ q: "harbour", kind: "video" });
    expect(calls[0]!.headers.authorization).toBe("pk-test");
    expect(r.items[0]).toMatchObject({ title: "Drone view of a harbour", creator: "Kim", downloadUrl: "https://videos.pexels.com/hd.mp4", previewUrl: "https://videos.pexels.com/sd.mp4", license: { status: "platform", name: "Pexels License" } });
    expect(pickPexelsFile([{ id: 1, file_type: "video/mp4", width: 3840, height: 2160, link: "x" }])?.link).toBe("x");
  });
});

describe("Pixabay", () => {
  it("passes the key as a query parameter and maps renditions", async () => {
    const hit = { id: 125, pageURL: "https://pixabay.com/videos/id-125/", tags: "harbour, boats, sea", duration: 20, user: "Lee", videos: { large: { url: "https://cdn.pixabay.com/l.mp4", width: 3840, height: 2160, thumbnail: "t.jpg" }, medium: { url: "https://cdn.pixabay.com/m.mp4", width: 1920, height: 1080, thumbnail: "tm.jpg" }, small: { url: "https://cdn.pixabay.com/s.mp4", width: 1280, height: 720 }, tiny: { url: "https://cdn.pixabay.com/t.mp4", width: 640, height: 360, thumbnail: "tt.jpg" } } };
    const { f, calls } = fakeFetch([[/api\/videos/, { totalHits: 1, hits: [hit] }]]);
    const r = await footageAdapter("pixabay", { fetch: f, apiKey: "px-test" }).search({ q: "harbour", kind: "video" });
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("key")).toBe("px-test");
    expect(u.searchParams.get("safesearch")).toBe("true");
    expect(r.items[0]).toMatchObject({ title: "Harbour, boats, sea", downloadUrl: "https://cdn.pixabay.com/m.mp4", previewUrl: "https://cdn.pixabay.com/t.mp4", thumbUrl: "tt.jpg", license: { name: "Pixabay Content License" } });
  });
  it("maps a rejected key to not_configured", async () => {
    const { f } = fakeFetch([[/api/, { error: "invalid key" }, 400]]);
    await expect(footageAdapter("pixabay", { fetch: f, apiKey: "bad" }).search({ q: "x", kind: "image" })).rejects.toMatchObject({ code: "provider_error" });
  });
});
