import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const [tarballArg, infoArg] = process.argv.slice(2);
if (!tarballArg || !infoArg) throw new Error("usage: node npm-registry.mjs <tarball> <info-file>");
const tarballPath = path.resolve(tarballArg);
const infoPath = path.resolve(infoArg);
const root = path.dirname(tarballPath);
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const tarball = await readFile(tarballPath);
const shasum = createHash("sha1").update(tarball).digest("hex");
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://registry.local");
  if (url.pathname === "/shutdown") {
    res.end("ok");
    setImmediate(() => server.close());
    return;
  }

  let requestedPackage = "";
  try { requestedPackage = decodeURIComponent(url.pathname.slice(1)); } catch {}
  if (requestedPackage === pkg.name) {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("registry listener unavailable");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      name: pkg.name,
      "dist-tags": { latest: pkg.version },
      versions: {
        [pkg.version]: {
          ...pkg,
          dist: {
            shasum,
            integrity,
            tarball: `http://127.0.0.1:${address.port}/package.tgz`,
          },
        },
      },
    }));
    return;
  }

  if (url.pathname === "/package.tgz") {
    res.setHeader("content-type", "application/octet-stream");
    res.end(tarball);
    return;
  }

  try {
    const upstream = await fetch(`https://registry.npmjs.org${url.pathname}${url.search}`, {
      headers: { accept: req.headers.accept ?? "application/json" },
    });
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, name) => {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(name.toLowerCase())) res.setHeader(name, value);
    });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    res.statusCode = 502;
    res.end(error instanceof Error ? error.message : String(error));
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Expected TCP listener");
const registry = `http://127.0.0.1:${address.port}`;
await writeFile(infoPath, JSON.stringify({ registry, pid: process.pid }), "utf8");
console.log(registry);
