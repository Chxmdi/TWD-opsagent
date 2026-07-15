import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppResource, registerAppTool as registerBaseAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { contextSummary, refreshConnectedContext, searchConnectedContext } from "./context-sync.js";
import {
  convertActionItemsToTasks,
  createCampaign,
  createCommsDraft,
  createDraft,
  createFeedback,
  createMeeting,
  createRunOfShowSlot,
  createStrategy,
  createSyncedTask,
  createVendor,
  createVolunteer,
  detectRunOfShowConflicts,
  generateWeeklyReport,
  getAttention,
  readState,
  updateSponsor,
  updateSyncedTask,
  updateVendor,
  updateVolunteer
} from "./store.js";

const root = dirname(fileURLToPath(import.meta.url));
const widgetHtml = readFileSync(join(root, "public", "widget.html"), "utf8");
const widgetUri = "ui://wealth-dojo/operations-v1.html";

function snapshot() {
  const state = readState();
  return {
    event: state.event,
    tasks: state.tasks,
    sponsors: state.sponsors,
    outreach: state.outreach.slice(0, 5),
    milestones: state.milestones,
    logistics: state.logistics,
    budget: state.budget,
    volunteers: state.volunteers,
    vendors: state.vendors,
    meetings: state.meetings.slice(0, 3),
    documents: state.documents.map(({ body, ...rest }) => rest),
    runOfShow: state.runOfShow,
    attendeeTouchpoints: state.attendeeTouchpoints,
    feedback: state.feedback.slice(0, 10),
    improvements: state.improvements,
    strategies: state.strategies.slice(0, 3),
    campaigns: state.campaigns.slice(0, 3),
    commsDrafts: state.commsDrafts.slice(0, 5),
    reports: state.reports.slice(0, 3),
    attention: getAttention().items,
    connectedContext: contextSummary()
  };
}

function reply(message) {
  return { content: [{ type: "text", text: message }], structuredContent: snapshot() };
}

const commonMeta = {
  ui: { resourceUri: widgetUri, visibility: ["model", "app"] },
  "openai/outputTemplate": widgetUri
};

const writeAnnotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const oauthSecurity = [{ type: "oauth2", scopes: ["operations:read", "operations:write"] }];

function registerAppTool(server, name, definition, handler) {
  const securitySchemes = process.env.SINGLE_USER_EMAIL && process.env.SINGLE_USER_PASSWORD && process.env.OAUTH_SIGNING_SECRET ? oauthSecurity : [{ type: "noauth" }];
  return registerBaseAppTool(server, name, {
    securitySchemes,
    ...definition,
    _meta: { ...(definition._meta || {}), securitySchemes }
  }, handler);
}

