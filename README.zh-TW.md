# Queqiao Git Extension

[English](https://github.com/tibame201020/queqiao-extension-git/blob/main/README.md) | [繁體中文](https://github.com/tibame201020/queqiao-extension-git/blob/main/README.zh-TW.md)

[Queqiao](https://github.com/tibame201020/Queqiao) 的第一方 Git extension。

npm package 為 `@tibame201020/queqiao-extension-git`，穩定的 Queqiao extension identity 為 `dev.queqiao.git`。

## 需求

- Queqiao `0.8.1` 或更新版本，並支援 Extension API v1
- Node.js `>=22.19 <25`
- Worker host 上可使用 Git
- 已授權的 Queqiao Workspace

Git process execution 仍由 Worker authoritative 控制。會呼叫 Git 的 read operations 需要 `coding` Workspace，且 Workspace command allowlist 必須包含 `git`。Worktree create/remove 另外需要其 tool contract 宣告的 Workspace write capabilities。

## 安裝

安裝到 Extension Hub，並 attach 一個 Worker：

```bash
queqiao extension install npm:@tibame201020/queqiao-extension-git --worker <worker>
```

或先安裝，再於之後 attach：

```bash
queqiao extension install npm:@tibame201020/queqiao-extension-git
queqiao extension attach dev.queqiao.git --worker <worker>
```

Queqiao 將 `attach` 視為 activation。Extension 不會因 repository 內容而被隱式啟用。

## Invocation modes

一般 Extension Hub install/attach 會使用 Queqiao Revision 7 固定的公開 `extension` proxy。這讓 Core connector schema 維持穩定，同時由選定的 Worker discover 並 invoke `dev.queqiao.git` capabilities。

此 package 也把七個 capabilities 宣告為 public contributions，可供 Queqiao 的 advanced deployment-manifest composition 使用。選擇直接投影 named tools 會改變 Deployment Manifest Fingerprint，並可能需要 connector schema migration；單純 Worker attachment 不會改寫 Gateway 的公開 schema，這是刻意設計。

## Tools

此 extension 提供七個有邊界的 Worker-hosted capabilities：

- `git_repositories` — 在單一已授權 Workspace 內 discover contained repositories 與 worktrees
- `git_status` — 讀取 porcelain-v2 status
- `git_diff` — 讀取有界限的 diff，並停用 external diff helpers
- `git_log` — 讀取有界限的 commit metadata
- `git_branches` — 列出有界限的 local branches
- `git_worktree_create` — 建立 target 仍位於所選 Workspace 內的 worktree
- `git_worktree_remove` — 移除屬於所選 repository 的 contained worktree

Repository 與 worktree identity 屬於 extension-owned resource semantics。Queqiao Core Workspace identity 仍是 filesystem/process authority boundary。

## Security model

此 extension 不會執行任意 shell。Git invocation 會經過 Worker capability API，使用 executable `git`、bounded arguments、timeout handling、Workspace command policy，以及由 Queqiao 強制執行的 path containment。

`git rev-parse` 回傳的 repository metadata 會再對已授權 Workspace 進行檢查。Externally backed worktrees、escaping paths，以及 Workspace 外的 worktree targets 都會被拒絕，而不是擴張 authority。

此 package 在 runtime 不依賴 Queqiao 本身。`@tibame201020/queqiao` 僅作為 development-time TypeScript contract；打包後 runtime 只依賴 `zod`。

## 開發

```bash
npm ci
npm run check
npm audit --omit=dev --audit-level=moderate
npm pack --ignore-scripts --dry-run
```

Test suite 會在 Windows 與 Linux 上使用真實 temporary Git repositories 與 worktrees。Release acceptance 另外會把 packed extension 安裝到 temporary Queqiao Extension Hub，並針對 Queqiao `0.8.1` 從 public MCP endpoint 實際呼叫。

## 授權

MIT
