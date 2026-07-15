import assert from "node:assert/strict";

const base = `http://127.0.0.1:${process.env.PORT || 8787}`;
const headers = process.env.AUTH_TOKEN ? { authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {};
const health = await fetch(`${base}/health`).then((response) => response.json());
assert.equal(health.ok, true);
const state = await fetch(`${base}/api/state`, { headers }).then((response) => response.json());
assert.ok(state.tasks.length >= 1);
assert.ok(state.sponsors.length >= 1);
for (const collection of ["milestones", "logistics", "budget", "volunteers", "vendors", "meetings", "documents", "attendeeTouchpoints", "improvements", "strategies", "campaigns", "commsDrafts", "runOfShow", "feedback"]) {
  assert.ok(Array.isArray(state[collection]), `state.${collection} should be an array`);
}
const attention = await fetch(`${base}/api/attention`, { headers }).then((response) => response.json());
assert.ok(Array.isArray(attention.items));
const integrations = await fetch(`${base}/api/integrations`, { headers }).then((response) => response.json());
assert.equal(typeof integrations.google.configured, "boolean");
const page = await fetch(base).then((response) => response.text());
assert.match(page, /Wealth Dojo Operations/);
console.log("Smoke test passed: health, state, attention, integrations, and dashboard are available.");
