import { isAbsolute } from "node:path";

function required(name, problems) {
  if (!process.env[name]?.trim()) problems.push(`${name} is required`);
}

function httpsUrl(name, problems, { allowLocalhost = false } = {}) {
  const value = process.env[name];
  if (!value) return;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(allowLocalhost && local)) problems.push(`${name} must use HTTPS`);
  } catch {
    problems.push(`${name} must be a valid absolute URL`);
  }
}

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

export function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, "");
}

export function mcpResourceUrl() {
  return (process.env.MCP_RESOURCE_URL || publicBaseUrl()).replace(/\/$/, "");
}

export function requiredMcpScopes() {
  return (process.env.MCP_REQUIRED_SCOPES || "operations:read operations:write").split(/\s+/).filter(Boolean);
}

export function validateConfiguration() {
  if (!isProduction()) return;
  const problems = [];
  for (const name of [
    "OPENAI_API_KEY",
    "PUBLIC_BASE_URL",
    "MCP_RESOURCE_URL",
    "SINGLE_USER_EMAIL",
    "SINGLE_USER_PASSWORD",
    "OAUTH_SIGNING_SECRET"
  ]) required(name, problems);
  if (process.env.DATABASE_URL) {
    required("CRON_SECRET", problems);
    try {
      const databaseUrl = new URL(process.env.DATABASE_URL);
      if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) problems.push("DATABASE_URL must use postgres:// or postgresql://");
    } catch {
      problems.push("DATABASE_URL must be a valid PostgreSQL connection URL");
    }
  } else {
    required("DB_PATH", problems);
    required("BACKUP_DIR", problems);
  }
  if (process.env.CRON_SECRET && process.env.CRON_SECRET.length < 32) problems.push("CRON_SECRET must contain at least 32 characters");
  if (process.env.SINGLE_USER_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.SINGLE_USER_EMAIL.trim())) problems.push("SINGLE_USER_EMAIL must be a valid email address");
  if (process.env.SINGLE_USER_PASSWORD && process.env.SINGLE_USER_PASSWORD.length < 16) problems.push("SINGLE_USER_PASSWORD must contain at least 16 characters");
  if (process.env.OAUTH_SIGNING_SECRET && process.env.OAUTH_SIGNING_SECRET.length < 32) problems.push("OAUTH_SIGNING_SECRET must contain at least 32 characters");
  if (process.env.AUTH_TOKEN) problems.push("AUTH_TOKEN is development-only; use the built-in single-user login in production");
  httpsUrl("PUBLIC_BASE_URL", problems);
  if (process.env.MCP_RESOURCE_URL) httpsUrl("MCP_RESOURCE_URL", problems);
  for (const name of ["DB_PATH", "BACKUP_DIR"]) {
    if (process.env[name] && !isAbsolute(process.env[name])) problems.push(`${name} must be an absolute path`);
  }
  for (const name of ["PUBLIC_BASE_URL", "MCP_RESOURCE_URL"]) {
    if (!process.env[name]) continue;
    try {
      const url = new URL(process.env[name]);
      if (url.pathname !== "/" || url.search || url.hash) problems.push(`${name} must be an origin without a path, query, or fragment`);
    } catch {}
  }
  if (problems.length) throw new Error(`Unsafe production configuration:\n- ${problems.join("\n- ")}`);
}
