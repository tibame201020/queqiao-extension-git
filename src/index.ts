import { z } from "zod";
import type { ExtensionManifestConfig, QueqiaoExtension, ToolDefinition } from "@tibame201020/queqiao/extension";
type ProcessExecutionMode = "sync" | "async";


const EXTENSION_ID = "dev.queqiao.git";
const EXTENSION_VERSION = "1.0.0";
const MAX_GIT_TIMEOUT_MS = 30_000;
const refSchema = z.string().min(1).max(256).regex(/^(?!-)[A-Za-z0-9._/@{}~^:+-]+$/, "invalid Git ref");
const pathSchema = z.string().min(1).max(4096);
const workspaceSchema = z.string().min(1).max(64);
const repositorySchema = z.object({ workspaceId: workspaceSchema, repositoryPath: pathSchema });

type GitProcessResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; outputLimitExceeded: boolean };
type GitCapabilities = {
  listDirectory(path: string, depth: number, limit: number, cursor: string | undefined, includeHidden: boolean): Promise<{ entries: Array<{ path: string; name: string; type: string }>; truncated: boolean }>;
  resolveExecutionDirectory(path: string): Promise<string>;
  assertExecutionPathContained(path: string): Promise<string>;
  relativeExecutionPath(path: string): Promise<string>;
  resolveNewDirectoryTarget(path: string): Promise<string>;
  run(input: { executable: string; args: readonly string[]; cwd: string; timeoutMs: number; mode: ProcessExecutionMode }): Promise<unknown>;
};
export type GitToolContext = { workspaceId: string; capabilities: GitCapabilities; signal?: AbortSignal };

