import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { runOperationsAgent } from "./agent.js";
import {
  authorizationServerMetadata,
  beginDashboardLogin,
  beginOAuthAuthorization,
  challengeMcp,
  dashboardAuthConfigured,
  dashboardIdentity,
  exchangeOAuthToken,
  finishDashboardLogin,
  finishOAuthAuthorization,
  logoutDashboard,
  mcpOAuthConfigured,
  oauthServerReady,
  protectedResourceMetadata,
  registerOAuthClient,
  verifyMcpRequest
} from "./auth.js";
import { isProduction, publicBaseUrl, validateConfiguration } from "./config.js";
import { closeDatabase, databaseReady } from "./db.js";
import { withActor } from "./request-context.js";
import { createOperationsMcpServer } from "./mcp.js";
import { startScheduler } from "./scheduler.js";
import * as buffer from "./integrations/buffer.js";
import * as eventbrite from "./integrations/eventbrite.js";
import * as google from "./integrations/google.js";
import {
  addCalendarEntry,
  buildSponsorPacket,
  convertActionItemsToTasks,
  createBudgetLine,
  createCampaign,
  createCommsDraft,
  createDocument,
  createDraft,
  createFeedback,
  createImprovement,
  createLogisticsItem,
  createMeeting,
  createMilestone,
  createRunOfShowSlot,
  createSponsor,
  createStrategy,
  createTask,
  createTouchpoint,
  createVendor,
  createVolunteer,
  deleteRunOfShowSlot,
  detectRunOfShowConflicts,
  generateShiftPlan,
  generateWeeklyReport,
  getAttention,
  markDraftSent,
  readState,
  undoLastChange,
  updateBudgetLine,
  updateCampaign,
  updateCommsDraft,
  updateDocument,
  updateEvent,
  updateImprovement,
  updateLogisticsItem,
  updateMeeting,
  updateMilestone,
  updateOutreachDraft,
  updateRunOfShowSlot,
  updateSponsor,
  updateStrategy,
  updateTask,
  updateTouchpoint,
  updateVendor,
  updateVolunteer
} from "./store.js";

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 8787);
validateConfiguration();

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function securityHeaders(res, pathname) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (isProduction()) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  if (!pathname.startsWith("/mcp") && !pathname.startsWith("/.well-known/")) {
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  }
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      const error = new Error("Request too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON request body");
    error.status = 400;
    throw error;
  }
}

function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = join(publicDir, safe);
  if (!file.startsWith(publicDir) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
  return true;
}

function legacyAuthorized(req) {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return true;
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function dashboardAuthorization(req) {
  if (dashboardAuthConfigured()) return dashboardIdentity(req);
  return legacyAuthorized(req) ? { sub: "local", name: "Local operator", email: null } : null;
}

function loginRedirect(pathname) {
  return `/auth/login?returnTo=${encodeURIComponent(pathname)}`;
}

function dashboardUnauthorized(req, res, pathname) {
  if (req.method === "GET" && !pathname.startsWith("/api/")) {
    res.writeHead(302, { location: loginRedirect(pathname), "cache-control": "no-store" });
    return res.end();
  }
  if (dashboardAuthConfigured()) res.setHeader("x-auth-mode", "single-user");
  return json(res, 401, { error: "Authentication required", loginUrl: loginRedirect("/") });
}

function validMutationOrigin(req) {
  if (!dashboardAuthConfigured() || ["GET", "HEAD", "OPTIONS"].includes(req.method || "")) return true;
  try {
    return new URL(req.headers.origin).origin === new URL(publicBaseUrl()).origin;
  } catch {
    return false;
  }
}

const rateWindows = new Map();
function rateLimited(req, pathname) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").at(-1).trim();
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  const authRoute = pathname === "/auth/login" || pathname === "/oauth/authorize";
  const bucket = pathname === "/api/agent" ? "agent" : authRoute ? "auth" : "general";
  const limit = bucket === "agent" ? Number(process.env.AGENT_RATE_LIMIT_PER_MINUTE || 30) : bucket === "auth" ? Number(process.env.LOGIN_RATE_LIMIT_PER_MINUTE || 10) : Number(process.env.RATE_LIMIT_PER_MINUTE || 240);
  const key = `${ip}:${bucket}`;
  const now = Date.now();
  const current = rateWindows.get(key);
  if (!current || current.resetAt <= now) {
    rateWindows.set(key, { count: 1, resetAt: now + 60000 });
    return false;
  }
  current.count += 1;
  return current.count > limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateWindows) if (value.resetAt <= now) rateWindows.delete(key);
}, 60000).unref();

