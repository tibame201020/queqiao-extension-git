import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GIT_EXTENSION_MANIFEST } from "./index.js";

const packageFile = path.resolve(import.meta.dirname, "../package.json");

describe("Git extension npm package contract", () => {
  it("is an independently installable Extension Hub package", async () => {
    const pkg = JSON.parse(await readFile(packageFile, "utf8")) as {
      version: string;
      private?: boolean;
      files?: string[];
      dependencies?: Record<string, string>;
      queqiao?: { apiVersion?: number; module?: string; manifest?: unknown };
    };

    expect(pkg.private).toBe(false);
    expect(pkg.version).toBe(GIT_EXTENSION_MANIFEST.version);
    expect(pkg.files).toEqual(expect.arrayContaining(["dist/index.js"]));
    expect(pkg.dependencies).toEqual({ zod: "4.4.3" });
    expect(Object.keys(pkg.dependencies || {}).some((name) => name.startsWith("@queqiao/"))).toBe(false);
    expect(pkg.queqiao).toEqual({ apiVersion: 1, module: "./dist/index.js", manifest: GIT_EXTENSION_MANIFEST });
  });
});
