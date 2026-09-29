import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ART, createProject, FIX } from "./helpers";

/** A21: reference → evidence-backed profile → feedback proposal → explicit v2 → second project. */
test("A21: style learning and reuse with explicit versions", async ({ page, request }) => {
  test.setTimeout(10 * 60_000);
  const a = await createProject(request, { templateId: "motion-reel", title: "Profile project A", inputs: { hook: "Focus wins", headline: "Plan less. Ship more.", brandName: "Lumen Notes", points: ["Deep work", "Clear weeks"], cta: "lumen.example" } });
  const b = await createProject(request, { templateId: "motion-reel", title: "Profile project B", inputs: { hook: "Calm tools", headline: "Explain it slowly.", brandName: "Lumen Notes", points: ["One idea", "One screen"], cta: "lumen.example" } });

  // 1) Analyse the supplied reference clip.
  await page.goto("/profiles");
  const picker = page.locator("section", { hasText: "Create from a reference" });
  await picker.getByRole("button", { name: /Choose video/ }).click();
  await picker.getByLabel(/I have the rights/).check();
  await picker.locator('input[type="file"]').setInputFiles(join(FIX, "reference-calm-reel.mp4"));
  await expect(picker.locator(".chip").first()).toContainText("reference-calm-reel", { timeout: 60_000 });
  await picker.getByRole("button", { name: "Close library" }).click();
  await page.getByRole("button", { name: "Analyse reference" }).click();
  const traits = page.getByRole("table", { name: "Proposed traits" });
  await expect(traits).toBeVisible({ timeout: 120_000 });
  const row = (field: string) => page.getByTestId("trait").filter({ has: page.locator("td", { hasText: new RegExp(`^${field}$`) }) });
  // Ground truth: five 4.6 s shots joined through black.
  await expect(row("pacing")).toContainText("calm");
  await expect(row("pacing")).toContainText("measured");
  await expect(row("pacing")).toContainText(/5 shots in 23\.0 s/);
  for (const t of ["4.6", "9.2", "13.8", "18.4"]) await expect(row("pacing").locator(".chip", { hasText: new RegExp(`@ ${t.slice(0, -1)}\\d?\\ds`) }).first()).toBeVisible();
  await expect(row("transition")).toContainText("fade");
  await expect(row("textDensity")).toContainText("not measured");
  await expect(row("intent")).toContainText("interpretation");
  await expect(row("intent").getByRole("checkbox")).toBeDisabled();
  await expect(page.getByRole("img", { name: /Reference frame at/ }).first()).toBeVisible();
  await page.screenshot({ path: join(ART, "m6-profile-analysis.png"), fullPage: true });
  await page.getByLabel("Profile name").fill("Calm Technical");
  await page.getByRole("button", { name: "Save selected traits as profile" }).click();
  await page.waitForURL(/\/profiles\/cpr_/);
  const profileId = page.url().split("/profiles/")[1]!;
  const v1 = (await (await request.get(`/api/profiles/${profileId}`)).json()).versions[0];
  expect(v1.data).toMatchObject({ name: "Calm Technical", pacing: "calm", transition: "fade" });

  // 2) Apply v1 to project A.
  await page.getByLabel("Project", { exact: true }).selectOption({ label: "Profile project A" });
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Applied v1");

  // 3) Feedback becomes a visible proposal; saving is explicit and creates v2 with a diff.
  await page.getByLabel("Feedback", { exact: true }).fill("Larger text, fewer whooshes and longer explanation shots. Make it feel like autumn.");
  await page.getByRole("button", { name: "Propose changes" }).click();
  const proposal = page.getByRole("region", { name: "Proposed changes" });
  await expect(proposal.getByTestId("proposed-change").filter({ hasText: "typeScale" })).toContainText(/1 → 1\.15/);
  await expect(proposal).toContainText("soundDensity");
  await expect(proposal).toContainText(/Not understood.*autumn/);
  // Nothing saved yet.
  expect((await (await request.get(`/api/profiles/${profileId}`)).json()).profile.latestVersion).toBe(1);
  await page.screenshot({ path: join(ART, "m6-profile-proposal.png"), fullPage: true });
  await proposal.getByRole("button", { name: "Save as v2" }).click();
  await expect(page.getByRole("status")).toContainText("Saved as v2");
  const history = page.getByRole("list", { name: "Version history" });
  await expect(history.getByTestId("profile-version").first()).toContainText(/typeScale: 1 → 1\.15 \(“Larger text/);

  // 4) Apply v2 to a second project; project A stays pinned to v1 (no silent edits).
  await page.getByLabel("Project", { exact: true }).selectOption({ label: "Profile project B" });
  await page.getByLabel("Version", { exact: true }).selectOption("2");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Applied v2");
  const docA = (await (await request.get(`/api/projects/${a.project.id}`)).json()).doc;
  const docB = (await (await request.get(`/api/projects/${b.project.id}`)).json()).doc;
  expect(docA.profile).toMatchObject({ profileId, version: 1, typeScale: 1 });
  expect(docB.profile).toMatchObject({ profileId, version: 2, typeScale: 1.15, soundDensity: "minimal" });
  expect(docB.profile.avoided).toContain("whoosh effects");
  // Transitions follow the profile on unlocked scenes that had one.
  expect(docB.scenes.slice(1).filter((s: { transitionIn: { type: string } }) => s.transitionIn.type !== "cut").every((s: { transitionIn: { type: string } }) => s.transitionIn.type === "fade")).toBe(true);

  // 5) A stale save is refused; the Markdown export carries evidence timestamps.
  const stale = await request.post(`/api/profiles/${profileId}`, { data: { baseVersion: 1, data: { ...v1.data, typeScale: 1.4 } } });
  expect(stale.status()).toBe(409);
  const md = await (await request.get(`/api/profiles/${profileId}/versions/2/markdown`)).text();
  expect(md).toContain("# Creative profile: Calm Technical (v2)");
  expect(md).toMatch(/pacing \(measured\).*at 4\.\d+s/);
  await page.screenshot({ path: join(ART, "m6-profile-versions.png"), fullPage: true });
});
