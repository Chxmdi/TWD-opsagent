import {
  allRecords,
  COLLECTIONS,
  deleteRecord,
  getKV,
  getRecord,
  insertRecord,
  lastUndoableChange,
  markReverted,
  resetDatabase,
  setKV,
  trimCollection,
  updateRecord
} from "./db.js";
import * as notion from "./integrations/notion.js";

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function logActivity(type, text) {
  insertRecord("activity", { id: id("activity"), type, text, at: new Date().toISOString() }, { history: false });
  trimCollection("activity", 40);
}

function insert(collection, prefix, item, type, text) {
  const record = insertRecord(collection, { id: id(prefix), ...item });
  logActivity(type, text(record));
  return record;
}

function patch(collection, recordId, changes, type, text, label) {
  const before = getRecord(collection, recordId);
  if (!before) throw new Error(`${label} not found`);
  const record = { ...before, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined && value !== null)) };
  updateRecord(collection, recordId, record, before);
  logActivity(type, text(record));
  return record;
}

export function readState() {
  const state = { event: getKV("event") };
  for (const collection of COLLECTIONS) state[collection] = allRecords(collection);
  return state;
}

export function updateEvent(changes) {
  const event = { ...getKV("event"), ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined && value !== null)) };
  setKV("event", event);
  logActivity("event", `Updated event details (${Object.keys(changes).join(", ")})`);
  return event;
}

// Tasks

export function createTask(input) {
  return insert("tasks", "task", {
    title: input.title.trim(),
    area: input.area || "Operations",
    priority: input.priority || "Medium",
    status: "To do",
    due: input.due || "This week",
    source: input.source || "app",
    createdAt: input.createdAt || new Date().toISOString()
  }, "task", (task) => `Created task: ${task.title}`);
}

export function updateTask(taskId, changes) {
  return patch("tasks", taskId, changes, "task", (task) => `Updated task: ${task.title}`, "Task");
}

export function importNotionTasks(tasks) {
  const localTasks = allRecords("tasks");
  let created = 0;
  let updated = 0;
  for (const task of tasks) {
    const existing = localTasks.find((item) => item.notionPageId === task.notionPageId)
      || getRecord("tasks", `notion-${String(task.notionPageId).replace(/-/g, "")}`);
    if (existing) {
      updateRecord("tasks", existing.id, { ...existing, ...task, id: existing.id, notionSyncError: null }, existing, { history: false });
      updated += 1;
    } else {
      insertRecord("tasks", { id: `notion-${String(task.notionPageId).replace(/-/g, "")}`, ...task }, { history: false });
      created += 1;
    }
  }
  return { created, updated };
}

export async function createSyncedTask(input) {
  const task = createTask(input);
  if (!notion.isConfigured()) return task;
  try {
    const page = await notion.createTask(task);
    return updateTask(task.id, { notionPageId: page.id, notionUrl: page.url, notionLastSyncedAt: new Date().toISOString(), notionSyncError: null });
  } catch (error) {
    return updateTask(task.id, { notionSyncError: error.message });
  }
}

export async function updateSyncedTask(taskId, changes) {
  let task = updateTask(taskId, changes);
  if (!notion.isConfigured()) return task;
  try {
    const page = task.notionPageId ? await notion.updateTask(task.notionPageId, task) : await notion.createTask(task);
    task = updateTask(task.id, { notionPageId: page.id, notionUrl: page.url, notionLastSyncedAt: new Date().toISOString(), notionSyncError: null });
  } catch (error) {
    task = updateTask(task.id, { notionSyncError: error.message });
  }
  return task;
}

export async function syncPendingTasksToNotion() {
  if (!notion.isConfigured()) return { synced: 0, failed: 0 };
  let synced = 0;
  let failed = 0;
  for (const task of allRecords("tasks").filter((item) => item.source === "app" && !item.notionPageId)) {
    try {
      const page = await notion.createTask(task);
      updateRecord("tasks", task.id, {
        ...task,
        notionPageId: page.id,
        notionUrl: page.url,
        notionLastSyncedAt: new Date().toISOString(),
        notionSyncError: null
      }, task, { history: false });
      synced += 1;
    } catch (error) {
      updateRecord("tasks", task.id, { ...task, notionSyncError: error.message }, task, { history: false });
      failed += 1;
    }
  }
  return { synced, failed };
}

