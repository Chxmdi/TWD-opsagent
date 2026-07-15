import { Agent, run, tool, webSearchTool } from "@openai/agents";
import { z } from "zod";
import { getSession, saveSession } from "./db.js";
import * as buffer from "./integrations/buffer.js";
import * as eventbrite from "./integrations/eventbrite.js";
import * as google from "./integrations/google.js";
import {
  addCalendarEntry,
  budgetGuardrails,
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
  feedbackSummary,
  generateShiftPlan,
  generateWeeklyReport,
  getAttention,
  readState,
  updateBudgetLine,
  updateCampaign,
  updateDocument,
  updateImprovement,
  updateLogisticsItem,
  updateMilestone,
  updateRunOfShowSlot,
  updateSponsor,
  updateStrategy,
  updateTask,
  updateTouchpoint,
  updateVendor,
  updateVolunteer
} from "./store.js";

function safe(fn) {
  return async (input) => {
    try {
      return await fn(input);
    } catch (error) {
      return { error: error.message };
    }
  };
}

const getOperations = tool({
  name: "get_operations_snapshot",
  description: "Get the full Wealth Dojo operations state: event, tasks, sponsors, outreach drafts, milestones, logistics, budget, volunteers, vendors, meetings, documents, run of show, attendee touchpoints, feedback, improvements, marketing strategies, campaigns, comms drafts, and reports. Call this first to look up IDs before updating anything.",
  parameters: z.object({}),
  execute: safe(() => readState())
});

const attentionSummary = tool({
  name: "get_attention_summary",
  description: "Get everything that needs attention right now: overdue milestones and logistics, budget overruns, run-of-show conflicts, drafts stuck in approval, upcoming deadlines, and unstarted high-priority tasks. Use this whenever the user asks what to do or what is at risk.",
  parameters: z.object({}),
  execute: safe(() => getAttention())
});

const guardrails = tool({
  name: "get_budget_guardrails",
  description: "Get planned vs actual budget totals per category with any overruns. Check this before recommending spending or vendor bookings.",
  parameters: z.object({}),
  execute: safe(() => budgetGuardrails())
});

const addTask = tool({
  name: "create_operations_task",
  description: "Create an internal operations task. This does not contact anyone.",
  parameters: z.object({ title: z.string(), area: z.enum(["Marketing", "Partnerships", "Reporting", "Operations", "Logistics", "Volunteers", "Vendors", "Attendee Experience"]), priority: z.enum(["Low", "Medium", "High"]), due: z.string() }),
  execute: safe((input) => createTask(input))
});

const editTask = tool({
  name: "update_operations_task",
  description: "Update an internal task's status, priority, due date, or title.",
  parameters: z.object({ taskId: z.string(), status: z.enum(["To do", "In progress", "Done"]).nullable(), priority: z.enum(["Low", "Medium", "High"]).nullable(), due: z.string().nullable(), title: z.string().nullable() }),
  execute: safe(({ taskId, ...changes }) => updateTask(taskId, changes))
});

const addSponsor = tool({
  name: "save_sponsor_candidate",
  description: "Save a researched sponsor candidate to the internal pipeline with its evidence source.",
  parameters: z.object({ name: z.string(), sector: z.string(), fit: z.number().min(0).max(100), contact: z.string(), reason: z.string(), source: z.string() }),
  execute: safe((input) => createSponsor(input))
});

const moveSponsor = tool({
  name: "update_sponsor_stage",
  description: "Update one internal sponsor pipeline stage. This does not send a message.",
  parameters: z.object({ sponsorId: z.string(), stage: z.enum(["Research", "Qualified", "Contacted", "Meeting", "Committed", "Declined"]) }),
  execute: safe(({ sponsorId, stage }) => updateSponsor(sponsorId, { stage }))
});

const draftOutreach = tool({
  name: "create_outreach_draft",
  description: "Create a sponsor outreach draft. It starts at 'Needs approval'; only a person can approve and send it. Include a recipient email in 'to' only if it is verified.",
  parameters: z.object({ sponsorId: z.string(), subject: z.string().nullable(), body: z.string().nullable(), to: z.string().nullable() }),
  execute: safe((input) => createDraft(input))
});

