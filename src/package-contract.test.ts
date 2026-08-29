import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GIT_EXTENSION_MANIFEST } from "./index.js";

const packageFile = path.resolve(import.meta.dirname, "../package.json");

type PackageJson = {
  name: string;
  version: string;
  private?: boolean;
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  queqiao?: { apiVersion?: number; module?: string; manifest?: unknown };
};

describe("Git extension npm package contract", () => {
  it("is an independently publishable first-party Queqiao extension", async () => {
    const pkg = JSON.parse(await readFile(packageFile, "utf8")) as PackageJson;

    expect(pkg.name).toBe("@tibame201020/queqiao-extension-git");
    expect(pkg.private).toBe(false);
    expect(pkg.version).toBe(GIT_EXTENSION_MANIFEST.version);
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
    expect(pkg.files).toEqual(expect.arrayContaining(["dist/", "README.md", "LICENSE"]));
    expect(pkg.dependencies).toEqual({ zod: "4.4.3" });
    expect(pkg.devDependencies?.["@tibame201020/queqiao"]).toBe("0.8.1");
    expect(pkg.devDependencies?.["@tibame201020/queqiao"]).not.toMatch(/^file:/);
    expect(Object.keys(pkg.dependencies ?? {}).some((name) => name.includes("queqiao"))).toBe(false);
    expect(pkg.engines?.node).toBe(">=22.19 <25");
    expect(pkg.queqiao).toEqual({ apiVersion: 1, module: "./dist/index.js", manifest: GIT_EXTENSION_MANIFEST });
  });
});