// Sponsors and outreach

export function createSponsor(input) {
  return insert("sponsors", "sponsor", {
    name: input.name.trim(),
    sector: input.sector || "Community partner",
    fit: Number(input.fit || 70),
    stage: input.stage || "Research",
    contact: input.contact || "Contact not identified",
    reason: input.reason || "Alignment requires review",
    source: input.source || "Added manually — verify before outreach"
  }, "sponsor", (sponsor) => `Added sponsor lead: ${sponsor.name}`);
}

export function updateSponsor(sponsorId, changes) {
  return patch("sponsors", sponsorId, changes, "sponsor", (sponsor) => `Updated sponsor ${sponsor.name} (${sponsor.stage})`, "Sponsor");
}

export function createDraft(input) {
  const sponsor = getRecord("sponsors", input.sponsorId);
  if (!sponsor) throw new Error("Sponsor not found");
  return insert("outreach", "draft", {
    sponsorId: sponsor.id,
    sponsor: sponsor.name,
    to: input.to || "",
    subject: input.subject || `Partnership opportunity: The Wealth Dojo Experience`,
    body: input.body || `Hello ${sponsor.name} team,\n\nThe Wealth Dojo Experience is bringing practical wealth-building education and community connection to Calgary. Your work in ${sponsor.sector.toLowerCase()} makes you a strong potential partner.\n\nWould you be open to a short conversation about sponsorship, programming, or community partnership opportunities?\n\nBest regards,\nThe Wealth Dojo Team`,
    status: "Needs approval",
    updatedAt: new Date().toISOString()
  }, "outreach", (draft) => `Created approval-gated draft for ${draft.sponsor}`);
}

export function updateOutreachDraft(draftId, changes) {
  const allowed = Object.fromEntries(Object.entries(changes).filter(([key]) => ["subject", "body", "status", "to"].includes(key)));
  allowed.updatedAt = new Date().toISOString();
  return patch("outreach", draftId, allowed, "outreach", (draft) => `Updated outreach draft for ${draft.sponsor} (${draft.status})`, "Outreach draft");
}

// Approval-gated communications (volunteers, attendees, vendors, partners)

export function createCommsDraft(input) {
  return insert("commsDrafts", "comms", {
    audience: input.audience || "Volunteer",
    recipient: input.recipient || "Team",
    to: input.to || "",
    subject: input.subject || "Update from The Wealth Dojo",
    body: input.body || "",
    status: "Needs approval",
    updatedAt: new Date().toISOString()
  }, "comms", (draft) => `Created approval-gated ${draft.audience.toLowerCase()} message for ${draft.recipient}`);
}

export function updateCommsDraft(draftId, changes) {
  const allowed = Object.fromEntries(Object.entries(changes).filter(([key]) => ["subject", "body", "status", "recipient", "to"].includes(key)));
  allowed.updatedAt = new Date().toISOString();
  return patch("commsDrafts", draftId, allowed, "comms", (draft) => `Updated ${draft.audience.toLowerCase()} draft for ${draft.recipient} (${draft.status})`, "Comms draft");
}

export function markDraftSent(collection, draftId, info = {}) {
  const label = collection === "outreach" ? "Outreach draft" : "Comms draft";
  const draft = patch(collection, draftId, { status: "Sent", sentAt: new Date().toISOString(), sentVia: info.via || "manual", messageId: info.messageId }, "send", (record) => `Marked ${collection === "outreach" ? `outreach to ${record.sponsor}` : `${record.audience.toLowerCase()} message to ${record.recipient}`} as sent (${info.via || "manual"})`, label);
  if (collection === "outreach" && draft.sponsorId) {
    const sponsor = getRecord("sponsors", draft.sponsorId);
    if (sponsor && ["Research", "Qualified"].includes(sponsor.stage)) updateSponsor(sponsor.id, { stage: "Contacted" });
  }
  return draft;
}