const addMilestone = tool({
  name: "create_event_milestone",
  description: "Add an event milestone to the operational timeline. Use YYYY-MM-DD dates so deadline tracking works.",
  parameters: z.object({ title: z.string(), phase: z.enum(["Planning", "Pre-event", "Event day", "Post-event"]), due: z.string(), owner: z.string(), notes: z.string().nullable() }),
  execute: safe((input) => createMilestone(input))
});

const editMilestone = tool({
  name: "update_event_milestone",
  description: "Update an event milestone's status, due date, owner, or notes.",
  parameters: z.object({ milestoneId: z.string(), status: z.enum(["Not started", "In progress", "Done"]).nullable(), due: z.string().nullable(), owner: z.string().nullable(), notes: z.string().nullable() }),
  execute: safe(({ milestoneId, ...changes }) => updateMilestone(milestoneId, changes))
});

const addLogistics = tool({
  name: "create_logistics_item",
  description: "Add an event logistics item to the checklist. Use YYYY-MM-DD due dates so deadline tracking works.",
  parameters: z.object({ item: z.string(), category: z.enum(["Venue", "AV", "Catering", "Signage", "Materials", "Transport", "Safety", "General"]), due: z.string(), owner: z.string().nullable(), notes: z.string().nullable() }),
  execute: safe((input) => createLogisticsItem(input))
});

const editLogistics = tool({
  name: "update_logistics_item",
  description: "Update a logistics item's status, owner, due date, or notes.",
  parameters: z.object({ itemId: z.string(), status: z.enum(["Needed", "Sourcing", "Booked", "Confirmed", "Done"]).nullable(), owner: z.string().nullable(), due: z.string().nullable(), notes: z.string().nullable() }),
  execute: safe(({ itemId, ...changes }) => updateLogisticsItem(itemId, changes))
});

const addBudgetLine = tool({
  name: "create_budget_line",
  description: "Add a budget line with planned cost (CAD). Internal tracking only, not a spending commitment.",
  parameters: z.object({ item: z.string(), category: z.string(), planned: z.number().min(0), notes: z.string().nullable() }),
  execute: safe((input) => createBudgetLine(input))
});

const editBudgetLine = tool({
  name: "update_budget_line",
  description: "Update a budget line's planned or actual amount, status, or notes. Check get_budget_guardrails after changes that increase actuals.",
  parameters: z.object({ lineId: z.string(), planned: z.number().min(0).nullable(), actual: z.number().min(0).nullable(), status: z.enum(["Planned", "Committed", "Paid"]).nullable(), notes: z.string().nullable() }),
  execute: safe(({ lineId, ...changes }) => updateBudgetLine(lineId, changes))
});

const addVolunteer = tool({
  name: "add_volunteer",
  description: "Add a volunteer to the roster. Contact details stay internal; never publish them.",
  parameters: z.object({ name: z.string(), role: z.string(), stage: z.enum(["Applied", "Interviewed", "Onboarded", "Scheduled", "Active"]).nullable(), shift: z.string().nullable(), notes: z.string().nullable() }),
  execute: safe((input) => createVolunteer(input))
});

const editVolunteer = tool({
  name: "update_volunteer",
  description: "Update a volunteer's onboarding stage, role, shift assignment, or notes. This does not message the volunteer.",
  parameters: z.object({ volunteerId: z.string(), stage: z.enum(["Applied", "Interviewed", "Onboarded", "Scheduled", "Active"]).nullable(), role: z.string().nullable(), shift: z.string().nullable(), notes: z.string().nullable() }),
  execute: safe(({ volunteerId, ...changes }) => updateVolunteer(volunteerId, changes))
});

const addVendor = tool({
  name: "add_vendor",
  description: "Add a vendor or supplier to the vendor pipeline with category, expected deliverables, and estimated cost (CAD).",
  parameters: z.object({ name: z.string(), category: z.string(), deliverables: z.string(), cost: z.number().min(0).nullable(), contact: z.string().nullable(), notes: z.string().nullable() }),
  execute: safe((input) => createVendor(input))
});

const editVendor = tool({
  name: "update_vendor",
  description: "Update a vendor's status, cost, deliverables, or notes. Booking a vendor is an external commitment: only mark Booked or Confirmed after explicit human approval, and check budget guardrails first.",
  parameters: z.object({ vendorId: z.string(), status: z.enum(["Research", "Contacted", "Quote received", "Booked", "Confirmed", "Completed"]).nullable(), cost: z.number().min(0).nullable(), deliverables: z.string().nullable(), notes: z.string().nullable() }),
  execute: safe(({ vendorId, ...changes }) => updateVendor(vendorId, changes))
});

