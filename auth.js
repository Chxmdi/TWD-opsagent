import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deleteSession, getSession, saveSession } from "./db.js";
import { isProduction, mcpResourceUrl, publicBaseUrl, requiredMcpScopes } from "./config.js";

const DASHBOARD_SESSION_PREFIX = "dashboard:";
const OAUTH_CODE_PREFIX = "oauth-code:";
const OAUTH_ACCESS_PREFIX = "oauth-access:";
const OAUTH_REFRESH_PREFIX = "oauth-refresh:";
const DASHBOARD_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function digest(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function randomToken(prefix = "") {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function secureEqual(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}

function decodeCookie(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeCookie(part.slice(index + 1))];
  }));
}

function cookie(name, value, { maxAge = 0 } = {}) {
  const secure = isProduction() || publicBaseUrl().startsWith("https://");
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure ? "; Secure" : ""}`;
}

function safeReturnTo(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function htmlPage(title, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101914;color:#f5f0e6;font:16px/1.5 system-ui,-apple-system,sans-serif;padding:24px}.card{width:min(440px,100%);background:#17251d;border:1px solid #355340;border-radius:18px;padding:30px;box-shadow:0 24px 80px #0008}h1{font-size:1.7rem;margin:0 0 8px}.brand{color:#d4af37;font-size:.78rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.muted{color:#b6c2b9;margin:0 0 22px}.error{background:#5b2020;border:1px solid #9f4545;border-radius:10px;padding:10px 12px}label{display:block;font-weight:650;margin:16px 0 6px}input{width:100%;border:1px solid #496453;border-radius:10px;background:#0e1712;color:#fff;padding:12px;font:inherit}button{width:100%;margin-top:22px;border:0;border-radius:10px;padding:13px;background:#d4af37;color:#132019;font:inherit;font-weight:800;cursor:pointer}.secondary{background:transparent;color:#d7dfd9;border:1px solid #496453;margin-top:10px}.scope{background:#0e1712;border-radius:10px;padding:12px;color:#c8d2ca;font-size:.9rem}</style></head><body><main class="card">${content}</main></body></html>`;
}

function writeHtml(res, status, content, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(content);
}

function writeJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", pragma: "no-cache" });
  res.end(JSON.stringify(value));
}

async function readRawBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req) {
  return new URLSearchParams(await readRawBody(req));
}

function csrfValid(req, form, cookieName) {
  const sent = form.get("csrf") || "";
  const stored = cookies(req)[cookieName] || "";
  return Boolean(sent && stored && secureEqual(sent, stored));
}

function configuredEmail() {
  return String(process.env.SINGLE_USER_EMAIL || "").trim().toLowerCase();
}

function credentialsValid(email, password) {
  return dashboardAuthConfigured()
    && secureEqual(String(email).trim().toLowerCase(), configuredEmail())
    && secureEqual(password, process.env.SINGLE_USER_PASSWORD);
}

export function dashboardAuthConfigured() {
  return Boolean(configuredEmail() && process.env.SINGLE_USER_PASSWORD);
}

export function mcpOAuthConfigured() {
  return Boolean(dashboardAuthConfigured() && process.env.OAUTH_SIGNING_SECRET && mcpResourceUrl());
}

export function oauthServerReady() {
  return mcpOAuthConfigured();
}

function dashboardLoginPage({ csrf, returnTo, email = "", error = "" }) {
  return htmlPage("Sign in — Wealth Dojo", `<p class="brand">The Wealth Dojo</p><h1>Operations sign in</h1><p class="muted">Private single-user workspace.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="/auth/login"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" value="${escapeHtml(email)}" required autofocus><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form>`);
}

export function beginDashboardLogin(req, url, res) {
  if (!dashboardAuthConfigured()) throw new Error("Single-user dashboard authentication is not configured");
  const identity = dashboardIdentity(req);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  if (identity) {
    res.writeHead(302, { location: returnTo, "cache-control": "no-store" });
    return res.end();
  }
  const csrf = randomToken();
  writeHtml(res, 200, dashboardLoginPage({ csrf, returnTo }), { "set-cookie": cookie("wd_login_csrf", csrf, { maxAge: 600 }) });
}

