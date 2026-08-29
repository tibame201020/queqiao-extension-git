# Queqiao Git Extension

First-party Git extension for [Queqiao](https://github.com/tibame201020/Queqiao).

The npm package is `@tibame201020/queqiao-extension-git`. Its stable Queqiao extension identity is `dev.queqiao.git`.

## Requirements

- Queqiao `0.8.1` or newer with Extension API v1
- Node.js `>=22.19 <25`
- Git available on the Worker host
- an authorized Queqiao Workspace

Git process execution remains Worker-authoritative. Read operations that invoke Git require a `coding` Workspace with `git` in the Workspace command allowlist. Worktree create/remove additionally require the Workspace write capabilities declared by their tool contracts.

## Install

Install into the Extension Hub and attach one Worker:

```bash
queqiao extension install npm:@tibame201020/queqiao-extension-git --worker <worker>
```

Or install first and attach later:

```bash
queqiao extension install npm:@tibame201020/queqiao-extension-git
queqiao extension attach dev.queqiao.git --worker <worker>
```

Queqiao treats `attach` as activation. The extension is never enabled implicitly by repository contents.

## Invocation modes

Normal Extension Hub install/attach uses Queqiao Revision 7's fixed public `extension` proxy. This keeps the Core connector schema stable while the selected Worker discovers and invokes `dev.queqiao.git` capabilities.

The package also declares its seven capabilities as public contributions for Queqiao's advanced deployment-manifest composition. Opting into direct named-tool projection changes the Deployment Manifest Fingerprint and may require a connector schema migration; Worker attachment alone intentionally does not rewrite the Gateway's public schema.

## Tools

The extension contributes seven bounded Worker-hosted capabilities:

- `git_repositories` — discover contained repositories and worktrees inside one authorized Workspace
- `git_status` — read porcelain-v2 status
- `git_diff` — read a bounded diff with external diff helpers disabled
- `git_log` — read bounded commit metadata
- `git_branches` — list bounded local branches
- `git_worktree_create` — create a worktree whose target remains inside the selected Workspace
- `git_worktree_remove` — remove a contained worktree belonging to the selected repository

Repository and worktree identity is extension-owned resource semantics. Queqiao Core Workspace identity remains the filesystem/process authority boundary.

## Security model

The extension does not execute an arbitrary shell. Git invocations go through the Worker capability API with executable `git`, bounded arguments, timeout handling, Workspace command policy, and path containment enforced by Queqiao.

Repository metadata returned by `git rev-parse` is checked against the authorized Workspace. Externally backed worktrees, escaping paths, and worktree targets outside the Workspace are rejected rather than expanding authority.

The package has no runtime dependency on Queqiao itself. `@tibame201020/queqiao` is used only as a development-time TypeScript contract; the packed runtime depends only on `zod`.

## Development

```bash
npm ci
npm run check
npm audit --omit=dev --audit-level=moderate
npm pack --ignore-scripts --dry-run
```

The test suite uses real temporary Git repositories and worktrees on Windows and Linux. Release acceptance additionally installs the packed extension through a temporary Queqiao Extension Hub and calls it over the public MCP endpoint against Queqiao `0.8.1`.

## License

MIT