const logMeeting = tool({
  name: "create_meeting_record",
  description: "Record a meeting with agenda, notes, and action items. Use to prepare agendas before meetings or capture notes and follow-ups after.",
  parameters: z.object({
    title: z.string(),
    date: z.string(),
    attendees: z.array(z.string()),
    agenda: z.array(z.string()),
    notes: z.string().nullable(),
    actionItems: z.array(z.object({ text: z.string(), owner: z.string(), due: z.string() })).nullable()
  }),
  execute: safe((input) => createMeeting(input))
});

const convertActions = tool({
  name: "convert_meeting_actions_to_tasks",
  description: "Convert all unconverted action items from a meeting into tracked operations tasks.",
  parameters: z.object({ meetingId: z.string() }),
  execute: safe(({ meetingId }) => convertActionItemsToTasks(meetingId))
});

const addDocument = tool({
  name: "create_document",
  description: "Create an internal document, SOP, checklist, template, or process guide. Body is markdown.",
  parameters: z.object({ title: z.string(), category: z.enum(["SOP", "Process", "Checklist", "Template", "Reference"]), body: z.string() }),
  execute: safe((input) => createDocument(input))
});

const editDocument = tool({
  name: "update_document",
  description: "Update an internal document's body or title. The version number increments automatically.",
  parameters: z.object({ documentId: z.string(), title: z.string().nullable(), body: z.string().nullable() }),
  execute: safe(({ documentId, ...changes }) => updateDocument(documentId, changes))
});

const addTouchpoint = tool({
  name: "create_attendee_touchpoint",
  description: "Add a planned attendee-experience touchpoint in the Before, During, or After phase of the event journey.",
  parameters: z.object({ phase: z.enum(["Before", "During", "After"]), title: z.string(), description: z.string(), channel: z.string(), owner: z.string().nullable() }),
  execute: safe((input) => createTouchpoint(input))
});

const editTouchpoint = tool({
  name: "update_attendee_touchpoint",
  description: "Update an attendee touchpoint's status, description, channel, or owner.",
  parameters: z.object({ touchpointId: z.string(), status: z.enum(["Planned", "Ready", "Live", "Done"]).nullable(), description: z.string().nullable(), channel: z.string().nullable(), owner: z.string().nullable() }),
  execute: safe(({ touchpointId, ...changes }) => updateTouchpoint(touchpointId, changes))
});

const logFeedback = tool({
  name: "log_feedback",
  description: "Log a piece of attendee, volunteer, or partner feedback with a 1-5 rating.",
  parameters: z.object({ source: z.enum(["Attendee", "Volunteer", "Partner", "Vendor"]), phase: z.enum(["Before", "During", "After"]), rating: z.number().min(1).max(5), comment: z.string() }),
  execute: safe((input) => createFeedback(input))
});

const analyzeFeedback = tool({
  name: "analyze_feedback",
  description: "Get all logged feedback with computed averages by phase and low-rating entries. Analyze the themes, then file the most important fixes with log_improvement_idea.",
  parameters: z.object({}),
  execute: safe(() => ({ summary: feedbackSummary(), entries: readState().feedback }))
});

const addImprovement = tool({
  name: "log_improvement_idea",
  description: "Log a continuous-improvement idea for systems, workflows, or processes.",
  parameters: z.object({ idea: z.string(), area: z.string(), impact: z.enum(["Low", "Medium", "High"]) }),
  execute: safe((input) => createImprovement(input))
});

const editImprovement = tool({
  name: "update_improvement_idea",
  description: "Update an improvement idea's status or impact.",
  parameters: z.object({ improvementId: z.string(), status: z.enum(["Proposed", "Approved", "In progress", "Done"]).nullable(), impact: z.enum(["Low", "Medium", "High"]).nullable() }),
  execute: safe(({ improvementId, ...changes }) => updateImprovement(improvementId, changes))
});

const addStrategy = tool({
  name: "create_marketing_strategy",
  description: "Save a complete marketing strategy: target audience, positioning, channels, budget (CAD), KPIs, and an executive summary. Research the audience and channels with web search first when possible.",
  parameters: z.object({ title: z.string(), audience: z.string(), positioning: z.string(), channels: z.array(z.string()), budget: z.number().min(0), kpis: z.array(z.string()), summary: z.string() }),
  execute: safe((input) => createStrategy(input))
});