export async function finishDashboardLogin(req, res) {
  if (!dashboardAuthConfigured()) throw new Error("Single-user dashboard authentication is not configured");
  const form = await readForm(req);
  const returnTo = safeReturnTo(form.get("returnTo"));
  if (!csrfValid(req, form, "wd_login_csrf")) {
    const error = new Error("The sign-in form expired. Please try again.");
    error.status = 400;
    throw error;
  }
  if (!credentialsValid(form.get("email") || "", form.get("password") || "")) {
    const csrf = randomToken();
    return writeHtml(res, 401, dashboardLoginPage({ csrf, returnTo, email: form.get("email") || "", error: "Email or password is incorrect." }), { "set-cookie": cookie("wd_login_csrf", csrf, { maxAge: 600 }) });
  }
  const sessionToken = randomToken("wds_");
  const ttl = Math.max(1, Number(process.env.SESSION_TTL_HOURS || DASHBOARD_SESSION_TTL_MS / 3600000)) * 60 * 60 * 1000;
  saveSession(`${DASHBOARD_SESSION_PREFIX}${digest(sessionToken)}`, {
    sub: "single-user",
    email: configuredEmail(),
    name: "Wealth Dojo Operator",
    expiresAt: Date.now() + ttl
  });
  res.writeHead(302, {
    location: returnTo,
    "set-cookie": [cookie("wd_session", sessionToken, { maxAge: ttl / 1000 }), cookie("wd_login_csrf", "", { maxAge: 0 })],
    "cache-control": "no-store"
  });
  res.end();
}

export function dashboardIdentity(req) {
  const token = cookies(req).wd_session;
  if (!token) return null;
  const key = `${DASHBOARD_SESSION_PREFIX}${digest(token)}`;
  const session = getSession(key);
  if (!session || session.expiresAt < Date.now()) {
    if (session) deleteSession(key);
    return null;
  }
  return { sub: session.sub, email: session.email, name: session.name };
}

export function logoutDashboard(req, res) {
  const token = cookies(req).wd_session;
  if (token) deleteSession(`${DASHBOARD_SESSION_PREFIX}${digest(token)}`);
  res.writeHead(302, { location: "/auth/login", "set-cookie": cookie("wd_session", "", { maxAge: 0 }), "cache-control": "no-store" });
  res.end();
}

function signingSecret() {
  const secret = process.env.OAUTH_SIGNING_SECRET;
  if (!secret) throw new Error("OAUTH_SIGNING_SECRET is not configured");
  return secret;
}

function signClientPayload(payload) {
  return createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

function makeClientId(metadata) {
  const payload = Buffer.from(JSON.stringify({
    redirectUris: metadata.redirect_uris,
    clientName: String(metadata.client_name || "ChatGPT MCP client").slice(0, 100),
    issuedAt: Math.floor(Date.now() / 1000)
  })).toString("base64url");
  return `wdc_${payload}.${signClientPayload(payload)}`;
}

function clientMetadata(clientId) {
  const match = String(clientId || "").match(/^wdc_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!match || !secureEqual(match[2], signClientPayload(match[1]))) return null;
  try {
    const value = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    return Array.isArray(value.redirectUris) ? value : null;
  } catch {
    return null;
  }
}

function validRedirectUri(value) {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    return !url.username && !url.password && !url.hash && (url.protocol === "https:" || (!isProduction() && local && url.protocol === "http:"));
  } catch {
    return false;
  }
}