export function createOperationsMcpServer() {
  const server = new McpServer(
    { name: "wealth-dojo-operations", version: "1.3.0" },
    { instructions: "Full Experience Operations Coordinator workspace for The Wealth Dojo Experience | RESET. The overview refreshes synchronized Notion, Gmail, Calendar, Drive, and Eventbrite context. Use it before updates and confirm IDs from it. All outreach, volunteer, attendee, and vendor communications are drafts only; nothing is sent externally. Vendor bookings and spending require human approval." }
  );

  registerAppResource(server, "wealth-dojo-operations-widget", widgetUri, {}, async () => ({
    contents: [{
      uri: widgetUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: widgetHtml,
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        "openai/widgetDescription": "Interactive snapshot of Wealth Dojo operations: tasks, sponsors, volunteers, vendors, logistics, campaigns, and reports."
      }
    }]
  }));

  registerAppTool(server, "get_operations_overview", {
    title: "Show Wealth Dojo operations",
    description: "Use this when the user wants to review Wealth Dojo operations: tasks, sponsors, milestones, logistics, budget, volunteers, vendors, meetings, documents, attendee experience, marketing, drafts, or reports. Also use it to look up IDs before updating records.",
    inputSchema: {},
    _meta: { ...commonMeta, "openai/toolInvocation/invoking": "Loading operations…", "openai/toolInvocation/invoked": "Operations ready" },
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true }
  }, async () => {
    await refreshConnectedContext();
    return reply("Here is the current Wealth Dojo operations snapshot, including synchronized external context.");
  });

  registerAppTool(server, "refresh_connected_context", {
    title: "Refresh connected context",
    description: "Use this when the user wants the latest Notion tasks/projects, Gmail message summaries, Calendar events, Drive files, and Eventbrite ticket information.",
    inputSchema: {},
    _meta: { ...commonMeta, "openai/toolInvocation/invoking": "Refreshing connected sources…", "openai/toolInvocation/invoked": "Connected context refreshed" },
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true }
  }, async () => {
    await refreshConnectedContext({ force: true });
    return reply("Refreshed the connected Notion, Google, and Eventbrite context.");
  });

  registerAppTool(server, "search_connected_context", {
    title: "Search connected context",
    description: "Use this when the user wants to find a person, organization, task, email, calendar event, Drive file, planning detail, or Eventbrite detail across synchronized sources.",
    inputSchema: { query: z.string().min(1), limit: z.number().min(1).max(25).default(12) },
    _meta: commonMeta,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true }
  }, async ({ query, limit }) => ({
    content: [{ type: "text", text: `Found synchronized context for “${query}”.` }],
    structuredContent: { ...snapshot(), contextResults: searchConnectedContext(query, limit) }
  }));

  registerAppTool(server, "create_operations_task", {
    title: "Create operations task",
    description: "Use this when the user wants to add a specific internal Wealth Dojo task.",
    inputSchema: { title: z.string().min(2), area: z.string().default("Operations"), priority: z.enum(["Low", "Medium", "High"]).default("Medium"), due: z.string().default("This week") },
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async (args) => {
    const task = await createSyncedTask(args);
    return reply(`Created internal task “${task.title}”.`);
  });

  registerAppTool(server, "update_operations_task", {
    title: "Update operations task",
    description: "Use this when the user wants to update a known task. Notion-backed tasks are written through to the canonical TWD Tasks database.",
    inputSchema: { taskId: z.string(), status: z.enum(["To do", "In progress", "Done"]).optional(), priority: z.enum(["Low", "Medium", "High"]).optional(), due: z.string().optional(), title: z.string().optional() },
    _meta: commonMeta,
    annotations: { ...writeAnnotations, idempotentHint: true }
  }, async ({ taskId, ...changes }) => {
    const task = await updateSyncedTask(taskId, changes);
    return reply(`Updated task “${task.title}”.`);
  });

  registerAppTool(server, "update_sponsor_stage", {
    title: "Update sponsor pipeline stage",
    description: "Use this when the user wants to move a known sponsor to another internal pipeline stage. This does not contact the sponsor.",
    inputSchema: { sponsorId: z.string(), stage: z.enum(["Research", "Qualified", "Contacted", "Meeting", "Committed", "Declined"]) },
    _meta: commonMeta,
    annotations: { ...writeAnnotations, idempotentHint: true }
  }, async ({ sponsorId, stage }) => {
    const sponsor = updateSponsor(sponsorId, { stage });
    return reply(`Moved ${sponsor.name} to ${stage}.`);
  });

  registerAppTool(server, "create_sponsor_outreach_draft", {
    title: "Create sponsor outreach draft",
    description: "Use this when the user wants an internal sponsor email draft. The draft is approval-gated and is not sent.",
    inputSchema: { sponsorId: z.string(), subject: z.string().optional(), body: z.string().optional() },
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async (args) => {
    const draft = createDraft(args);
    return reply(`Drafted outreach for ${draft.sponsor}. It is marked “Needs approval” and has not been sent.`);
  });

  registerAppTool(server, "add_volunteer", {
    title: "Add volunteer",
    description: "Use this when the user wants to add a volunteer to the event roster.",
    inputSchema: { name: z.string().min(2), role: z.string().default("General support"), stage: z.enum(["Applied", "Interviewed", "Onboarded", "Scheduled", "Active"]).default("Applied"), shift: z.string().optional(), notes: z.string().optional() },
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async (args) => {
    const volunteer = createVolunteer(args);
    return reply(`Added ${volunteer.name} to the volunteer roster as ${volunteer.role} (${volunteer.stage}).`);
  });

  registerAppTool(server, "update_volunteer", {
    title: "Update volunteer",
    description: "Use this when the user wants to move a volunteer through onboarding stages or change their role or shift. This does not message the volunteer.",
    inputSchema: { volunteerId: z.string(), stage: z.enum(["Applied", "Interviewed", "Onboarded", "Scheduled", "Active"]).optional(), role: z.string().optional(), shift: z.string().optional(), notes: z.string().optional() },
    _meta: commonMeta,
    annotations: { ...writeAnnotations, idempotentHint: true }
  }, async ({ volunteerId, ...changes }) => {
    const volunteer = updateVolunteer(volunteerId, changes);
    return reply(`Updated ${volunteer.name}: now ${volunteer.stage}, role ${volunteer.role}, shift ${volunteer.shift}.`);
  });

  registerAppTool(server, "add_vendor", {
    title: "Add vendor",
    description: "Use this when the user wants to track a vendor or supplier (catering, AV, printing, decor) in the pipeline.",
    inputSchema: { name: z.string().min(2), category: z.string().default("General"), deliverables: z.string().default("To be defined"), cost: z.number().min(0).default(0), contact: z.string().optional(), notes: z.string().optional() },
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async (args) => {
    const vendor = createVendor(args);
    return reply(`Added vendor ${vendor.name} (${vendor.category}) at the ${vendor.status} stage.`);
  });

  registerAppTool(server, "update_vendor_status", {
    title: "Update vendor status",
    description: "Use this when the user wants to update a vendor's pipeline status or cost. Only mark Booked or Confirmed when the user says the booking happened — this tool itself makes no external commitment.",
    inputSchema: { vendorId: z.string(), status: z.enum(["Research", "Contacted", "Quote received", "Booked", "Confirmed", "Completed"]).optional(), cost: z.number().min(0).optional(), notes: z.string().optional() },
    _meta: commonMeta,
    annotations: { ...writeAnnotations, idempotentHint: true }
  }, async ({ vendorId, ...changes }) => {
    const vendor = updateVendor(vendorId, changes);
    return reply(`Updated ${vendor.name}: ${vendor.status}${vendor.cost ? `, $${vendor.cost} CAD` : ""}.`);
  });

  registerAppTool(server, "create_meeting_record", {
    title: "Record meeting",
    description: "Use this when the user wants to prepare a meeting agenda or capture meeting notes and action items.",
    inputSchema: {
      title: z.string().min(2),
      date: z.string().default(new Date().toISOString().slice(0, 10)),
      attendees: z.array(z.string()).default([]),
      agenda: z.array(z.string()).default([]),
      notes: z.string().optional(),
      actionItems: z.array(z.object({ text: z.string(), owner: z.string().default("Chimdi"), due: z.string().default("This week") })).default([])
    },
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async (args) => {
    const meeting = createMeeting(args);
    return reply(`Recorded meeting “${meeting.title}” with ${meeting.agenda.length} agenda items and ${meeting.actionItems.length} action items.`);
  });

  registerAppTool(server, "convert_meeting_actions_to_tasks", {
    title: "Convert meeting actions to tasks",
    description: "Use this when the user wants a meeting's open action items turned into tracked operations tasks.",
    inputSchema: { meetingId: z.string() },
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async ({ meetingId }) => {
    const { meeting, created } = convertActionItemsToTasks(meetingId);
    return reply(`Converted ${created.length} action item${created.length === 1 ? "" : "s"} from “${meeting.title}” into tasks.`);
  });

  registerAppTool(server, "create_marketing_strategy", {
    title: "Create marketing strategy",
    description: "Use this when the user wants to save a marketing strategy for the event: audience, positioning, channels, budget in CAD, and KPIs.",
    inputSchema: { title: z.string().min(2), audience: z.string(), positioning: z.string(), channels: z.array(z.string()).default([]), budget: z.number().min(0).default(0), kpis: z.array(z.string()).default([]), summary: z.string().default("") },
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async (args) => {
    const strategy = createStrategy(args);
    return reply(`Saved marketing strategy “${strategy.title}” with ${strategy.channels.length} channels and ${strategy.kpis.length} KPIs.`);
  });

  registerAppTool(server, "create_marketing_campaign", {
    title: "Create marketing campaign",
    description: "Use this when the user wants to plan a marketing campaign with objective, timeline, and content-calendar entries. Content is planned internally; nothing is published.",
    inputSchema: {
      name: z.string().min(2),
      strategyId: z.string().optional(),
      channel: z.string().default("Multi-channel"),
      objective: z.string().default(""),
      startDate: z.string().default("TBD"),
      endDate: z.string().default("TBD"),
      budget: z.number().min(0).default(0),
      metrics: z.string().default(""),
      contentCalendar: z.array(z.object({ date: z.string(), channel: z.string(), title: z.string() })).default([])
    },
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async (args) => {
    const campaign = createCampaign(args);
    return reply(`Created campaign “${campaign.name}” (${campaign.status}) with ${campaign.contentCalendar.length} content pieces planned.`);
  });

  registerAppTool(server, "create_comms_draft", {
    title: "Draft volunteer/attendee/vendor message",
    description: "Use this when the user wants a message drafted for a volunteer, attendee, vendor, or partner. The draft is approval-gated and is never sent automatically.",
    inputSchema: { audience: z.enum(["Volunteer", "Attendee", "Vendor", "Partner"]), recipient: z.string(), subject: z.string(), body: z.string() },
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async (args) => {
    const draft = createCommsDraft(args);
    return reply(`Drafted a ${draft.audience.toLowerCase()} message for ${draft.recipient}. It is marked “Needs approval” and has not been sent.`);
  });

  registerAppTool(server, "get_attention_items", {
    title: "Show what needs attention",
    description: "Use this when the user asks what is overdue, at risk, or what to focus on: overdue milestones/logistics, budget overruns, run-of-show conflicts, stale drafts, and unstarted high-priority tasks.",
    inputSchema: {},
    _meta: { ...commonMeta, "openai/toolInvocation/invoking": "Checking deadlines…", "openai/toolInvocation/invoked": "Attention items ready" },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true }
  }, async () => {
    const attention = getAttention();
    return reply(attention.items.length ? `${attention.items.length} items need attention:\n- ${attention.items.join("\n- ")}` : "Nothing is overdue or at risk right now.");
  });

  registerAppTool(server, "add_run_of_show_slot", {
    title: "Add run-of-show slot",
    description: "Use this when the user wants to add a segment to the event-day run of show with start/end times (HH:MM).",
    inputSchema: { start: z.string(), end: z.string(), segment: z.string().min(2), owner: z.string().default("Chimdi"), location: z.string().default("Main hall"), notes: z.string().optional() },
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async (args) => {
    const slot = createRunOfShowSlot(args);
    const conflicts = detectRunOfShowConflicts();
    return reply(`Added ${slot.start}–${slot.end} ${slot.segment}.${conflicts.length ? ` Warning — ${conflicts.length} schedule conflict${conflicts.length === 1 ? "" : "s"}: ${conflicts.map((conflict) => conflict.detail).join("; ")}` : ""}`);
  });

  registerAppTool(server, "log_feedback", {
    title: "Log experience feedback",
    description: "Use this when the user wants to record attendee, volunteer, or partner feedback with a 1-5 rating.",
    inputSchema: { source: z.enum(["Attendee", "Volunteer", "Partner", "Vendor"]).default("Attendee"), phase: z.enum(["Before", "During", "After"]).default("After"), rating: z.number().min(1).max(5), comment: z.string() },
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async (args) => {
    const entry = createFeedback(args);
    return reply(`Logged ${entry.source.toLowerCase()} feedback (${entry.rating}/5) in the ${entry.phase} phase.`);
  });

  registerAppTool(server, "generate_weekly_operations_report", {
    title: "Generate weekly operations report",
    description: "Use this when the user wants a current internal weekly report across tasks, sponsors, volunteers, vendors, logistics, budget, and marketing.",
    inputSchema: {},
    _meta: commonMeta,
    annotations: writeAnnotations
  }, async () => {
    const report = generateWeeklyReport();
    return reply(report.summary);
  });

  return server;
}