function download(res, filename, contentType, content) {
  res.writeHead(200, { "content-type": contentType, "content-disposition": `attachment; filename="${filename}"` });
  res.end(content);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "export";
}

function campaignToIcs(campaign) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Wealth Dojo Operations//EN"];
  for (const entry of campaign.contentCalendar) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) continue;
    const date = entry.date.replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${entry.id}@wealthdojo`,
      `DTSTART;VALUE=DATE:${date}`,
      `SUMMARY:${entry.channel}: ${entry.title.replace(/[,;\\]/g, " ")}`,
      `DESCRIPTION:Campaign ${campaign.name.replace(/[,;\\]/g, " ")} — status ${entry.status}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function campaignToCsv(campaign) {
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [["date", "channel", "title", "status", "campaign"].join(",")];
  for (const entry of campaign.contentCalendar) rows.push([entry.date, entry.channel, entry.title, entry.status, campaign.name].map(escape).join(","));
  return rows.join("\n");
}

async function sendDraft(collection, draftId, input) {
  const drafts = readState()[collection];
  const draft = drafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("Draft not found");
  if (draft.status === "Sent") throw new Error("Draft was already sent");
  if (draft.status !== "Approved") throw new Error("Draft must be approved before it can be sent");
  if (input.manual) return { draft: markDraftSent(collection, draftId, { via: "manual" }), via: "manual" };
  if (!google.isConnected()) throw new Error("Google is not connected. Connect Google in the Integrations panel, or use “Mark as sent”.");
  const to = input.to || draft.to;
  const { messageId } = await google.sendEmail({ to, subject: draft.subject, body: draft.body });
  return { draft: markDraftSent(collection, draftId, { via: "gmail", messageId }), via: "gmail" };
}

const resources = {
  "/api/tasks": [createTask, updateTask],
  "/api/sponsors": [createSponsor, updateSponsor],
  "/api/outreach": [null, updateOutreachDraft],
  "/api/milestones": [createMilestone, updateMilestone],
  "/api/logistics": [createLogisticsItem, updateLogisticsItem],
  "/api/budget": [createBudgetLine, updateBudgetLine],
  "/api/volunteers": [createVolunteer, updateVolunteer],
  "/api/vendors": [createVendor, updateVendor],
  "/api/meetings": [createMeeting, updateMeeting],
  "/api/documents": [createDocument, updateDocument],
  "/api/attendee-touchpoints": [createTouchpoint, updateTouchpoint],
  "/api/improvements": [createImprovement, updateImprovement],
  "/api/strategies": [createStrategy, updateStrategy],
  "/api/campaigns": [createCampaign, updateCampaign],
  "/api/comms": [createCommsDraft, updateCommsDraft],
  "/api/run-of-show": [createRunOfShowSlot, updateRunOfShowSlot],
  "/api/feedback": [createFeedback, null]
};

