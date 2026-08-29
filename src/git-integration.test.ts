import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@tibame201020/queqiao/extension";
import { queqiaoExtension, type GitToolContext } from "./index.js";

const exec = promisify(execFile);
let temporary: string | undefined;
let external: string | undefined;

afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  if (external) await rm(external, { recursive: true, force: true });
  temporary = undefined;
  external = undefined;
});

async function git(cwd: string, args: string[]) {
  return exec("git", args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

async function initializeRepo(root: string) {
  await mkdir(root, { recursive: true });
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "queqiao-extension-test@example.invalid"]);
  await git(root, ["config", "user.name", "Queqiao Extension Test"]);
  await writeFile(path.join(root, "README.md"), "initial\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
}

function isContained(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

class TestCapabilities {
  constructor(private readonly root: string) {}

  private async existing(pathValue: string) {
    const candidate = path.isAbsolute(pathValue) ? path.resolve(pathValue) : path.resolve(this.root, pathValue);
    const resolved = await realpath(candidate);
    if (!isContained(this.root, resolved)) throw new Error("path escapes the workspace");
    return resolved;
  }

  async listDirectory(pathValue: string, depth: number, limit: number) {
    const start = await this.existing(pathValue);
    const entries: Array<{ path: string; name: string; type: string }> = [];
    let truncated = false;
    const visit = async (absolute: string, remaining: number): Promise<void> => {
      if (entries.length >= limit) { truncated = true; return; }
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (entries.length >= limit) { truncated = true; return; }
        const child = path.join(absolute, entry.name);
        const relative = path.relative(this.root, child).split(path.sep).join("/") || ".";
        const stat = await lstat(child);
        const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
        entries.push({ path: relative, name: entry.name, type });
        if (remaining > 1 && stat.isDirectory() && !stat.isSymbolicLink()) await visit(child, remaining - 1);
      }
    };
    await visit(start, depth);
    return { entries, truncated };
  }

  resolveExecutionDirectory(pathValue: string) { return this.existing(pathValue); }
  assertExecutionPathContained(pathValue: string) { return this.existing(pathValue); }

  async relativeExecutionPath(pathValue: string) {
    const resolved = await this.existing(pathValue);
    return path.relative(this.root, resolved).split(path.sep).join("/") || ".";
  }

  async resolveNewDirectoryTarget(pathValue: string) {
    const candidate = path.isAbsolute(pathValue) ? path.resolve(pathValue) : path.resolve(this.root, pathValue);
    if (!isContained(this.root, candidate)) throw new Error("path escapes the workspace");
    const parent = await realpath(path.dirname(candidate));
    if (!isContained(this.root, parent)) throw new Error("path escapes the workspace");
    const stat = await lstat(parent);
    if (!stat.isDirectory()) throw new Error("target parent is not a directory");
    return path.join(parent, path.basename(candidate));
  }

  async run(input: { executable: string; args: readonly string[]; cwd: string; timeoutMs: number; mode: "sync" | "async" }) {
    if (input.executable !== "git" || input.mode !== "sync") throw new Error("test capability only permits synchronous git");
    const cwd = await this.existing(input.cwd);
    try {
      const result = await exec("git", [...input.args], { cwd, windowsHide: true, timeout: input.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false, aborted: false, outputLimitExceeded: false };
    } catch (error) {
      const value = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      return {
        exitCode: typeof value.code === "number" ? value.code : 1,
        stdout: value.stdout ?? "",
        stderr: value.stderr ?? value.message,
        timedOut: Boolean(value.killed),
        aborted: false,
        outputLimitExceeded: false,
      };
    }
  }
}

function definitions() {
  const tools = new Map<string, ToolDefinition<GitToolContext>>();
  queqiaoExtension.activate({
    registerTool(definition) { tools.set(definition.name, definition); },
    extendTool() { throw new Error("unexpected extendTool"); },
    replaceTool() { throw new Error("unexpected replaceTool"); },
  });
  return tools;
}

async function invoke(tools: Map<string, ToolDefinition<GitToolContext>>, name: string, input: unknown, context: GitToolContext) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  const parsed = tool.inputSchema.parse(input);
  return tool.execute(parsed, context) as Promise<any>;
}

describe("standalone Git extension", () => {
  it("discovers, reads, creates, and removes contained repositories with real Git", async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "queqiao-extension-git-")));
    const repo = path.join(temporary, "repo");
    await initializeRepo(repo);
    await mkdir(path.join(temporary, "worktrees"));
    const context: GitToolContext = { workspaceId: "git-e2e-workspace", capabilities: new TestCapabilities(temporary) };
    const tools = definitions();

    const discovered = await invoke(tools, "git_repositories", { workspaceId: context.workspaceId, path: ".", depth: 3 }, context);
    expect(discovered.repositories).toEqual(expect.arrayContaining([expect.objectContaining({ path: "repo", kind: "repository" })]));

    const status = await invoke(tools, "git_status", { workspaceId: context.workspaceId, repositoryPath: "repo" }, context);
    expect(status.repositoryPath).toBe("repo");

    const branches = await invoke(tools, "git_branches", { workspaceId: context.workspaceId, repositoryPath: "repo" }, context);
    expect(branches.branches.some((entry: { current: boolean }) => entry.current)).toBe(true);

    const log = await invoke(tools, "git_log", { workspaceId: context.workspaceId, repositoryPath: "repo", limit: 5 }, context);
    expect(log.commits[0].subject).toBe("initial");

    await writeFile(path.join(repo, "README.md"), "initial\nchanged\n", "utf8");
    const diff = await invoke(tools, "git_diff", { workspaceId: context.workspaceId, repositoryPath: "repo" }, context);
    expect(diff.diff).toContain("+changed");

    await expect(invoke(tools, "git_worktree_create", {
      workspaceId: context.workspaceId,
      repositoryPath: "repo",
      targetPath: "../escape",
      ref: "HEAD",
      newBranch: "escape-test",
    }, context)).rejects.toThrow(/escapes the workspace/);

    await expect(invoke(tools, "git_worktree_create", {
      workspaceId: context.workspaceId,
      repositoryPath: "repo",
      targetPath: "worktrees/failed",
      ref: "missing-ref",
      newBranch: "failed-test",
    }, context)).rejects.toThrow(/git worktree add failed/);

    const created = await invoke(tools, "git_worktree_create", {
      workspaceId: context.workspaceId,
      repositoryPath: "repo",
      targetPath: "worktrees/feature",
      ref: "HEAD",
      newBranch: "feature-test",
    }, context);
    expect(created.targetPath).toBe("worktrees/feature");

    const worktreeStatus = await invoke(tools, "git_status", { workspaceId: context.workspaceId, repositoryPath: "worktrees/feature" }, context);
    expect(worktreeStatus.repositoryPath).toBe("worktrees/feature");

    const removed = await invoke(tools, "git_worktree_remove", {
      workspaceId: context.workspaceId,
      repositoryPath: "repo",
      targetPath: "worktrees/feature",
    }, context);
    expect(removed.removed).toBe("worktrees/feature");
  });

  it("rejects a worktree whose Git common directory is outside the authorized Workspace", async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "queqiao-extension-contained-")));
    external = await realpath(await mkdtemp(path.join(os.tmpdir(), "queqiao-extension-external-")));
    await initializeRepo(external);
    const backed = path.join(temporary, "external-backed");
    await git(external, ["worktree", "add", "-b", "external-backed-test", backed, "HEAD"]);

    const context: GitToolContext = { workspaceId: "git-e2e-workspace", capabilities: new TestCapabilities(temporary) };
    await expect(invoke(definitions(), "git_status", {
      workspaceId: context.workspaceId,
      repositoryPath: "external-backed",
    }, context)).rejects.toThrow(/escapes the workspace/);
  });
});
