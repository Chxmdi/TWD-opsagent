import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "wealth-dojo-smoke", version: "0.2.0" });
const requestInit = process.env.AUTH_TOKEN ? { headers: { authorization: `Bearer ${process.env.AUTH_TOKEN}` } } : undefined;
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${process.env.PORT || 8787}/mcp`), { requestInit });
await client.connect(transport);
const tools = await client.listTools();
for (const name of ["get_operations_overview", "get_attention_items", "create_sponsor_outreach_draft", "add_volunteer", "update_vendor_status", "create_meeting_record", "convert_meeting_actions_to_tasks", "create_marketing_strategy", "create_marketing_campaign", "create_comms_draft", "add_run_of_show_slot", "log_feedback"]) {
  assert.ok(tools.tools.some((item) => item.name === name), `MCP tool ${name} should be registered`);
}
const overview = await client.callTool({ name: "get_operations_overview", arguments: {} });
assert.ok(overview.structuredContent.tasks.length >= 1);
assert.ok(overview.structuredContent.volunteers.length >= 1);
assert.ok(overview.structuredContent.runOfShow.length >= 1);
await client.close();
console.log("MCP smoke test passed: tools list and operations overview are available.");