// Event milestones, logistics, budget

export function createMilestone(input) {
  return insert("milestones", "milestone", {
    title: input.title.trim(),
    phase: input.phase || "Planning",
    due: input.due || "TBD",
    owner: input.owner || "Chimdi",
    status: input.status || "Not started",
    notes: input.notes || ""
  }, "event", (milestone) => `Added milestone: ${milestone.title}`);
}

export function updateMilestone(milestoneId, changes) {
  return patch("milestones", milestoneId, changes, "event", (milestone) => `Updated milestone: ${milestone.title} (${milestone.status})`, "Milestone");
}

export function createLogisticsItem(input) {
  return insert("logistics", "logistics", {
    item: input.item.trim(),
    category: input.category || "General",
    status: input.status || "Needed",
    owner: input.owner || "Chimdi",
    due: input.due || "TBD",
    notes: input.notes || ""
  }, "event", (record) => `Added logistics item: ${record.item}`);
}

export function updateLogisticsItem(itemId, changes) {
  return patch("logistics", itemId, changes, "event", (record) => `Updated logistics: ${record.item} (${record.status})`, "Logistics item");
}

export function createBudgetLine(input) {
  return insert("budget", "budget", {
    item: input.item.trim(),
    category: input.category || "General",
    planned: Number(input.planned || 0),
    actual: Number(input.actual || 0),
    status: input.status || "Planned",
    notes: input.notes || ""
  }, "budget", (line) => `Added budget line: ${line.item} ($${line.planned} planned)`);
}

export function updateBudgetLine(lineId, changes) {
  if (changes.planned !== undefined && changes.planned !== null) changes.planned = Number(changes.planned);
  if (changes.actual !== undefined && changes.actual !== null) changes.actual = Number(changes.actual);
  return patch("budget", lineId, changes, "budget", (line) => `Updated budget line: ${line.item}`, "Budget line");
}

export function budgetGuardrails() {
  const budget = allRecords("budget");
  const categories = {};
  for (const line of budget) {
    categories[line.category] ??= { planned: 0, actual: 0 };
    categories[line.category].planned += line.planned;
    categories[line.category].actual += line.actual;
  }
  const overruns = Object.entries(categories).filter(([, totals]) => totals.actual > totals.planned).map(([category, totals]) => ({ category, ...totals, over: totals.actual - totals.planned }));
  const planned = budget.reduce((sum, line) => sum + line.planned, 0);
  const actual = budget.reduce((sum, line) => sum + line.actual, 0);
  return { planned, actual, remaining: planned - actual, categories, overruns };
}

// Volunteers

export function createVolunteer(input) {
  return insert("volunteers", "volunteer", {
    name: input.name.trim(),
    role: input.role || "General support",
    stage: input.stage || "Applied",
    contact: input.contact || "Provided during application — internal only",
    shift: input.shift || "Unassigned",
    notes: input.notes || ""
  }, "volunteer", (volunteer) => `Added volunteer: ${volunteer.name} (${volunteer.role})`);
}

export function updateVolunteer(volunteerId, changes) {
  return patch("volunteers", volunteerId, changes, "volunteer", (volunteer) => `Updated volunteer ${volunteer.name} (${volunteer.stage})`, "Volunteer");
}

// Vendors

export function createVendor(input) {
  return insert("vendors", "vendor", {
    name: input.name.trim(),
    category: input.category || "General",
    status: input.status || "Research",
    cost: Number(input.cost || 0),
    deliverables: input.deliverables || "To be defined",
    contact: input.contact || "Contact not identified",
    notes: input.notes || ""
  }, "vendor", (vendor) => `Added vendor: ${vendor.name} (${vendor.category})`);
}

export function updateVendor(vendorId, changes) {
  if (changes.cost !== undefined && changes.cost !== null) changes.cost = Number(changes.cost);
  return patch("vendors", vendorId, changes, "vendor", (vendor) => `Updated vendor ${vendor.name} (${vendor.status})`, "Vendor");
}

// Meetings