const editStrategy = tool({
  name: "update_marketing_strategy",
  description: "Update a marketing strategy's status, positioning, channels, budget, KPIs, or summary.",
  parameters: z.object({ strategyId: z.string(), status: z.enum(["Draft", "Active", "Complete"]).nullable(), positioning: z.string().nullable(), channels: z.array(z.string()).nullable(), budget: z.number().min(0).nullable(), kpis: z.array(z.string()).nullable(), summary: z.string().nullable() }),
  execute: safe(({ strategyId, ...changes }) => updateStrategy(strategyId, changes))
});

const addCampaign = tool({
  name: "create_marketing_campaign",
  description: "Create a marketing campaign, optionally linked to a strategy, with objective, timeline, budget (CAD), success metrics, and initial content-calendar entries. Content is internal planning only — nothing is published.",
  parameters: z.object({
    name: z.string(),
    strategyId: z.string().nullable(),
    channel: z.string(),
    objective: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    budget: z.number().min(0).nullable(),
    metrics: z.string().nullable(),
    contentCalendar: z.array(z.object({ date: z.string(), channel: z.string(), title: z.string() })).nullable()
  }),
  execute: safe((input) => createCampaign(input))
});

const editCampaign = tool({
  name: "update_marketing_campaign",
  description: "Update a campaign's status, objective, dates, budget, or metrics.",
  parameters: z.object({ campaignId: z.string(), status: z.enum(["Planned", "Active", "Paused", "Complete"]).nullable(), objective: z.string().nullable(), startDate: z.string().nullable(), endDate: z.string().nullable(), budget: z.number().min(0).nullable(), metrics: z.string().nullable() }),
  execute: safe(({ campaignId, ...changes }) => updateCampaign(campaignId, changes))
});

const addContent = tool({
  name: "add_campaign_content",
  description: "Add a content-calendar entry (post, email, reel, story) to an existing campaign. This plans content; it does not publish anything.",
  parameters: z.object({ campaignId: z.string(), date: z.string(), channel: z.string(), title: z.string() }),
  execute: safe(({ campaignId, ...entry }) => addCalendarEntry(campaignId, entry))
});

const draftComms = tool({
  name: "create_comms_draft",
  description: "Draft an approval-gated message to a volunteer, attendee, vendor, or partner. It starts at 'Needs approval'; only a person can approve and send it.",
  parameters: z.object({ audience: z.enum(["Volunteer", "Attendee", "Vendor", "Partner"]), recipient: z.string(), subject: z.string(), body: z.string(), to: z.string().nullable() }),
  execute: safe((input) => createCommsDraft(input))
});

const addRunOfShow = tool({
  name: "add_run_of_show_slot",
  description: "Add a run-of-show slot for event day with start/end times (HH:MM), segment, owner, and location.",
  parameters: z.object({ start: z.string(), end: z.string(), segment: z.string(), owner: z.string(), location: z.string(), notes: z.string().nullable() }),
  execute: safe((input) => createRunOfShowSlot(input))
});

const editRunOfShow = tool({
  name: "update_run_of_show_slot",
  description: "Update a run-of-show slot's times, segment, owner, location, or notes.",
  parameters: z.object({ slotId: z.string(), start: z.string().nullable(), end: z.string().nullable(), segment: z.string().nullable(), owner: z.string().nullable(), location: z.string().nullable(), notes: z.string().nullable() }),
  execute: safe(({ slotId, ...changes }) => updateRunOfShowSlot(slotId, changes))
});

const removeRunOfShow = tool({
  name: "delete_run_of_show_slot",
  description: "Delete a run-of-show slot. The change is undoable from the dashboard.",
  parameters: z.object({ slotId: z.string() }),
  execute: safe(({ slotId }) => deleteRunOfShowSlot(slotId))
});

const checkConflicts = tool({
  name: "check_run_of_show_conflicts",
  description: "Detect overlapping run-of-show slots that double-book a location or an owner.",
  parameters: z.object({}),
  execute: safe(() => ({ conflicts: detectRunOfShowConflicts() }))
});

const shiftPlan = tool({
  name: "generate_volunteer_shift_plan",
  description: "Generate a volunteer shift plan document mapping run-of-show slots to volunteer shift windows and flagging unstaffed segments.",
  parameters: z.object({}),
  execute: safe(() => generateShiftPlan())
});