function processResult(value: unknown): GitProcessResult {
  if (!value || typeof value !== "object") throw new Error("Git process returned an invalid result");
  return value as GitProcessResult;
}
async function runGit(context: GitToolContext, cwd: string, args: readonly string[], timeoutMs = MAX_GIT_TIMEOUT_MS): Promise<GitProcessResult> {
  await context.capabilities.resolveExecutionDirectory(cwd);
  return processResult(await context.capabilities.run({ executable: "git", args, cwd, timeoutMs, mode: "sync" }));
}
function successful(result: GitProcessResult, operation: string): GitProcessResult {
  if (result.timedOut) throw new Error(`${operation} timed out`);
  if (result.aborted) throw new Error(`${operation} was aborted`);
  if (result.outputLimitExceeded) throw new Error(`${operation} exceeded the bounded output limit`);
  if (result.exitCode !== 0) throw new Error(`${operation} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  return result;
}
type RepositoryIdentity = { path: string; topLevel: string; gitDir: string; commonDir: string };
async function repositoryIdentity(context: GitToolContext, repositoryPath: string): Promise<RepositoryIdentity> {
  const meta = successful(await runGit(context, repositoryPath, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]), "git rev-parse");
  const lines = meta.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 3) throw new Error("Git repository metadata is incomplete");
  const topLevel = await context.capabilities.assertExecutionPathContained(lines[0]!);
  const gitDir = await context.capabilities.assertExecutionPathContained(lines[1]!);
  const commonDir = await context.capabilities.assertExecutionPathContained(lines[2]!);
  const relative = await context.capabilities.relativeExecutionPath(topLevel);
  return { path: relative, topLevel, gitDir, commonDir };
}
function lines(value: string): string[] { return value.split(/\r?\n/).filter(Boolean); }

const definitions: readonly ToolDefinition<GitToolContext>[] = [
  {
    name: "git_repositories", title: "Discover Git repositories", description: "Discover bounded Git repositories and contained worktrees inside one authorized Workspace.",
    inputSchema: z.object({ workspaceId: workspaceSchema, path: pathSchema.default("."), depth: z.number().int().min(1).max(5).default(4), limit: z.number().int().min(1).max(100).default(50) }),
    requiredCapabilities: ["workspace:read", "workspace:exec"], risk: "read",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    async execute(input, context) {
      const { path, depth, limit } = input as { workspaceId: string; path: string; depth: number; limit: number };
      const listed = await context.capabilities.listDirectory(path, depth, 1000, undefined, true);
      const candidates = listed.entries.filter((entry) => entry.name === ".git").map((entry) => ({ marker: entry, parent: entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) || "." : "." }));
      const found = new Map<string, { path: string; kind: "repository" | "worktree"; branch: string | null }>();
      for (const candidate of candidates) {
        if (found.size >= limit) break;
        try {
          const identity = await repositoryIdentity(context, candidate.parent);
          const branch = successful(await runGit(context, candidate.parent, ["branch", "--show-current"]), "git branch").stdout.trim() || null;
          found.set(identity.path, { path: identity.path, kind: candidate.marker.type === "file" ? "worktree" : "repository", branch });
        } catch { /* invalid or externally-backed repository markers are not disclosed */ }
      }
      return { workspaceId: context.workspaceId, repositories: [...found.values()].sort((a, b) => a.path.localeCompare(b.path)), truncated: listed.truncated || candidates.length > found.size && found.size >= limit };
    },
  },
  {
    name: "git_status", title: "Git status", description: "Read bounded porcelain-v2 status for a contained Git repository or worktree.",
    inputSchema: repositorySchema, requiredCapabilities: ["workspace:exec"], risk: "read",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    async execute(input, context) { const { repositoryPath } = input as { workspaceId: string; repositoryPath: string }; const identity = await repositoryIdentity(context, repositoryPath); const out = successful(await runGit(context, repositoryPath, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]), "git status"); return { repositoryPath: identity.path, status: out.stdout }; },
  },
  {
    name: "git_diff", title: "Git diff", description: "Read a bounded Git diff from a contained repository without external diff helpers.",
    inputSchema: repositorySchema.extend({ staged: z.boolean().default(false), contextLines: z.number().int().min(0).max(20).default(3), paths: z.array(pathSchema).max(32).default([]) }), requiredCapabilities: ["workspace:exec"], risk: "read",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    async execute(input, context) { const { repositoryPath, staged, contextLines, paths } = input as { workspaceId: string; repositoryPath: string; staged: boolean; contextLines: number; paths: string[] }; const identity = await repositoryIdentity(context, repositoryPath); const args = ["diff", "--no-ext-diff", `--unified=${contextLines}`, ...(staged ? ["--cached"] : []), "--", ...paths]; const out = processResult(await runGit(context, repositoryPath, args)); if (out.timedOut || out.aborted) throw new Error("git diff did not complete"); if (out.exitCode !== 0) throw new Error(`git diff failed: ${out.stderr.trim()}`); return { repositoryPath: identity.path, diff: out.stdout, truncated: out.outputLimitExceeded }; },
  },
  {
    name: "git_log", title: "Git log", description: "Read bounded commit metadata from a contained Git repository.",
    inputSchema: repositorySchema.extend({ ref: refSchema.default("HEAD"), limit: z.number().int().min(1).max(100).default(20) }), requiredCapabilities: ["workspace:exec"], risk: "read",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    async execute(input, context) { const { repositoryPath, ref, limit } = input as { workspaceId: string; repositoryPath: string; ref: string; limit: number }; const identity = await repositoryIdentity(context, repositoryPath); const out = successful(await runGit(context, repositoryPath, ["log", `--max-count=${limit}`, "--date=iso-strict", "--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s", "--end-of-options", ref]), "git log"); return { repositoryPath: identity.path, commits: lines(out.stdout).map((line) => { const [hash, shortHash, author, authoredAt, subject] = line.split("\0"); return { hash, shortHash, author, authoredAt, subject }; }) }; },
  },
  {
    name: "git_branches", title: "Git branches", description: "List bounded local branches for a contained Git repository.",
    inputSchema: repositorySchema.extend({ limit: z.number().int().min(1).max(200).default(100) }), requiredCapabilities: ["workspace:exec"], risk: "read",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    async execute(input, context) { const { repositoryPath, limit } = input as { workspaceId: string; repositoryPath: string; limit: number }; const identity = await repositoryIdentity(context, repositoryPath); const out = successful(await runGit(context, repositoryPath, ["for-each-ref", `--count=${limit}`, "--format=%(refname:short)%00%(objectname:short)%00%(HEAD)", "refs/heads/"]), "git for-each-ref"); return { repositoryPath: identity.path, branches: lines(out.stdout).map((line) => { const [name, object, head] = line.split("\0"); return { name, object, current: head === "*" }; }) }; },
  },
  {
    name: "git_worktree_create", title: "Create Git worktree", description: "Create one contained Git worktree under an authorized coding Workspace.",
    inputSchema: repositorySchema.extend({ targetPath: pathSchema, ref: refSchema.default("HEAD"), newBranch: refSchema.optional() }), requiredCapabilities: ["workspace:read", "workspace:write", "workspace:exec"], risk: "write",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    async execute(input, context) { const { repositoryPath, targetPath, ref, newBranch } = input as { workspaceId: string; repositoryPath: string; targetPath: string; ref: string; newBranch?: string }; const source = await repositoryIdentity(context, repositoryPath); const target = await context.capabilities.resolveNewDirectoryTarget(targetPath); const args = ["worktree", "add", ...(newBranch ? ["-b", newBranch] : []), target, ref]; successful(await runGit(context, repositoryPath, args), "git worktree add"); try { const created = await repositoryIdentity(context, targetPath); if (created.commonDir !== source.commonDir) throw new Error("Created worktree does not belong to the source repository"); return { repositoryPath: source.path, targetPath: created.path, branch: newBranch ?? null, ref }; } catch (error) { await runGit(context, repositoryPath, ["worktree", "remove", "--force", target]).catch(() => undefined); throw error; } },
  },
  {
    name: "git_worktree_remove", title: "Remove Git worktree", description: "Remove one contained Git worktree belonging to the selected repository.",
    inputSchema: repositorySchema.extend({ targetPath: pathSchema, force: z.boolean().default(false) }), requiredCapabilities: ["workspace:read", "workspace:write", "workspace:exec"], risk: "write",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
    async execute(input, context) { const { repositoryPath, targetPath, force } = input as { workspaceId: string; repositoryPath: string; targetPath: string; force: boolean }; const source = await repositoryIdentity(context, repositoryPath); const target = await repositoryIdentity(context, targetPath); if (target.commonDir !== source.commonDir) throw new Error("Target worktree does not belong to the selected repository"); const absolute = await context.capabilities.assertExecutionPathContained(target.topLevel); successful(await runGit(context, repositoryPath, ["worktree", "remove", ...(force ? ["--force"] : []), absolute]), "git worktree remove"); return { repositoryPath: source.path, removed: target.path, force }; },
  },
] as const;

function manifestContribution(definition: ToolDefinition<GitToolContext>) {
  return {
    operation: "register" as const, tool: definition.name, visibility: "public" as const,
    title: definition.title, description: definition.description,
    inputSchema: z.toJSONSchema(definition.inputSchema, { io: "input" }) as Extract<ExtensionManifestConfig["contributions"][number], { operation: "register" }>["inputSchema"],
    requiredCapabilities: [...definition.requiredCapabilities], risk: definition.risk, annotations: definition.annotations,
  };
}

export const GIT_EXTENSION_MANIFEST: ExtensionManifestConfig = {
  id: EXTENSION_ID, version: EXTENSION_VERSION, displayName: "Queqiao Git",
  host: { kind: "worker" }, ordering: { requires: [], before: [], after: [] },
  contributions: definitions.map(manifestContribution),
};

export const queqiaoExtension: QueqiaoExtension<GitToolContext> = {
  manifest: { id: EXTENSION_ID, version: EXTENSION_VERSION, displayName: "Queqiao Git", supportedEnvironments: ["windows", "linux", "darwin"] },
  activate(api) { for (const definition of definitions) api.registerTool(definition); },
};
export default queqiaoExtension;