export function createMeeting(input) {
  return insert("meetings", "meeting", {
    title: input.title.trim(),
    date: input.date || new Date().toISOString().slice(0, 10),
    attendees: input.attendees || [],
    agenda: input.agenda || [],
    notes: input.notes || "",
    actionItems: (input.actionItems || []).map((item) => ({
      id: id("action"),
      text: typeof item === "string" ? item : item.text,
      owner: item.owner || "Chimdi",
      due: item.due || "This week",
      converted: false
    }))
  }, "meeting", (meeting) => `Logged meeting: ${meeting.title}`);
}

export function updateMeeting(meetingId, changes) {
  return patch("meetings", meetingId, changes, "meeting", (meeting) => `Updated meeting: ${meeting.title}`, "Meeting");
}

export function convertActionItemsToTasks(meetingId) {
  const meeting = getRecord("meetings", meetingId);
  if (!meeting) throw new Error("Meeting not found");
  const created = [];
  const actionItems = meeting.actionItems.map((action) => {
    if (action.converted) return action;
    const task = insertRecord("tasks", { id: id("task"), title: action.text, area: "Operations", priority: "Medium", status: "To do", due: action.due || "This week", meetingId: meeting.id, source: "app", createdAt: new Date().toISOString() });
    created.push(task);
    return { ...action, converted: true };
  });
  const updated = { ...meeting, actionItems };
  updateRecord("meetings", meetingId, updated, meeting);
  logActivity("meeting", `Converted ${created.length} action item${created.length === 1 ? "" : "s"} from “${meeting.title}” into tasks`);
  return { meeting: updated, created };
}

// Documents / SOPs

export function createDocument(input) {
  return insert("documents", "document", {
    title: input.title.trim(),
    category: input.category || "Reference",
    version: 1,
    updatedAt: new Date().toISOString(),
    body: input.body || ""
  }, "document", (document) => `Created document: ${document.title}`);
}

export function updateDocument(documentId, changes) {
  const before = getRecord("documents", documentId);
  if (!before) throw new Error("Document not found");
  return patch("documents", documentId, { ...changes, version: before.version + 1, updatedAt: new Date().toISOString() }, "document", (document) => `Updated document: ${document.title} (v${document.version})`, "Document");
}

// Attendee experience

export function createTouchpoint(input) {
  return insert("attendeeTouchpoints", "touchpoint", {
    phase: input.phase || "Before",
    title: input.title.trim(),
    description: input.description || "",
    channel: input.channel || "Email",
    owner: input.owner || "Chimdi",
    status: input.status || "Planned"
  }, "attendee", (touchpoint) => `Added attendee touchpoint: ${touchpoint.title} (${touchpoint.phase})`);
}

export function updateTouchpoint(touchpointId, changes) {
  return patch("attendeeTouchpoints", touchpointId, changes, "attendee", (touchpoint) => `Updated touchpoint: ${touchpoint.title} (${touchpoint.status})`, "Touchpoint");
}

// Feedback

export function createFeedback(input) {
  return insert("feedback", "feedback", {
    source: input.source || "Attendee",
    phase: input.phase || "After",
    rating: Math.max(1, Math.min(5, Number(input.rating || 3))),
    comment: input.comment || "",
    at: new Date().toISOString()
  }, "feedback", (entry) => `Logged ${entry.source.toLowerCase()} feedback (${entry.rating}/5)`);
}

export function feedbackSummary() {
  const entries = allRecords("feedback");
  if (!entries.length) return { count: 0, average: null, byPhase: {}, low: [] };
  const byPhase = {};
  for (const entry of entries) {
    byPhase[entry.phase] ??= { count: 0, total: 0 };
    byPhase[entry.phase].count += 1;
    byPhase[entry.phase].total += entry.rating;
  }
  for (const phase of Object.keys(byPhase)) byPhase[phase].average = Math.round((byPhase[phase].total / byPhase[phase].count) * 10) / 10;
  return {
    count: entries.length,
    average: Math.round((entries.reduce((sum, entry) => sum + entry.rating, 0) / entries.length) * 10) / 10,
    byPhase,
    low: entries.filter((entry) => entry.rating <= 2)
  };
}

