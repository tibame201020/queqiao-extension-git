import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const gateway = new URL(process.env.QUEQIAO_E2E_GATEWAY ?? "http://127.0.0.1:1477/");
const resource = new URL("mcp", gateway).href;
const approvalFile = process.env.QUEQIAO_E2E_APPROVAL_FILE;
const workspaceId = process.env.QUEQIAO_E2E_WORKSPACE_ID ?? "git-e2e-workspace";
if (!approvalFile) throw new Error("QUEQIAO_E2E_APPROVAL_FILE is required");
const approvalSecret = (await readFile(approvalFile, "utf8")).trim();
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const scope = "queqiao:access";

const registeredResponse = await fetch(new URL("oauth/register", gateway), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "queqiao-extension-git acceptance",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    scope,
  }),
});
if (!registeredResponse.ok) throw new Error(`OAuth register failed: ${registeredResponse.status} ${await registeredResponse.text()}`);
const registered = await registeredResponse.json();
const verifier = randomBytes(40).toString("base64url");
const authorization = {
  client_id: registered.client_id,
  redirect_uri: redirectUri,
  response_type: "code",
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
  scope,
  resource,
  state: "queqiao-extension-git-e2e",
};
const authorizeUrl = new URL("oauth/authorize", gateway);
for (const [key, value] of Object.entries(authorization)) authorizeUrl.searchParams.set(key, String(value));
const authorizationPage = await fetch(authorizeUrl);
if (!authorizationPage.ok) throw new Error(`OAuth authorize page failed: ${authorizationPage.status}`);

const approved = await fetch(new URL("oauth/authorize", gateway), {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ...authorization, approval_secret: approvalSecret }),
  redirect: "manual",
});
if (approved.status !== 303) throw new Error(`OAuth approval failed: ${approved.status} ${await approved.text()}`);
const location = approved.headers.get("location");
if (!location) throw new Error("OAuth approval did not return a redirect");
const code = new URL(location).searchParams.get("code");
if (!code) throw new Error("OAuth approval did not return a code");

const tokenResponse = await fetch(new URL("oauth/token", gateway), {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: registered.client_id,
    code_verifier: verifier,
    resource,
  }),
});
if (!tokenResponse.ok) throw new Error(`OAuth token failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
const token = await tokenResponse.json();

const client = new Client({ name: "queqiao-extension-git-acceptance", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(resource), {
  requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "extension")) throw new Error("Queqiao public extension proxy is missing");

  const described = await client.callTool({
    name: "extension",
    arguments: {
      workspaceId,
      operation: "describe",
      extensionId: "dev.queqiao.git",
      capability: "git_status",
      arguments: {},
      limit: 20,
    },
  });
  if (described.isError === true) throw new Error(`extension describe returned MCP error: ${JSON.stringify(described.content)}`);

  const result = await client.callTool({
    name: "extension",
    arguments: {
      workspaceId,
      operation: "call",
      extensionId: "dev.queqiao.git",
      capability: "git_status",
      arguments: { repositoryPath: "repo" },
      limit: 20,
    },
  });
  if (result.isError === true) throw new Error(`git_status proxy call returned MCP error: ${JSON.stringify(result.content)}`);
  const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
  if (!text.includes("repo")) throw new Error(`git_status proxy result was unexpected: ${text}`);

  console.log(JSON.stringify({
    ok: true,
    package: "@tibame201020/queqiao-extension-git",
    publicTool: "extension",
    extensionId: "dev.queqiao.git",
    capability: "git_status",
    workspaceId,
    repositoryPath: "repo",
  }));
} finally {
  await client.close().catch(() => undefined);
}
