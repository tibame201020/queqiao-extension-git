# Queqiao Git Extension

First-party Git extension for Queqiao. Runtime identity remains `dev.queqiao.git`.

## Development

```powershell
npm install
npm run build
npm test
```

The package is intentionally usable as a local Queqiao extension:

```powershell
queqiao extension install C:\code\queqiao-extension-git --worker wins-worker
```

Queqiao records the canonical local package path and does not copy or delete this source directory. After changing source code, rebuild and then detach/attach the extension (or restart the Worker) to load the new module.

## SDK dependency during current development

The current checkout uses `@tibame201020/queqiao` through `file:../Queqiao` as a **development-only type dependency** because the published `0.7.0` package predates the public `/extension` export. Runtime dependencies remain limited to `zod`.

After the next Queqiao package release includes `@tibame201020/queqiao/extension`, replace the file development link with the corresponding released semver range.

## Package contract

`package.json` contains the Queqiao package metadata used by the Extension Hub:

- API version: `1`
- module: `./dist/index.js`
- extension id: `dev.queqiao.git`
- host: Worker
- manifest version must equal package version

The Extension Hub validates this metadata and the built module before registration.