async function api(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/session") return json(res, 200, { user: req.authIdentity || null, mode: dashboardAuthConfigured() ? "single-user" : process.env.AUTH_TOKEN ? "token" : "open" });
  if (req.method === "GET" && pathname === "/api/state") return json(res, 200, readState());
  if (req.method === "GET" && pathname === "/api/attention") return json(res, 200, getAttention());
  if (req.method === "GET" && pathname === "/api/integrations") {
    return json(res, 200, { google: google.status(), eventbrite: eventbrite.status(), buffer: buffer.status(), auth: dashboardAuthConfigured() || Boolean(process.env.AUTH_TOKEN), authMode: dashboardAuthConfigured() ? "single-user" : process.env.AUTH_TOKEN ? "token" : "open" });
  }
  if (req.method === "PATCH" && pathname === "/api/event") return json(res, 200, updateEvent(await body(req)));
  if (req.method === "POST" && pathname === "/api/undo") return json(res, 200, undoLastChange());

  // Draft workflow: send routes must run before the generic resource matcher.
  const sendMatch = pathname.match(/^\/api\/(outreach|comms)\/([^/]+)\/send$/);
  if (req.method === "POST" && sendMatch) {
    const collection = sendMatch[1] === "outreach" ? "outreach" : "commsDrafts";
    return json(res, 200, await sendDraft(collection, decodeURIComponent(sendMatch[2]), await body(req)));
  }
  if (req.method === "POST" && pathname === "/api/outreach/draft") return json(res, 201, createDraft(await body(req)));
  if (req.method === "POST" && pathname === "/api/comms/draft") return json(res, 201, createCommsDraft(await body(req)));

  for (const [route, [create, update]] of Object.entries(resources)) {
    if (req.method === "POST" && pathname === route && create) return json(res, 201, create(await body(req)));
    if (req.method === "PATCH" && pathname.startsWith(`${route}/`) && update) return json(res, 200, update(decodeURIComponent(pathname.slice(route.length + 1)), await body(req)));
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/run-of-show/")) {
    return json(res, 200, deleteRunOfShowSlot(decodeURIComponent(pathname.slice("/api/run-of-show/".length))));
  }
  if (req.method === "GET" && pathname === "/api/run-of-show/conflicts") return json(res, 200, detectRunOfShowConflicts());
  if (req.method === "POST" && pathname === "/api/run-of-show/shift-plan") return json(res, 201, generateShiftPlan());
  if (req.method === "POST" && pathname === "/api/documents/sponsor-packet") return json(res, 201, buildSponsorPacket());

  if (req.method === "POST" && /^\/api\/meetings\/[^/]+\/convert$/.test(pathname)) {
    return json(res, 200, convertActionItemsToTasks(decodeURIComponent(pathname.split("/")[3])));
  }
  if (req.method === "POST" && /^\/api\/campaigns\/[^/]+\/content$/.test(pathname)) {
    return json(res, 201, addCalendarEntry(decodeURIComponent(pathname.split("/")[3]), await body(req)));
  }

  // Exports and integrations.
  const exportMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/export\.(ics|csv)$/);
  if (req.method === "GET" && exportMatch) {
    const campaign = readState().campaigns.find((item) => item.id === decodeURIComponent(exportMatch[1]));
    if (!campaign) throw new Error("Campaign not found");
    if (exportMatch[2] === "ics") return download(res, `${slugify(campaign.name)}.ics`, "text/calendar", campaignToIcs(campaign));
    return download(res, `${slugify(campaign.name)}.csv`, "text/csv", campaignToCsv(campaign));
  }
  const docMatch = pathname.match(/^\/api\/documents\/([^/]+)\/download$/);
  if (req.method === "GET" && docMatch) {
    const document = readState().documents.find((item) => item.id === decodeURIComponent(docMatch[1]));
    if (!document) throw new Error("Document not found");
    return download(res, `${slugify(document.title)}.md`, "text/markdown", document.body);
  }
  const driveMatch = pathname.match(/^\/api\/documents\/([^/]+)\/export-drive$/);
  if (req.method === "POST" && driveMatch) {
    const document = readState().documents.find((item) => item.id === decodeURIComponent(driveMatch[1]));
    if (!document) throw new Error("Document not found");
    return json(res, 200, await google.uploadDoc({ title: document.title, markdown: document.body }));
  }
  const calendarMatch = pathname.match(/^\/api\/(milestones|meetings)\/([^/]+)\/calendar$/);
  if (req.method === "POST" && calendarMatch) {
    const state = readState();
    const record = state[calendarMatch[1]].find((item) => item.id === decodeURIComponent(calendarMatch[2]));
    if (!record) throw new Error("Record not found");
    const isMilestone = calendarMatch[1] === "milestones";
    const date = isMilestone ? record.due : record.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Set a YYYY-MM-DD date before adding to the calendar");
    const result = await google.createCalendarEvent({
      title: isMilestone ? `RESET milestone: ${record.title}` : `Meeting: ${record.title}`,
      description: isMilestone ? record.notes : `Agenda:\n${(record.agenda || []).map((item) => `- ${item}`).join("\n")}`,
      date
    });
    const update = calendarMatch[1] === "milestones" ? updateMilestone : updateMeeting;
    update(record.id, { calendarEventId: result.eventId, calendarLink: result.link });
    return json(res, 200, result);
  }
  if (req.method === "POST" && pathname === "/api/integrations/eventbrite/sync") return json(res, 200, await eventbrite.syncTickets());
  const bufferMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/content\/([^/]+)\/buffer$/);
  if (req.method === "POST" && bufferMatch) {
    const campaign = readState().campaigns.find((item) => item.id === decodeURIComponent(bufferMatch[1]));
    const entry = campaign?.contentCalendar.find((item) => item.id === decodeURIComponent(bufferMatch[2]));
    if (!entry) throw new Error("Content entry not found");
    return json(res, 200, await buffer.queueContent(entry));
  }

  if (req.method === "POST" && pathname === "/api/reports/weekly") return json(res, 201, generateWeeklyReport());
  if (req.method === "POST" && pathname === "/api/agent") {
    const input = await body(req);
    if (!input.message?.trim()) return json(res, 400, { error: "Message is required" });
    return json(res, 200, await runOperationsAgent(input.message.trim(), input.sessionId));
  }
  return false;
}