// Continuous improvement

export function createImprovement(input) {
  return insert("improvements", "improvement", {
    idea: input.idea.trim(),
    area: input.area || "Operations",
    impact: input.impact || "Medium",
    status: input.status || "Proposed"
  }, "improvement", (improvement) => `Logged improvement idea: ${improvement.idea}`);
}

export function updateImprovement(improvementId, changes) {
  return patch("improvements", improvementId, changes, "improvement", (improvement) => `Updated improvement: ${improvement.idea} (${improvement.status})`, "Improvement");
}

// Marketing strategies and campaigns

export function createStrategy(input) {
  return insert("strategies", "strategy", {
    title: input.title.trim(),
    audience: input.audience || "",
    positioning: input.positioning || "",
    channels: input.channels || [],
    budget: Number(input.budget || 0),
    kpis: input.kpis || [],
    status: input.status || "Draft",
    summary: input.summary || "",
    createdAt: new Date().toISOString()
  }, "marketing", (strategy) => `Created marketing strategy: ${strategy.title}`);
}

export function updateStrategy(strategyId, changes) {
  return patch("strategies", strategyId, changes, "marketing", (strategy) => `Updated strategy: ${strategy.title} (${strategy.status})`, "Strategy");
}

export function createCampaign(input) {
  return insert("campaigns", "campaign", {
    name: input.name.trim(),
    strategyId: input.strategyId || null,
    channel: input.channel || "Multi-channel",
    objective: input.objective || "",
    startDate: input.startDate || "TBD",
    endDate: input.endDate || "TBD",
    status: input.status || "Planned",
    budget: Number(input.budget || 0),
    metrics: input.metrics || "",
    contentCalendar: (input.contentCalendar || []).map((entry) => ({
      id: id("content"),
      date: entry.date || "TBD",
      channel: entry.channel || "Instagram",
      title: entry.title,
      status: entry.status || "Idea"
    }))
  }, "marketing", (campaign) => `Created campaign: ${campaign.name}`);
}

export function updateCampaign(campaignId, changes) {
  return patch("campaigns", campaignId, changes, "marketing", (campaign) => `Updated campaign: ${campaign.name} (${campaign.status})`, "Campaign");
}

export function addCalendarEntry(campaignId, entry) {
  const campaign = getRecord("campaigns", campaignId);
  if (!campaign) throw new Error("Campaign not found");
  const record = { id: id("content"), date: entry.date || "TBD", channel: entry.channel || "Instagram", title: entry.title, status: entry.status || "Idea" };
  updateRecord("campaigns", campaignId, { ...campaign, contentCalendar: [...campaign.contentCalendar, record] }, campaign);
  logActivity("marketing", `Added content to ${campaign.name}: ${record.title}`);
  return record;
}

// Run of show

export function createRunOfShowSlot(input) {
  return insert("runOfShow", "ros", {
    start: input.start || "09:00",
    end: input.end || "10:00",
    segment: input.segment.trim(),
    owner: input.owner || "Chimdi",
    location: input.location || "Main hall",
    notes: input.notes || ""
  }, "event", (slot) => `Added run-of-show slot: ${slot.start} ${slot.segment}`);
}

export function updateRunOfShowSlot(slotId, changes) {
  return patch("runOfShow", slotId, changes, "event", (slot) => `Updated run-of-show slot: ${slot.segment}`, "Run-of-show slot");
}

export function deleteRunOfShowSlot(slotId) {
  const removed = deleteRecord("runOfShow", slotId);
  if (!removed) throw new Error("Run-of-show slot not found");
  logActivity("event", `Removed run-of-show slot: ${removed.segment}`);
  return removed;
}

