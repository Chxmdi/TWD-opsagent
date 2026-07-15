import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const appPort = 8796;
const base = `http://127.0.0.1:${appPort}`;
const email = "operator@wealthdojo.test";
const password = "correct-horse-battery-staple";
const cronSecret = "production-smoke-cron-secret-32-characters";
const root = mkdtempSync(join(tmpdir(), "wealth-dojo-production-"));
const dbPath = join(root, "operations.db");
const backupDir = join(root, "backups");

const app = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(appPort),
    DB_PATH: dbPath,
    BACKUP_DIR: backupDir,
    SCHEDULER: "off",
    PUBLIC_BASE_URL: base,
    MCP_RESOURCE_URL: base,
    SINGLE_USER_EMAIL: email,
    SINGLE_USER_PASSWORD: password,
    OAUTH_SIGNING_SECRET: "production-smoke-signing-secret-32-characters",
    CRON_SECRET: cronSecret
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
app.stderr.on("data", (chunk) => { stderr += chunk; });
app.stdout.resume();

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await fetch(`${base}/health`);
      if (health.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production server did not start: ${stderr}`);
}

function stop(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

function firstCookie(response, name) {
  const value = response.headers.get("set-cookie") || "";
  return value.match(new RegExp(`${name}=[^;]+`))?.[0] || "";
}

function hidden(html, name) {
  return html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] || "";
}

async function registerClient() {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Production smoke client",
      redirect_uris: ["https://chatgpt.example/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function authorize(client, scope) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: base,
    scope,
    state: randomBytes(12).toString("base64url")
  });
  const prompt = await fetch(`${base}/oauth/authorize?${params}`);
  assert.equal(prompt.status, 200);
  const page = await prompt.text();
  const csrfCookie = firstCookie(prompt, "wd_oauth_csrf");
  const csrf = hidden(page, "csrf");
  assert.ok(csrfCookie && csrf);
  const approval = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: base,
      scope,
      state: params.get("state"),
      email,
      password,
      action: "allow"
    })
  });
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.origin, "https://chatgpt.example");
  assert.equal(callback.searchParams.get("state"), params.get("state"));
  assert.equal(callback.searchParams.get("iss"), base);
  const code = callback.searchParams.get("code");
  assert.ok(code);
  const tokenResponse = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code,
      code_verifier: verifier,
      resource: base
    })
  });
  assert.equal(tokenResponse.status, 200);
  return tokenResponse.json();
}

try {
  await waitForServer();

  const resourceResponse = await fetch(`${base}/.well-known/oauth-protected-resource`);
  assert.equal(resourceResponse.status, 200);
  const resource = await resourceResponse.json();
  assert.equal(resource.resource, base);
  assert.deepEqual(resource.authorization_servers, [base]);
  assert.deepEqual(resource.scopes_supported, ["operations:read", "operations:write"]);

  const serverMetadata = await fetch(`${base}/.well-known/oauth-authorization-server`).then((response) => response.json());
  assert.equal(serverMetadata.issuer, base);
  assert.equal(serverMetadata.registration_endpoint, `${base}/oauth/register`);
  assert.deepEqual(serverMetadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(serverMetadata.token_endpoint_auth_methods_supported, ["none"]);

  const deniedMcp = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(deniedMcp.status, 401);
  assert.match(deniedMcp.headers.get("www-authenticate"), /oauth-protected-resource/);

  const dashboardDenied = await fetch(`${base}/api/state`, { redirect: "manual" });
  assert.equal(dashboardDenied.status, 401);
  assert.equal(dashboardDenied.headers.get("x-auth-mode"), "single-user");

  const login = await fetch(`${base}/auth/login?returnTo=/`);
  assert.equal(login.status, 200);
  const loginPage = await login.text();
  const loginCsrf = hidden(loginPage, "csrf");
  const loginCookie = firstCookie(login, "wd_login_csrf");
  const loggedIn = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: loginCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: loginCsrf, returnTo: "/", email, password })
  });
  assert.equal(loggedIn.status, 302);
  const sessionCookie = firstCookie(loggedIn, "wd_session");
  assert.ok(sessionCookie);

  const session = await fetch(`${base}/api/session`, { headers: { cookie: sessionCookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.email, email);
  const csrfDenied = await fetch(`${base}/api/tasks`, { method: "POST", headers: { cookie: sessionCookie, "content-type": "application/json" }, body: JSON.stringify({ title: "Denied", area: "Operations", priority: "Low", due: "Tomorrow" }) });
  assert.equal(csrfDenied.status, 403);
  const csrfAllowed = await fetch(`${base}/api/tasks`, { method: "POST", headers: { cookie: sessionCookie, origin: base, "content-type": "application/json" }, body: JSON.stringify({ title: "Production test", area: "Operations", priority: "Low", due: "Tomorrow" }) });
  assert.equal(csrfAllowed.status, 201);

  const schedulerDenied = await fetch(`${base}/internal/scheduler`, { method: "POST" });
  assert.equal(schedulerDenied.status, 401);
  const schedulerAllowed = await fetch(`${base}/internal/scheduler`, { method: "POST", headers: { authorization: `Bearer ${cronSecret}` } });
  assert.equal(schedulerAllowed.status, 200);
  assert.equal((await schedulerAllowed.json()).ok, true);

  const client = await registerClient();
  const insufficient = await authorize(client, "operations:read");
  const insufficientResponse = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${insufficient.access_token}` }, body: "{}" });
  assert.equal(insufficientResponse.status, 401);

  const tokens = await authorize(client, "operations:read operations:write");
  assert.ok(tokens.access_token.startsWith("wda_") && tokens.refresh_token.startsWith("wdr_"));
  const initialize = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "production-smoke", version: "1.0.0" } } })
  });
  assert.equal(initialize.status, 200);
  assert.equal((await initialize.json()).result.serverInfo.name, "wealth-dojo-operations");
  const toolList = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  });
  assert.equal(toolList.status, 200);
  const toolPayload = await toolList.json();
  assert.ok(toolPayload.result.tools.length > 10);
  assert.ok(toolPayload.result.tools.every((tool) => (tool.securitySchemes || tool._meta?.securitySchemes)?.[0]?.type === "oauth2"));

  const refreshed = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token })
  });
  assert.equal(refreshed.status, 200);
  const refreshedTokens = await refreshed.json();
  assert.notEqual(refreshedTokens.refresh_token, tokens.refresh_token);
  const replay = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token })
  });
  assert.equal(replay.status, 400);

  const ready = await fetch(`${base}/ready`);
  assert.equal(ready.status, process.env.OPENAI_API_KEY ? 200 : 503);
  const readiness = await ready.json();
  assert.equal(readiness.dashboardAuth, true);
  assert.equal(readiness.mcpAuth, true);
  assert.equal(readiness.oauthServer, true);
} finally {
  await stop(app);
}

const backup = spawn(process.execPath, ["scripts/backup.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, DB_PATH: dbPath, BACKUP_DIR: backupDir },
  stdio: ["ignore", "pipe", "pipe"]
});
const backupExit = await new Promise((resolve) => backup.once("exit", resolve));
assert.equal(backupExit, 0);
assert.equal(existsSync(backupDir), true);
assert.ok(readdirSync(backupDir).some((name) => name.endsWith(".db")));

const unsafe = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { NODE_ENV: "production", PORT: "8797", DB_PATH: join(root, "unsafe.db") },
  stdio: ["ignore", "pipe", "pipe"]
});
let unsafeOutput = "";
unsafe.stderr.on("data", (chunk) => { unsafeOutput += chunk; });
const unsafeExit = await new Promise((resolve) => unsafe.once("exit", resolve));
assert.notEqual(unsafeExit, 0);
assert.match(unsafeOutput, /Unsafe production configuration/);

console.log("Production smoke test passed: built-in single-user login, CSRF protection, OAuth discovery, stateless DCR, PKCE authorization, scope enforcement, refresh rotation, backups, readiness, and fail-closed configuration verified.");