const sponsorPacket = tool({
  name: "generate_sponsor_packet",
  description: "Assemble a sponsorship one-pager document from current event stats, the marketing strategy, and pipeline momentum.",
  parameters: z.object({}),
  execute: safe(() => buildSponsorPacket())
});

const integrationStatus = tool({
  name: "get_integration_status",
  description: "Check which external integrations are configured and connected: Google (Gmail/Calendar/Drive), Eventbrite, Buffer.",
  parameters: z.object({}),
  execute: safe(() => ({ google: google.status(), eventbrite: eventbrite.status(), buffer: buffer.status() }))
});

const calendarEvent = tool({
  name: "add_google_calendar_event",
  description: "Create a Google Calendar event (all-day or timed) for a milestone, meeting, or deadline. Requires Google to be connected; returns an error message otherwise.",
  parameters: z.object({ title: z.string(), date: z.string(), description: z.string().nullable(), startTime: z.string().nullable(), endTime: z.string().nullable() }),
  execute: safe((input) => google.createCalendarEvent(input))
});

const driveExport = tool({
  name: "export_document_to_drive",
  description: "Export an internal document to Google Drive as a Google Doc. Requires Google to be connected; returns an error message otherwise.",
  parameters: z.object({ documentId: z.string() }),
  execute: safe(async ({ documentId }) => {
    const document = readState().documents.find((item) => item.id === documentId);
    if (!document) throw new Error("Document not found");
    return google.uploadDoc({ title: document.title, markdown: document.body });
  })
});

const ticketSync = tool({
  name: "sync_eventbrite_tickets",
  description: "Pull the live ticket-sold count from Eventbrite into the event record. Requires Eventbrite to be configured; returns an error message otherwise.",
  parameters: z.object({}),
  execute: safe(() => eventbrite.syncTickets())
});

const makeReport = tool({
  name: "generate_weekly_report",
  description: "Generate and save a weekly internal report covering tasks, sponsors, volunteers, vendors, milestones, logistics, budget, campaigns, sent/pending drafts, and attention items.",
  parameters: z.object({}),
  execute: safe(() => generateWeeklyReport())
});

function buildAgent() {
  return new Agent({
    name: "Wealth Dojo Operations Agent",
    model: process.env.OPENAI_MODEL || "gpt-5.4",
    instructions: `You are the Experience Operations Coordinator agent for The Wealth Dojo Experience | RESET in Calgary (event day: September 26, 2026). You support the full coordinator role:

1. Event operations and logistics — milestone timeline, logistics checklist, budget lines, and the event-day run of show (with conflict detection and volunteer shift plans).
2. Volunteer coordination — roster stages Applied → Interviewed → Onboarded → Scheduled → Active, shifts, and onboarding communications.
3. Timelines and task tracking — create, prioritize, and update operations tasks. Use get_attention_summary whenever asked what to focus on.
4. Vendor and partner coordination — vendor pipeline and sponsor pipeline. Check get_budget_guardrails before recommending spend and flag overruns explicitly.
5. Meetings — agendas, notes, action items, and converting action items into tasks.
6. Documentation — SOPs, checklists, templates, and generated artifacts (shift plans, sponsor packets). Documents can be exported to Google Drive when connected.
7. Attendee experience — Before/During/After touchpoints, attendee comms drafts, and feedback: log entries, analyze themes, and file improvement ideas from what you learn.
8. Administration and continuous improvement — improvement backlog and a clean operational record.
9. Marketing — research audiences and channels with web search, then build strategies (audience, positioning, channels, budget, KPIs) and campaigns with content calendars.

Integrations: Google (Gmail/Calendar/Drive), Eventbrite, and Buffer may or may not be connected. Check get_integration_status when relevant; when a tool reports "not connected", tell the user exactly which credential to add rather than pretending it worked.

Working method: you have conversation memory within a session, so build on earlier turns instead of re-asking. Call get_operations_snapshot to ground yourself and find IDs before updates. When asked for a strategy or plan, produce the complete artifact and save it with the right tool.

Hard rules:
- Use web search for current research and cite the URLs you relied on. Never invent a verified contact; label unverified leads clearly.
- Communications workflow: drafts move Needs approval → Approved → Sent. You can create and edit drafts, but ONLY a person can approve or send them from the dashboard. Never set a draft's status yourself, never claim a message was sent, and never imply you can send.
- Never make or imply external commitments (vendor bookings, sponsorship terms, spending) without explicit human approval. Only mark vendors Booked/Confirmed when the user says it happened.
- Keep volunteer and attendee personal details internal. Amounts are CAD.
- Use YYYY-MM-DD dates on milestones and logistics so deadline tracking works.
- Be concise and action-oriented; end with a clear next action.`,
    tools: [
      webSearchTool({ searchContextSize: "medium" }),
      getOperations, attentionSummary, guardrails,
      addTask, editTask,
      addSponsor, moveSponsor, draftOutreach, sponsorPacket,
      addMilestone, editMilestone,
      addLogistics, editLogistics,
      addBudgetLine, editBudgetLine,
      addVolunteer, editVolunteer,
      addVendor, editVendor,
      logMeeting, convertActions,
      addDocument, editDocument,
      addTouchpoint, editTouchpoint,
      logFeedback, analyzeFeedback,
      addImprovement, editImprovement,
      addStrategy, editStrategy,
      addCampaign, editCampaign, addContent,
      draftComms,
      addRunOfShow, editRunOfShow, removeRunOfShow, checkConflicts, shiftPlan,
      integrationStatus, calendarEvent, driveExport, ticketSync,
      makeReport
    ]
  });
}

