import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataDir, workspaceRoot } from "../src/storage";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const cwd = process.cwd();
const env = { DATA_DIR: process.env.DATA_DIR, STUDIO_REPO_ROOT: process.env.STUDIO_REPO_ROOT };

describe("storage paths", () => {
  afterEach(() => {
    process.chdir(cwd);
    process.env.DATA_DIR = env.DATA_DIR;
    if (env.STUDIO_REPO_ROOT === undefined) delete process.env.STUDIO_REPO_ROOT;
    else process.env.STUDIO_REPO_ROOT = env.STUDIO_REPO_ROOT;
  });

  it("resolves a relative DATA_DIR to the same folder from the web app and the worker", () => {
    delete process.env.STUDIO_REPO_ROOT;
    process.env.DATA_DIR = "./data";
    process.chdir(join(ROOT, "apps", "web")); // where `next dev` runs
    const fromWeb = dataDir();
    process.chdir(ROOT); // where the worker runs
    const fromWorker = dataDir();
    expect(fromWeb).toBe(join(ROOT, "data"));
    expect(fromWorker).toBe(fromWeb);
    expect(workspaceRoot()).toBe(ROOT);
  });

  it("keeps an absolute DATA_DIR as given", () => {
    process.env.DATA_DIR = "/srv/studio-data";
    process.chdir(join(ROOT, "apps", "web"));
    expect(dataDir()).toBe("/srv/studio-data");
  });
});
