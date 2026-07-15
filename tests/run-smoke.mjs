import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = 8791;
const base = `http://127.0.0.1:${port}`;
const dbPath = join(mkdtempSync(join(tmpdir(), "wealth-dojo-smoke-")), "smoke.db");

function startServer(extraEnv = {}) {
  return spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, SCHEDULER: "off", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become ready");
}

function stopServer(server) {
  return new Promise((resolve) => {
    server.on("exit", resolve);
    server.kill("SIGTERM");
  });
}

const jsonHeaders = { "content-type": "application/json" };
const post = (path, payload, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { ...jsonHeaders, ...headers }, body: JSON.stringify(payload ?? {}) }).then((response) => response.json());
const patch = (path, payload, headers = {}) => fetch(`${base}${path}`, { method: "PATCH", headers: { ...jsonHeaders, ...headers }, body: JSON.stringify(payload) }).then((response) => response.json());

// ---- Phase 1: open mode (no auth) ----
let server = startServer();
try {
  await waitForServer();
  const health = await fetch(`${base}/health`).then((response) => response.json());
  assert.equal(health.ok, true);

  const state = await fetch(`${base}/api/state`).then((response) => response.json());
  assert.ok(state.tasks.length >= 1);
  assert.ok(state.sponsors.length >= 1);
  for (const collection of ["milestones", "logistics", "budget", "volunteers", "vendors", "meetings", "documents", "attendeeTouchpoints", "improvements", "strategies", "campaigns", "commsDrafts", "runOfShow", "feedback"]) {
    assert.ok(Array.isArray(state[collection]), `state.${collection} should be an array`);
  }
  const page = await fetch(base).then((response) => response.text());
  assert.match(page, /Wealth Dojo Operations/);

  // Attention + integrations status.
  const attention = await fetch(`${base}/api/attention`).then((response) => response.json());
  assert.ok(Array.isArray(attention.items));
  const integrations = await fetch(`${base}/api/integrations`).then((response) => response.json());
  assert.equal(typeof integrations.google.configured, "boolean");
  assert.equal(integrations.auth, false);

  // Core write routes.
  const volunteer = await post("/api/volunteers", { name: "Smoke Tester", role: "QA" });
  assert.equal(volunteer.stage, "Applied");
  const moved = await patch(`/api/volunteers/${volunteer.id}`, { stage: "Onboarded" });
  assert.equal(moved.stage, "Onboarded");

  // Undo reverts the volunteer stage change.
  const undo = await post("/api/undo");
  assert.equal(undo.collection, "volunteers");
  const reverted = await fetch(`${base}/api/state`).then((response) => response.json());
  assert.equal(reverted.volunteers.find((item) => item.id === volunteer.id).stage, "Applied");

  // Meetings and action-item conversion.
  const meeting = await post("/api/meetings", { title: "Smoke sync", date: "2026-07-14", attendees: ["QA"], agenda: ["Verify"], actionItems: [{ text: "Check conversion", owner: "QA", due: "Now" }] });
  const converted = await post(`/api/meetings/${meeting.id}/convert`);
  assert.equal(converted.created.length, 1);

  // Draft workflow: create → approve → manual send (auto-advances sponsor).
  const sponsorId = state.sponsors[0].id;
  const draft = await post("/api/outreach/draft", { sponsorId });
  assert.equal(draft.status, "Needs approval");
  const premature = await fetch(`${base}/api/outreach/${draft.id}/send`, { method: "POST", headers: jsonHeaders, body: "{}" });
  assert.equal(premature.status, 500);
  await patch(`/api/outreach/${draft.id}`, { status: "Approved", to: "test@example.com" });
  const sent = await post(`/api/outreach/${draft.id}/send`, { manual: true });
  assert.equal(sent.draft.status, "Sent");
  assert.equal(sent.via, "manual");
  const afterSend = await fetch(`${base}/api/state`).then((response) => response.json());
  assert.equal(afterSend.sponsors.find((item) => item.id === sponsorId).stage, "Contacted");

  // Run of show: slot CRUD, conflicts, shift plan.
  const slot = await post("/api/run-of-show", { start: "09:30", end: "10:30", segment: "Smoke overlap", owner: "Amara Nwosu", location: "Lobby" });
  const conflicts = await fetch(`${base}/api/run-of-show/conflicts`).then((response) => response.json());
  assert.ok(conflicts.length >= 1, "overlapping slot should create a conflict");
  const shiftPlan = await post("/api/run-of-show/shift-plan");
  assert.match(shiftPlan.document.title, /shift plan/i);
  await fetch(`${base}/api/run-of-show/${slot.id}`, { method: "DELETE" });

  // Feedback, sponsor packet, campaign content + exports.
  const feedback = await post("/api/feedback", { source: "Volunteer", phase: "Before", rating: 2, comment: "Onboarding unclear" });
  assert.equal(feedback.rating, 2);
  const packet = await post("/api/documents/sponsor-packet");
  assert.match(packet.title, /Sponsorship packet/);
  const campaign = await post("/api/campaigns", { name: "Smoke campaign", channel: "Email", objective: "Verify routes", contentCalendar: [{ date: "2026-07-20", channel: "Email", title: "Test post" }] });
  const ics = await fetch(`${base}/api/campaigns/${campaign.id}/export.ics`).then((response) => response.text());
  assert.match(ics, /BEGIN:VCALENDAR/);
  const csv = await fetch(`${base}/api/campaigns/${campaign.id}/export.csv`).then((response) => response.text());
  assert.match(csv, /Test post/);
  const download = await fetch(`${base}/api/documents/${packet.id}/download`).then((response) => response.text());
  assert.match(download, /Sponsorship packet/);

  // Comms draft + weekly report.
  const comms = await post("/api/comms/draft", { audience: "Volunteer", recipient: "Smoke Tester", subject: "Hello", body: "Draft only" });
  assert.equal(comms.status, "Needs approval");
  const report = await post("/api/reports/weekly");
  assert.ok(report.metrics.totalVolunteers >= 1);
  assert.ok(report.metrics.attentionItems >= 0);

  // Agent session memory (demo mode).
  const agentReply = await post("/api/agent", { message: "What needs my attention?", sessionId: "smoke-session" });
  assert.equal(agentReply.mode, "demo");
  assert.ok(agentReply.reply.length > 10);

  // MCP tools.
  const client = new Client({ name: "wealth-dojo-smoke", version: "0.2.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await client.connect(transport);
  const tools = await client.listTools();
  for (const name of ["get_operations_overview", "get_attention_items", "create_sponsor_outreach_draft", "add_volunteer", "update_volunteer", "add_vendor", "update_vendor_status", "create_meeting_record", "convert_meeting_actions_to_tasks", "create_marketing_strategy", "create_marketing_campaign", "create_comms_draft", "add_run_of_show_slot", "log_feedback", "generate_weekly_operations_report"]) {
    assert.ok(tools.tools.some((item) => item.name === name), `MCP tool ${name} should be registered`);
  }
  const overview = await client.callTool({ name: "get_operations_overview", arguments: {} });
  assert.ok(overview.structuredContent.tasks.length >= 1);
  assert.ok(overview.structuredContent.runOfShow.length >= 1);
  assert.ok(Array.isArray(overview.structuredContent.attention));
  await client.close();
} finally {
  await stopServer(server);
}

// ---- Phase 2: auth mode (same DB persists across restart) ----
server = startServer({ AUTH_TOKEN: "smoke-secret" });
try {
  await waitForServer();
  const denied = await fetch(`${base}/api/state`);
  assert.equal(denied.status, 401);
  const authed = await fetch(`${base}/api/state`, { headers: { authorization: "Bearer smoke-secret" } });
  assert.equal(authed.status, 200);
  const persisted = await authed.json();
  assert.ok(persisted.volunteers.some((item) => item.name === "Smoke Tester"), "SQLite data should survive a restart");
  const staticOk = await fetch(base);
  assert.equal(staticOk.status, 200);
} finally {
  await stopServer(server);
}

console.log("Smoke test passed: SQLite persistence, auth, draft workflow, run of show, feedback, exports, undo, agent sessions, and MCP tools all verified.");
