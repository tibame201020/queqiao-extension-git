import path from "node:path";
import { pathToFileURL } from "node:url";

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const core = path.resolve(required("core", process.argv[2]));
const workerPort = Number(required("workerPort", process.argv[3]));
const gatewayPort = Number(required("gatewayPort", process.argv[4]));
const managementPort = Number(required("managementPort", process.argv[5]));
const workspaceRoot = path.resolve(required("workspaceRoot", process.argv[6]));

for (const [label, port] of [["workerPort", workerPort], ["gatewayPort", gatewayPort], ["managementPort", managementPort]] as const) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} must be a valid TCP port`);
}

const importFromCore = (relative: string) => import(pathToFileURL(path.join(core, relative)).href);
const [{ setupGateway, setupWorker }, { resolveRuntimeLayoutForNamedRole }, { workspaceConfigFromAnswers }] = await Promise.all([
  importFromCore("apps/cli/src/enrollment-cli.ts"),
  importFromCore("packages/platform-paths/src/index.ts"),
  importFromCore("apps/cli/src/workspace-cli.ts"),
]);

const workerName = "git-e2e";
const gatewayName = "git-e2e-gateway";
const workerLayout = resolveRuntimeLayoutForNamedRole("worker", workerName, process.env, process.platform);
const gatewayLayout = resolveRuntimeLayoutForNamedRole("gateway", gatewayName, process.env, process.platform);
const initialWorkspace = {
  ...workspaceConfigFromAnswers({
    root: workspaceRoot,
    displayName: "Git E2E Workspace",
    profile: "coding",
  }),
  commands: { allow: ["git"] },
};

await setupWorker(
  workerLayout.configFile,
  ["--environment-id", process.platform === "win32" ? "windows" : "linux", "--port", String(workerPort)],
  workerLayout.secretsDir,
  undefined,
  { initialWorkspace },
);

await setupGateway(
  gatewayLayout.configFile,
  [
    "--public-base-url", `http://127.0.0.1:${gatewayPort}/`,
    "--port", String(gatewayPort),
    "--management-port", String(managementPort),
  ],
  gatewayLayout.gatewayStateDir,
  gatewayLayout.secretsDir,
);

process.stdout.write(JSON.stringify({
  workerName,
  gatewayName,
  workspaceId: initialWorkspace.id,
  workerConfig: workerLayout.configFile,
  gatewayConfig: gatewayLayout.configFile,
}));