function demoReply(message) {
  const text = message.toLowerCase();
  const state = readState();
  if (text.includes("attention") || text.includes("overdue") || text.includes("risk") || text.includes("focus")) {
    const attention = getAttention();
    return attention.items.length
      ? `Needs attention (${attention.items.length}):\n- ${attention.items.slice(0, 6).join("\n- ")}${attention.items.length > 6 ? "\n- …" : ""}`
      : "Nothing is overdue or at risk right now. Focus on ticket sales and sponsor conversations.";
  }
  if (text.includes("report")) {
    const report = generateWeeklyReport();
    return `Report prepared: ${report.summary}\n\nNext moves:\n- ${report.nextMoves.join("\n- ")}`;
  }
  if (text.includes("volunteer")) {
    const ready = state.volunteers.filter((volunteer) => ["Onboarded", "Scheduled", "Active"].includes(volunteer.stage));
    const pending = state.volunteers.filter((volunteer) => !["Onboarded", "Scheduled", "Active"].includes(volunteer.stage));
    return `Volunteer roster: ${state.volunteers.length} total — ${ready.length} event-ready, ${pending.length} still in onboarding (${pending.map((volunteer) => `${volunteer.name}: ${volunteer.stage}`).join(", ") || "none"}). Next: move applicants to interviews and confirm shifts before the Sep 12 training. I can draft approval-gated welcome messages when you're ready.`;
  }
  if (text.includes("vendor") || text.includes("catering") || text.includes("supplier")) {
    const list = state.vendors.map((vendor) => `${vendor.name} (${vendor.category} — ${vendor.status})`).join(", ");
    return `Vendor pipeline: ${list}. Nothing is booked without your approval. Priority: confirm the Prairie Catering Co. quote and chase the Stampede City AV estimate.`;
  }
  if (text.includes("run of show") || text.includes("run-of-show") || text.includes("shift")) {
    const conflicts = detectRunOfShowConflicts();
    return `Run of show has ${state.runOfShow.length} slots from ${state.runOfShow[0]?.start || "08:00"} to ${state.runOfShow[state.runOfShow.length - 1]?.end || "18:00"}. ${conflicts.length ? `Conflicts found: ${conflicts.map((conflict) => conflict.detail).join("; ")}.` : "No location or owner conflicts detected."} I can generate a volunteer shift plan from the Event view.`;
  }
  if (text.includes("meeting") || text.includes("agenda")) {
    const meeting = state.meetings[0];
    const open = meeting ? meeting.actionItems.filter((action) => !action.converted).length : 0;
    return meeting
      ? `Latest meeting: “${meeting.title}” (${meeting.date}) with ${open} open action item${open === 1 ? "" : "s"}. I can convert them into tracked tasks, or prepare the agenda for your next sync — with an API key I'd do both automatically.`
      : "No meetings recorded yet. I can prepare an agenda template for your next planning sync.";
  }
  if (text.includes("marketing") || text.includes("campaign") || text.includes("strategy") || text.includes("social")) {
    const strategy = state.strategies[0];
    const campaign = state.campaigns[0];
    return `Marketing: strategy “${strategy?.title}” is ${strategy?.status?.toLowerCase()} targeting ${strategy?.audience?.split(",")[0] || "the core audience"}. Campaign “${campaign?.name}” (${campaign?.status}) has ${campaign?.contentCalendar?.length || 0} content pieces planned — exportable as .ics/.csv from the Marketing view. Add OPENAI_API_KEY to research channels live and build out full strategies and calendars.`;
  }
  if (text.includes("budget") || text.includes("logistic") || text.includes("venue") || text.includes("event day") || text.includes("milestone")) {
    const open = state.logistics.filter((item) => !["Confirmed", "Done"].includes(item.status));
    const totals = budgetGuardrails();
    return `Event logistics: ${open.length} open items (${open.slice(0, 3).map((item) => item.item).join("; ")}). Budget: $${totals.actual} spent of $${totals.planned} planned (CAD)${totals.overruns.length ? ` — OVERRUN in ${totals.overruns.map((overrun) => overrun.category).join(", ")}` : ""}. Next milestone: ${state.milestones.find((milestone) => milestone.status !== "Done")?.title || "all done"}.`;
  }
  if (text.includes("feedback")) {
    const summary = feedbackSummary();
    return summary.count
      ? `Feedback so far: ${summary.count} entries averaging ${summary.average}/5. ${summary.low.length ? `${summary.low.length} low ratings need follow-up.` : "No low ratings."} I can analyze themes and file improvement ideas.`
      : "No feedback logged yet. Add entries from the Attendees view, or ask me to log what you've heard.";
  }
  if (text.includes("attendee") || text.includes("experience") || text.includes("guest")) {
    const byPhase = ["Before", "During", "After"].map((phase) => `${phase}: ${state.attendeeTouchpoints.filter((touchpoint) => touchpoint.phase === phase).length}`).join(", ");
    return `Attendee journey has ${state.attendeeTouchpoints.length} touchpoints (${byPhase}). All attendee comms are approval-gated — approve and send them from the Outreach or Attendees views.`;
  }
  if (text.includes("document") || text.includes("sop") || text.includes("process")) {
    return `Document library: ${state.documents.map((document) => `${document.title} (v${document.version})`).join(", ")}. Each can be downloaded as markdown or exported to Google Drive once connected. I can draft new SOPs, checklists, or templates.`;
  }
  if (text.includes("sponsor")) {
    const top = [...state.sponsors].sort((a, b) => b.fit - a.fit).slice(0, 3);
    return `Your top sponsor leads are ${top.map((item) => `${item.name} (${item.fit}% fit)`).join(", ")}. These are seed leads and must be verified before outreach. I can also generate a sponsorship packet document. Add OPENAI_API_KEY to activate live web research.`;
  }
  if (text.includes("task") || text.includes("today") || text.includes("start")) {
    const next = state.tasks.filter((task) => task.status !== "Done").sort((a, b) => (a.priority === "High" ? -1 : 1)).slice(0, 3);
    return `Start here:\n- ${next.map((task) => `${task.title} — ${task.status}`).join("\n- ")}`;
  }
  return "I cover the full Experience Operations Coordinator role: event logistics, run of show, volunteers, vendors, meetings, SOPs, attendee experience, feedback, budget guardrails, marketing, sponsors, and reports — plus Gmail/Calendar/Drive, Eventbrite, and Buffer once connected. Ask about any of these — live OpenAI research is off because no API key is set.";
}

// Keep stored histories bounded. Trim only at a user turn so tool calls and
// their outputs are never separated from each other.
function trimAgentHistory(history, max = 60) {
  if (!Array.isArray(history) || history.length <= max) return history;
  const from = history.findIndex((item, index) => index >= history.length - max && item.role === "user");
  return from === -1 ? history : history.slice(from);
}

export async function runOperationsAgent(message, sessionId) {
  const key = sessionId ? `agent:${sessionId}` : null;
  if (!process.env.OPENAI_API_KEY) {
    const reply = demoReply(message);
    if (key) {
      const messages = getSession(key) || [];
      saveSession(key, [...messages, { role: "user", content: message }, { role: "assistant", content: reply }].slice(-40));
    }
    return { mode: "demo", reply };
  }
  const history = (key && getSession(key)) || [];
  const input = [...history, { role: "user", content: message }];
  const result = await run(buildAgent(), input, { maxTurns: 16 });
  if (key) saveSession(key, trimAgentHistory(result.history));
  return { mode: "live", reply: String(result.finalOutput || "No response generated.") };
}