function toMinutes(time) {
  const match = String(time || "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function detectRunOfShowConflicts() {
  const slots = allRecords("runOfShow").map((slot) => ({ ...slot, startMin: toMinutes(slot.start), endMin: toMinutes(slot.end) })).filter((slot) => slot.startMin !== null && slot.endMin !== null);
  const conflicts = [];
  for (let a = 0; a < slots.length; a += 1) {
    for (let b = a + 1; b < slots.length; b += 1) {
      const one = slots[a], two = slots[b];
      const overlaps = one.startMin < two.endMin && two.startMin < one.endMin;
      if (!overlaps) continue;
      if (one.location === two.location) conflicts.push({ type: "location", slots: [one.segment, two.segment], detail: `Both use ${one.location} between ${two.start} and ${one.end}` });
      if (one.owner === two.owner) conflicts.push({ type: "owner", slots: [one.segment, two.segment], detail: `${one.owner} is double-booked between ${two.start} and ${one.end}` });
    }
  }
  return conflicts;
}

export function generateShiftPlan() {
  const slots = allRecords("runOfShow");
  const volunteers = allRecords("volunteers");
  const assignments = volunteers.map((volunteer) => {
    const window = volunteer.shift.match(/(\d{1,2}:\d{2})[^\d]+(\d{1,2}:\d{2})/);
    const from = window ? toMinutes(window[1]) : null;
    const to = window ? toMinutes(window[2]) : null;
    const assigned = slots.filter((slot) => {
      if (slot.owner === volunteer.name) return true;
      if (from === null) return false;
      const start = toMinutes(slot.start), end = toMinutes(slot.end);
      return start !== null && end !== null && start >= from && end <= to;
    });
    return { volunteer, assigned };
  });
  const covered = new Set(assignments.flatMap(({ assigned }) => assigned.map((slot) => slot.id)));
  const unstaffed = slots.filter((slot) => !covered.has(slot.id));
  const body = [
    "# Volunteer shift plan — event day",
    "",
    ...assignments.map(({ volunteer, assigned }) => [
      `## ${volunteer.name} — ${volunteer.role} (${volunteer.stage})`,
      `Shift: ${volunteer.shift}`,
      ...(assigned.length ? assigned.map((slot) => `- ${slot.start}–${slot.end} ${slot.segment} (${slot.location})`) : ["- No slots inside this shift window yet."]),
      ""
    ].join("\n")),
    "## Unstaffed segments",
    ...(unstaffed.length ? unstaffed.map((slot) => `- ${slot.start}–${slot.end} ${slot.segment} (owner: ${slot.owner})`) : ["- Every segment has volunteer coverage."])
  ].join("\n");
  const document = createDocument({ title: `Volunteer shift plan — ${new Date().toLocaleDateString("en-CA")}`, category: "Checklist", body });
  return { document, assignments: assignments.map(({ volunteer, assigned }) => ({ volunteer: volunteer.name, slots: assigned.length })), unstaffed: unstaffed.length };
}

// Sponsor packet

export function buildSponsorPacket() {
  const event = getKV("event");
  const strategy = allRecords("strategies")[0];
  const sponsors = allRecords("sponsors");
  const committed = sponsors.filter((sponsor) => sponsor.stage === "Committed").length;
  const body = [
    `# Sponsorship packet — ${event.name}`,
    "",
    `**${event.city} · ${event.date} · Target audience of ${event.ticketGoal}+ attendees**`,
    "",
    "## Why partner with us",
    strategy?.positioning || "The Wealth Dojo Experience brings practical wealth-building education and community connection to Calgary.",
    "",
    "## Who attends",
    strategy?.audience || "Calgary professionals interested in financial literacy, entrepreneurship, and community.",
    "",
    "## Sponsorship tiers",
    "| Tier | Investment (CAD) | Includes |",
    "|---|---|---|",
    "| Dojo Champion | $5,000 | Headline branding, keynote mention, booth, 10 tickets |",
    "| Community Builder | $2,500 | Stage branding, booth, 6 tickets |",
    "| Wealth Ally | $1,000 | Logo placement, social recognition, 4 tickets |",
    "| Friend of the Dojo | $500 | Program listing, 2 tickets |",
    "",
    "## Reach and momentum",
    `- ${event.ticketsSold} tickets already sold toward a goal of ${event.ticketGoal}`,
    `- ${sponsors.length} partner organizations in conversation${committed ? `, ${committed} committed` : ""}`,
    ...(strategy?.channels?.length ? [`- Active channels: ${strategy.channels.join(", ")}`] : []),
    "",
    "## Contact",
    "The Wealth Dojo — thewealthdojoo@gmail.com",
    "",
    "*All partnership terms are finalized by a person; this packet is informational.*"
  ].join("\n");
  return createDocument({ title: `Sponsorship packet — ${new Date().toLocaleDateString("en-CA")}`, category: "Reference", body });
}

// Attention / deadlines

export function getAttention() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const soon = new Date(now.getTime() + 14 * 86400000).toISOString().slice(0, 10);
  const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  const state = readState();

  const overdueMilestones = state.milestones.filter((milestone) => milestone.status !== "Done" && isDate(milestone.due) && milestone.due < today);
  const upcomingMilestones = state.milestones.filter((milestone) => milestone.status !== "Done" && isDate(milestone.due) && milestone.due >= today && milestone.due <= soon);
  const overdueLogistics = state.logistics.filter((item) => !["Confirmed", "Done"].includes(item.status) && isDate(item.due) && item.due < today);
  const staleCutoff = now.getTime() - 48 * 3600000;
  const staleDrafts = [...state.outreach, ...state.commsDrafts].filter((draft) => draft.status === "Needs approval" && new Date(draft.updatedAt).getTime() < staleCutoff);
  const highPriorityTasks = state.tasks.filter((task) => task.priority === "High" && task.status === "To do");
  const overruns = budgetGuardrails().overruns;
  const conflicts = detectRunOfShowConflicts();

  const items = [
    ...overdueMilestones.map((milestone) => `Overdue milestone: ${milestone.title} (due ${milestone.due})`),
    ...overdueLogistics.map((item) => `Overdue logistics: ${item.item} (due ${item.due})`),
    ...overruns.map((overrun) => `Budget overrun in ${overrun.category}: $${overrun.over} over plan`),
    ...conflicts.map((conflict) => `Run-of-show conflict: ${conflict.detail}`),
    ...staleDrafts.map((draft) => `Draft waiting >48h for approval: ${draft.subject}`),
    ...upcomingMilestones.map((milestone) => `Upcoming milestone: ${milestone.title} (due ${milestone.due})`),
    ...highPriorityTasks.map((task) => `High-priority task not started: ${task.title}`)
  ];

  return {
    items,
    counts: {
      overdue: overdueMilestones.length + overdueLogistics.length,
      upcoming: upcomingMilestones.length,
      staleDrafts: staleDrafts.length,
      highPriorityTasks: highPriorityTasks.length,
      overruns: overruns.length,
      conflicts: conflicts.length
    }
  };
}