export function authorizationServerMetadata() {
  const base = publicBaseUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: requiredMcpScopes(),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/docs/production`
  };
}

export async function registerOAuthClient(req, res) {
  let metadata;
  try {
    metadata = JSON.parse(await readRawBody(req));
  } catch {
    return writeJson(res, 400, { error: "invalid_client_metadata", error_description: "Registration must contain valid JSON." });
  }
  if (!Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length < 1 || metadata.redirect_uris.length > 10 || !metadata.redirect_uris.every(validRedirectUri)) {
    return writeJson(res, 400, { error: "invalid_redirect_uri", error_description: "One to ten secure redirect URIs are required." });
  }
  if (metadata.token_endpoint_auth_method && metadata.token_endpoint_auth_method !== "none") {
    return writeJson(res, 400, { error: "invalid_client_metadata", error_description: "Only public PKCE clients are supported." });
  }
  const requestedGrants = metadata.grant_types || ["authorization_code", "refresh_token"];
  if (!Array.isArray(requestedGrants) || !requestedGrants.includes("authorization_code") || requestedGrants.some((grant) => !["authorization_code", "refresh_token"].includes(grant))) {
    return writeJson(res, 400, { error: "invalid_client_metadata", error_description: "Only authorization_code and refresh_token grants are supported." });
  }
  const clientId = makeClientId(metadata);
  writeJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: String(metadata.client_name || "ChatGPT MCP client").slice(0, 100),
    redirect_uris: metadata.redirect_uris,
    grant_types: requestedGrants,
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  });
}

function validateAuthorizationParams(params) {
  const clientId = params.get("client_id") || "";
  const client = clientMetadata(clientId);
  const redirectUri = params.get("redirect_uri") || "";
  if (!client || !client.redirectUris.includes(redirectUri)) throw Object.assign(new Error("OAuth client or redirect URI is invalid"), { status: 400 });
  if (params.get("response_type") !== "code") throw Object.assign(new Error("Only the authorization code flow is supported"), { status: 400 });
  const challenge = params.get("code_challenge") || "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw Object.assign(new Error("A valid S256 PKCE challenge is required"), { status: 400 });
  const resource = params.get("resource") || "";
  if (resource !== mcpResourceUrl()) throw Object.assign(new Error("OAuth resource does not match this MCP server"), { status: 400 });
  const supported = new Set(requiredMcpScopes());
  const scopes = String(params.get("scope") || requiredMcpScopes().join(" ")).split(/\s+/).filter(Boolean);
  if (!scopes.length || scopes.some((scope) => !supported.has(scope))) throw Object.assign(new Error("Requested OAuth scope is invalid"), { status: 400 });
  return { clientId, redirectUri, challenge, resource, scopes, state: params.get("state") || "" };
}

function oauthAuthorizationPage(input, csrf, { email = "", error = "" } = {}) {
  const hidden = [
    ["csrf", csrf], ["client_id", input.clientId], ["redirect_uri", input.redirectUri], ["response_type", "code"],
    ["code_challenge", input.challenge], ["code_challenge_method", "S256"], ["resource", input.resource],
    ["scope", input.scopes.join(" ")], ["state", input.state]
  ].map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join("");
  return htmlPage("Authorize ChatGPT — Wealth Dojo", `<p class="brand">The Wealth Dojo</p><h1>Connect ChatGPT</h1><p class="muted">Sign in to let ChatGPT access your private operations workspace.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<div class="scope">Requested access: read and update Wealth Dojo operations. External messages and spending remain approval-gated.</div><form method="post" action="/oauth/authorize">${hidden}<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" value="${escapeHtml(email)}" required autofocus><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit" name="action" value="allow">Authorize ChatGPT</button><button class="secondary" type="submit" name="action" value="deny">Cancel</button></form>`);
}

export function beginOAuthAuthorization(url, res) {
  const input = validateAuthorizationParams(url.searchParams);
  const csrf = randomToken();
  writeHtml(res, 200, oauthAuthorizationPage(input, csrf), { "set-cookie": cookie("wd_oauth_csrf", csrf, { maxAge: 600 }) });
}

function authorizationRedirect(input, values) {
  const redirect = new URL(input.redirectUri);
  for (const [key, value] of Object.entries({ ...values, state: input.state, iss: publicBaseUrl() })) {
    if (value) redirect.searchParams.set(key, value);
  }
  return redirect.toString();
}

export async function finishOAuthAuthorization(req, res) {
  const form = await readForm(req);
  const input = validateAuthorizationParams(form);
  if (!csrfValid(req, form, "wd_oauth_csrf")) throw Object.assign(new Error("The authorization form expired. Please try again."), { status: 400 });
  if (form.get("action") === "deny") {
    res.writeHead(302, { location: authorizationRedirect(input, { error: "access_denied", error_description: "The operator declined access." }), "set-cookie": cookie("wd_oauth_csrf", "", { maxAge: 0 }), "cache-control": "no-store" });
    return res.end();
  }
  if (!credentialsValid(form.get("email") || "", form.get("password") || "")) {
    const csrf = randomToken();
    return writeHtml(res, 401, oauthAuthorizationPage(input, csrf, { email: form.get("email") || "", error: "Email or password is incorrect." }), { "set-cookie": cookie("wd_oauth_csrf", csrf, { maxAge: 600 }) });
  }
  const code = randomToken("wdc_");
  saveSession(`${OAUTH_CODE_PREFIX}${digest(code)}`, { ...input, email: configuredEmail(), expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS });
  res.writeHead(302, { location: authorizationRedirect(input, { code }), "set-cookie": cookie("wd_oauth_csrf", "", { maxAge: 0 }), "cache-control": "no-store" });
  res.end();
}

function issueTokens(session) {
  const accessToken = randomToken("wda_");
  const refreshToken = randomToken("wdr_");
  const access = { ...session, sub: "single-user", expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS };
  const refresh = { ...session, sub: "single-user", expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS };
  saveSession(`${OAUTH_ACCESS_PREFIX}${digest(accessToken)}`, access);
  saveSession(`${OAUTH_REFRESH_PREFIX}${digest(refreshToken)}`, refresh);
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_MS / 1000, refresh_token: refreshToken, scope: session.scopes.join(" ") };
}

function oauthError(res, status, error, description) {
  return writeJson(res, status, { error, error_description: description });
}

export async function exchangeOAuthToken(req, res) {
  const form = await readForm(req);
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id") || "";
  if (!clientMetadata(clientId)) return oauthError(res, 401, "invalid_client", "OAuth client is invalid.");
  if (grantType === "authorization_code") {
    const code = form.get("code") || "";
    const key = `${OAUTH_CODE_PREFIX}${digest(code)}`;
    const pending = getSession(key);
    if (pending) deleteSession(key);
    if (!pending || pending.expiresAt < Date.now()) return oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired.");
    if (!secureEqual(clientId, pending.clientId) || !secureEqual(form.get("redirect_uri") || "", pending.redirectUri)) return oauthError(res, 400, "invalid_grant", "OAuth client or redirect URI does not match the authorization code.");
    if (!secureEqual(digest(form.get("code_verifier") || ""), pending.challenge)) return oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
    if (form.get("resource") && !secureEqual(form.get("resource"), pending.resource)) return oauthError(res, 400, "invalid_target", "OAuth resource does not match the authorization code.");
    return writeJson(res, 200, issueTokens(pending));
  }
  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token") || "";
    const key = `${OAUTH_REFRESH_PREFIX}${digest(refreshToken)}`;
    const existing = getSession(key);
    if (!existing || existing.expiresAt < Date.now()) {
      if (existing) deleteSession(key);
      return oauthError(res, 400, "invalid_grant", "Refresh token is invalid or expired.");
    }
    if (!secureEqual(clientId, existing.clientId)) return oauthError(res, 400, "invalid_grant", "OAuth client does not match the refresh token.");
    const requested = String(form.get("scope") || existing.scopes.join(" ")).split(/\s+/).filter(Boolean);
    if (requested.some((scope) => !existing.scopes.includes(scope))) return oauthError(res, 400, "invalid_scope", "A refresh cannot add new scopes.");
    deleteSession(key);
    return writeJson(res, 200, issueTokens({ ...existing, scopes: requested }));
  }
  return oauthError(res, 400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
}

export function verifyMcpRequest(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const key = `${OAUTH_ACCESS_PREFIX}${digest(header.slice(7))}`;
  const token = getSession(key);
  if (!token || token.expiresAt < Date.now()) {
    if (token) deleteSession(key);
    return null;
  }
  if (token.resource !== mcpResourceUrl()) return null;
  const granted = new Set(token.scopes || []);
  if (!requiredMcpScopes().every((scope) => granted.has(scope))) return null;
  return { sub: token.sub, email: token.email, scope: token.scopes.join(" ") };
}

export function protectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: mcpOAuthConfigured() ? [publicBaseUrl()] : [],
    scopes_supported: requiredMcpScopes(),
    bearer_methods_supported: ["header"],
    resource_documentation: `${publicBaseUrl()}/docs/production`
  };
}

export function challengeMcp(res) {
  const metadata = `${publicBaseUrl()}/.well-known/oauth-protected-resource`;
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadata}", scope="${requiredMcpScopes().join(" ")}"`);
}