const httpServer = createServer(async (req, res) => {
  const requestId = String(req.headers["x-request-id"] || randomUUID());
  const started = Date.now();
  res.setHeader("x-request-id", requestId);
  let pathname = "/";
  res.on("finish", () => console.log(JSON.stringify({ level: "info", event: "request", requestId, method: req.method, path: pathname, status: res.statusCode, durationMs: Date.now() - started })));
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    pathname = url.pathname;
    securityHeaders(res, pathname);

    if (pathname === "/health") return json(res, 200, { ok: true, service: "wealth-dojo-operations" });
    if (pathname === "/ready") {
      const oauthServer = dashboardAuthConfigured() || mcpOAuthConfigured() ? oauthServerReady() : !isProduction();
      const ready = databaseReady() && Boolean(process.env.OPENAI_API_KEY) && oauthServer && (!isProduction() || (dashboardAuthConfigured() && mcpOAuthConfigured()));
      return json(res, ready ? 200 : 503, { ok: ready, service: "wealth-dojo-operations", database: databaseReady(), ai: Boolean(process.env.OPENAI_API_KEY), dashboardAuth: dashboardAuthConfigured(), mcpAuth: mcpOAuthConfigured(), oauthServer });
    }
    if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, protectedResourceMetadata());
    }
    if (pathname === "/.well-known/oauth-authorization-server" || pathname === "/.well-known/openid-configuration") {
      return json(res, 200, authorizationServerMetadata());
    }
    if (pathname === "/docs/production") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" });
      return res.end("Wealth Dojo Operations is a private single-user application. Dashboard access requires the configured operator credentials. MCP access uses OAuth 2.1 with PKCE and the operations:read and operations:write scopes.");
    }
    if (rateLimited(req, pathname)) {
      res.setHeader("retry-after", "60");
      return json(res, 429, { error: "Too many requests" });
    }

    if (pathname === "/auth/login" && req.method === "GET") return beginDashboardLogin(req, url, res);
    if (pathname === "/auth/login" && req.method === "POST") return finishDashboardLogin(req, res);
    if (pathname === "/auth/logout" && req.method === "GET") return logoutDashboard(req, res);
    if (pathname === "/oauth/register" && req.method === "POST") return registerOAuthClient(req, res);
    if (pathname === "/oauth/authorize" && req.method === "GET") return beginOAuthAuthorization(url, res);
    if (pathname === "/oauth/authorize" && req.method === "POST") return finishOAuthAuthorization(req, res);
    if (pathname === "/oauth/token" && req.method === "POST") return exchangeOAuthToken(req, res);

    if (req.method === "OPTIONS" && pathname === "/mcp") {
      res.writeHead(204, { "Access-Control-Allow-Origin": process.env.MCP_ALLOWED_ORIGIN || "*", "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS", "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization", "Access-Control-Expose-Headers": "Mcp-Session-Id" });
      return res.end();
    }
    if (pathname === "/mcp" && ["POST", "GET", "DELETE"].includes(req.method || "")) {
      const identity = mcpOAuthConfigured() ? verifyMcpRequest(req) : legacyAuthorized(req) ? { sub: "local" } : null;
      if (!identity) {
        if (mcpOAuthConfigured()) challengeMcp(res);
        return json(res, 401, { error: "OAuth authorization required" });
      }
      req.authIdentity = identity;
      res.setHeader("Access-Control-Allow-Origin", process.env.MCP_ALLOWED_ORIGIN || "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      const mcp = createOperationsMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      return withActor(String(identity.email || identity.sub || "mcp"), () => transport.handleRequest(req, res));
    }

    const dashboardFile = existsSync(join(publicDir, normalize(pathname === "/" ? "/index.html" : pathname)));
    const needsDashboard = pathname.startsWith("/api/") || (dashboardAuthConfigured() && (pathname.startsWith("/auth/google") || dashboardFile));
    if (needsDashboard) {
      req.authIdentity = dashboardAuthorization(req);
      if (!req.authIdentity) return dashboardUnauthorized(req, res, pathname);
      if (pathname.startsWith("/api/") && !validMutationOrigin(req)) return json(res, 403, { error: "Invalid request origin" });
    }

    if (pathname === "/auth/google" && req.method === "GET") {
      res.writeHead(302, { location: google.getAuthUrl(), "cache-control": "no-store" });
      return res.end();
    }
    if (pathname === "/auth/google/callback" && req.method === "GET") {
      if (url.searchParams.get("error")) throw new Error(`Google authorization failed: ${url.searchParams.get("error")}`);
      const { email } = await google.handleCallback(url.searchParams.get("code"), url.searchParams.get("state"));
      res.writeHead(302, { location: `/?google=connected${email ? `&email=${encodeURIComponent(email)}` : ""}`, "cache-control": "no-store" });
      return res.end();
    }

    if (pathname.startsWith("/api/")) {
      const handled = await withActor(String(req.authIdentity?.email || req.authIdentity?.sub || "dashboard"), () => api(req, res, pathname));
      if (handled !== false) return;
    }
    if (serveStatic(pathname, res)) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "request_error", requestId, path: pathname, message: error.message, stack: error.stack }));
    if (!res.headersSent) {
      const status = Number(error.status) || 500;
      const message = isProduction() && status >= 500 ? "Internal server error" : error.message || "Internal server error";
      json(res, status, { error: message, requestId });
    }
  }
});

let scheduler;
httpServer.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", event: "started", service: "wealth-dojo-operations", port, baseUrl: publicBaseUrl(), dashboardAuth: dashboardAuthConfigured(), mcpAuth: mcpOAuthConfigured() }));
  scheduler = startScheduler();
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "shutdown", signal }));
  if (scheduler) clearInterval(scheduler);
  const deadline = setTimeout(() => {
    httpServer.closeAllConnections();
    process.exit(1);
  }, 25000);
  deadline.unref();
  httpServer.close(() => {
    clearTimeout(deadline);
    closeDatabase();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