export function createDigestEntry(attention) {
  logActivity("digest", `Daily digest: ${attention.items.length} item${attention.items.length === 1 ? "" : "s"} need attention — ${attention.items.slice(0, 3).join("; ")}${attention.items.length > 3 ? "; …" : ""}`);
}

// Undo

export function undoLastChange() {
  const change = lastUndoableChange();
  if (!change) throw new Error("Nothing to undo");
  const before = change.before ? JSON.parse(change.before) : null;
  const after = change.after ? JSON.parse(change.after) : null;
  if (change.action === "create") {
    deleteRecord(change.collection, change.record_id, { history: false });
  } else if (change.action === "update") {
    updateRecord(change.collection, change.record_id, before, after, { history: false });
  } else if (change.action === "delete") {
    insertRecord(change.collection, before, { history: false });
  }
  markReverted(change.seq);
  const label = before?.title || before?.name || after?.title || after?.name || before?.subject || after?.subject || change.record_id;
  logActivity("undo", `Undid ${change.action} in ${change.collection}: ${label}`);
  return { action: change.action, collection: change.collection, recordId: change.record_id };
}

// Reporting

export function generateWeeklyReport() {
  const state = readState();
  const completed = state.tasks.filter((task) => task.status === "Done").length;
  const active = state.tasks.filter((task) => task.status === "In progress").length;
  const qualified = state.sponsors.filter((sponsor) => ["Qualified", "Contacted", "Meeting", "Committed"].includes(sponsor.stage)).length;
  const pendingDrafts = state.outreach.filter((draft) => draft.status === "Needs approval").length + state.commsDrafts.filter((draft) => draft.status === "Needs approval").length;
  const sentDrafts = [...state.outreach, ...state.commsDrafts].filter((draft) => draft.status === "Sent").length;
  const volunteersReady = state.volunteers.filter((volunteer) => ["Onboarded", "Scheduled", "Active"].includes(volunteer.stage)).length;
  const vendorsBooked = state.vendors.filter((vendor) => ["Booked", "Confirmed", "Completed"].includes(vendor.status)).length;
  const milestonesDone = state.milestones.filter((milestone) => milestone.status === "Done").length;
  const logisticsOpen = state.logistics.filter((item) => !["Confirmed", "Done"].includes(item.status)).length;
  const guardrails = budgetGuardrails();
  const activeCampaigns = state.campaigns.filter((campaign) => campaign.status === "Active").length;
  const openActions = state.meetings.flatMap((meeting) => meeting.actionItems).filter((action) => !action.converted).length;
  const attention = getAttention();

  const nextMoves = [];
  if (attention.counts.overdue) nextMoves.push(`Clear ${attention.counts.overdue} overdue milestone/logistics item${attention.counts.overdue === 1 ? "" : "s"} first.`);
  if (logisticsOpen) nextMoves.push(`Close out ${logisticsOpen} open logistics item${logisticsOpen === 1 ? "" : "s"} (venue, AV, catering first).`);
  if (openActions) nextMoves.push(`Convert ${openActions} outstanding meeting action item${openActions === 1 ? "" : "s"} into tracked tasks.`);
  if (pendingDrafts) nextMoves.push(`Review and approve ${pendingDrafts} pending draft${pendingDrafts === 1 ? "" : "s"} — nothing sends without approval.`);
  if (guardrails.overruns.length) nextMoves.push(`Resolve budget overruns in: ${guardrails.overruns.map((overrun) => overrun.category).join(", ")}.`);
  const notReady = state.volunteers.length - volunteersReady;
  if (notReady > 0) nextMoves.push(`Move ${notReady} volunteer${notReady === 1 ? "" : "s"} through onboarding before the Sep 12 training.`);
  if (!activeCampaigns) nextMoves.push("Activate the first marketing campaign to build ticket momentum.");
  if (!nextMoves.length) nextMoves.push("Operations are on track — focus on ticket sales and sponsor conversations.");

  const report = insertRecord("reports", {
    id: id("report"),
    title: `Weekly operations report — ${new Date().toLocaleDateString("en-CA")}`,
    createdAt: new Date().toISOString(),
    metrics: {
      completed, active, totalTasks: state.tasks.length,
      qualifiedSponsors: qualified, totalSponsors: state.sponsors.length,
      pendingDrafts, sentDrafts,
      volunteersReady, totalVolunteers: state.volunteers.length,
      vendorsBooked, totalVendors: state.vendors.length,
      milestonesDone, totalMilestones: state.milestones.length,
      logisticsOpen,
      plannedBudget: guardrails.planned, actualBudget: guardrails.actual,
      activeCampaigns,
      ticketsSold: state.event.ticketsSold, ticketGoal: state.event.ticketGoal,
      attentionItems: attention.items.length
    },
    summary: `${completed} tasks completed and ${active} in progress. ${qualified} qualified or active sponsor relationships. ${volunteersReady} of ${state.volunteers.length} volunteers event-ready, ${vendorsBooked} of ${state.vendors.length} vendors booked, ${milestonesDone} of ${state.milestones.length} milestones done. Budget: $${guardrails.actual} spent of $${guardrails.planned} planned. ${state.event.ticketsSold} of ${state.event.ticketGoal} tickets sold. ${pendingDrafts} draft${pendingDrafts === 1 ? "" : "s"} awaiting approval, ${sentDrafts} sent. ${attention.items.length} item${attention.items.length === 1 ? "" : "s"} need attention.`,
    nextMoves
  }, { history: false });
  logActivity("report", `Generated ${report.title}`);
  return report;
}

export function resetStore() {
  resetDatabase();
}
