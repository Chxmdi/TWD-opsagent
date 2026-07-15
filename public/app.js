let state;
let integrations = { google: {}, eventbrite: {}, buffer: {} };
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

function authHeaders() {
  const token = localStorage.getItem("wd-token");
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request(path, options = {}, retried = false) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...authHeaders(), ...(options.headers || {}) } });
  if (response.status === 401 && response.headers.get("x-auth-mode") === "single-user") {
    window.location.assign(`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
    throw new Error("Authentication required");
  }
  if (response.status === 401 && !retried) {
    const token = prompt("This workspace is protected. Enter the access token:");
    if (token) {
      localStorage.setItem("wd-token", token);
      return request(path, options, true);
    }
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function downloadFile(path, filename) {
  const response = await fetch(path, { headers: authHeaders() });
  if (response.status === 401 && response.headers.get("x-auth-mode") === "single-user") {
    window.location.assign(`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
    throw new Error("Authentication required");
  }
  if (!response.ok) throw new Error("Download failed");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

function relativeTime(value) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
}

function money(value) {
  return `$${Number(value || 0).toLocaleString("en-CA")}`;
}

function sessionId() {
  let id = localStorage.getItem("wd-session");
  if (!id) {
    id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    localStorage.setItem("wd-session", id);
  }
  return id;
}

function select(attribute, id, options, current, label) {
  return `<select data-${attribute}="${id}" aria-label="${label}">${options.map((option) => `<option ${option === current ? "selected" : ""}>${option}</option>`).join("")}</select>`;
}

function markdown(text) {
  const lines = (text || "").split("\n");
  const out = [];
  let list = false, table = false;
  const inline = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  for (const line of lines) {
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s\-|:]+\|\s*$/.test(line)) continue;
      const cells = line.split("|").slice(1, -1).map((cell) => `<td>${inline(cell.trim())}</td>`).join("");
      if (!table) { out.push("<table>"); table = true; }
      out.push(`<tr>${cells}</tr>`);
      continue;
    }
    if (table) { out.push("</table>"); table = false; }
    if (/^\s*[-*] /.test(line)) {
      if (!list) { out.push("<ul>"); list = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`);
      continue;
    }
    if (list) { out.push("</ul>"); list = false; }
    const heading = line.match(/^(#{1,3}) (.+)/);
    if (heading) { out.push(`<h${heading[1].length + 2}>${inline(heading[2])}</h${heading[1].length + 2}>`); continue; }
    if (/^\s*\d+\. /.test(line)) { out.push(`<p class="md-step">${inline(line.trim())}</p>`); continue; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push("</ul>");
  if (table) out.push("</table>");
  return out.join("");
}

async function renderAttention() {
  try {
    const attention = await request("/api/attention");
    $("#attention-banner").innerHTML = attention.items.length
      ? `<div class="attention"><b>⚠ ${attention.items.length} item${attention.items.length === 1 ? "" : "s"} need attention</b><ul>${attention.items.slice(0, 5).map((item) => `<li>${item}</li>`).join("")}</ul>${attention.items.length > 5 ? `<small>+${attention.items.length - 5} more — ask the agent for the full list</small>` : ""}</div>`
      : "";
  } catch { $("#attention-banner").innerHTML = ""; }
}

async function renderIntegrations() {
  try {
    integrations = await request("/api/integrations");
  } catch { return; }
  const google = integrations.google;
  const chip = (ok, text) => `<span class="badge ${ok ? "ok" : ""}">${ok ? "●" : "○"} ${text}</span>`;
  $("#integrations-panel").innerHTML = `
    <div class="integration"><div><h3>Google — Gmail, Calendar, Drive</h3><p class="subtle">${google.connected ? `Connected as ${google.email || "your account"}. Approved drafts can send; milestones sync to Calendar; docs export to Drive.` : google.configured ? "Configured — connect your account to enable sending, Calendar, and Drive." : "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local to enable."}</p></div>${google.connected ? chip(true, "Connected") : google.configured ? `<a class="draft-button" href="/auth/google">Connect Google</a>` : chip(false, "Not configured")}</div>
    <div class="integration"><div><h3>Eventbrite — live ticket counts</h3><p class="subtle">${integrations.eventbrite.configured ? "Configured. Tickets sync hourly; you can also sync now." : "Set EVENTBRITE_TOKEN and EVENTBRITE_EVENT_ID to pull real ticket sales."}</p></div>${integrations.eventbrite.configured ? `<button class="draft-button" id="sync-tickets">Sync now</button>` : chip(false, "Not configured")}</div>
    <div class="integration"><div><h3>Buffer — content queue</h3><p class="subtle">${integrations.buffer.configured ? "Configured. Queue content-calendar entries from the Marketing view." : "Set BUFFER_TOKEN and BUFFER_PROFILE_ID to queue planned posts."}</p></div>${chip(integrations.buffer.configured, integrations.buffer.configured ? "Ready" : "Not configured")}</div>`;
}

function renderOverview() {
  const open = state.tasks.filter((task) => task.status !== "Done");
  const high = open.filter((task) => task.priority === "High");
  const qualified = state.sponsors.filter((sponsor) => sponsor.stage !== "Research");
  const pending = [...state.outreach, ...state.commsDrafts].filter((draft) => draft.status === "Needs approval").length;
  const ready = state.volunteers.filter((volunteer) => ["Onboarded", "Scheduled", "Active"].includes(volunteer.stage));
  const booked = state.vendors.filter((vendor) => ["Booked", "Confirmed", "Completed"].includes(vendor.status));
  const openLogistics = state.logistics.filter((item) => !["Confirmed", "Done"].includes(item.status));
  const activeCampaigns = state.campaigns.filter((campaign) => campaign.status === "Active");
  const percent = Math.round((state.event.ticketsSold / state.event.ticketGoal) * 100);
  $("#ticket-percent").textContent = `${percent}%`;
  $("#ticket-count").textContent = `${state.event.ticketsSold} of ${state.event.ticketGoal}`;
  $("#ticket-ring").style.background = `conic-gradient(var(--green) 0 ${percent}%, rgba(255,255,255,.35) ${percent}%)`;
  $("#metrics").innerHTML = [
    [open.length, "Open tasks"], [high.length, "High priority"], [qualified.length, "Active sponsor leads"], [pending, "Drafts awaiting approval"],
    [`${ready.length}/${state.volunteers.length}`, "Volunteers ready"], [`${booked.length}/${state.vendors.length}`, "Vendors booked"], [openLogistics.length, "Open logistics"], [activeCampaigns.length, "Active campaigns"]
  ].map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
  $("#priority-list").innerHTML = open.slice().sort((a, b) => (a.priority === "High" ? -1 : 1)).slice(0, 4).map((task, index) => `<div class="priority-item"><span class="index">0${index + 1}</span><div><h3>${task.title}</h3><p>${task.area} · ${task.due}</p></div><span class="badge ${task.priority.toLowerCase()}">${task.priority}</span></div>`).join("");
  $("#activity-list").innerHTML = state.activity.slice(0, 6).map((item) => `<div class="activity"><div><p>${item.text}</p><small>${relativeTime(item.at)}</small></div></div>`).join("");
  const stages = ["Research", "Qualified", "Contacted", "Meeting", "Committed"];
  $("#pipeline-strip").innerHTML = stages.map((stage) => `<div class="pipeline-stage"><b>${state.sponsors.filter((sponsor) => sponsor.stage === stage).length}</b><span>${stage}</span></div>`).join("");
}

function renderTasks() {
  const columns = ["To do", "In progress", "Done"];
  $("#kanban").innerHTML = columns.map((status) => {
    const tasks = state.tasks.filter((task) => task.status === status);
    return `<div class="kanban-column"><div class="column-title"><b>${status}</b><span>${tasks.length}</span></div>${tasks.map((task) => `<article class="task-card"><h3>${task.title}</h3><div class="task-meta"><span>${task.area}</span><span>${task.due}</span></div>${select("task-status", task.id, columns, task.status, `Update ${task.title} status`)}</article>`).join("")}</div>`;
  }).join("");
}

function calendarButton(kind, record) {
  if (record.calendarLink) return `<a class="text-button" href="${record.calendarLink}" target="_blank" rel="noopener">On Calendar ↗</a>`;
  if (!integrations.google?.connected) return "";
  return `<button class="text-button" data-calendar="${kind}:${record.id}">+ Calendar</button>`;
}

function renderEvent() {
  const milestoneStatuses = ["Not started", "In progress", "Done"];
  $("#milestone-list").innerHTML = state.milestones.map((milestone) => `<div class="milestone-item ${milestone.status === "Done" ? "done" : ""}"><div class="milestone-phase">${milestone.phase}</div><div><h3>${milestone.title}</h3><p class="subtle">${milestone.owner} · due ${milestone.due}${milestone.notes ? ` — ${milestone.notes}` : ""} ${calendarButton("milestones", milestone)}</p></div>${select("milestone-status", milestone.id, milestoneStatuses, milestone.status, `Update ${milestone.title} status`)}</div>`).join("");
  const logisticsStatuses = ["Needed", "Sourcing", "Booked", "Confirmed", "Done"];
  $("#logistics-list").innerHTML = state.logistics.map((item) => `<div class="line-item"><div><h3>${item.item}</h3><p class="subtle">${item.category} · ${item.owner} · due ${item.due}</p></div>${select("logistics-status", item.id, logisticsStatuses, item.status, `Update ${item.item} status`)}</div>`).join("");

  const categories = {};
  for (const line of state.budget) {
    categories[line.category] ??= { planned: 0, actual: 0 };
    categories[line.category].planned += line.planned;
    categories[line.category].actual += line.actual;
  }
  const overruns = Object.entries(categories).filter(([, totals]) => totals.actual > totals.planned);
  $("#budget-warning").innerHTML = overruns.length ? `<span class="badge high">⚠ Over plan: ${overruns.map(([category]) => category).join(", ")}</span>` : "";
  const planned = state.budget.reduce((sum, line) => sum + line.planned, 0);
  const actual = state.budget.reduce((sum, line) => sum + line.actual, 0);
  const budgetStatuses = ["Planned", "Committed", "Paid"];
  $("#budget-list").innerHTML = state.budget.map((line) => {
    const over = line.actual > line.planned;
    return `<div class="line-item"><div><h3>${line.item}${over ? ` <span class="badge high">over</span>` : ""}</h3><p class="subtle">${line.category} · ${money(line.actual)} of ${money(line.planned)}</p></div>${select("budget-status", line.id, budgetStatuses, line.status, `Update ${line.item} status`)}</div>`;
  }).join("") + `<div class="line-item total"><div><h3>Total</h3></div><b>${money(actual)} / ${money(planned)}</b></div>`;

  const slots = state.runOfShow;
  $("#ros-list").innerHTML = slots.length
    ? `<div class="sponsor-row header ros"><span>Time</span><span>Segment</span><span>Owner</span><span>Location</span><span></span></div>${slots.map((slot) => `<div class="sponsor-row ros"><span class="fit">${slot.start}–${slot.end}</span><div class="sponsor-name"><strong>${slot.segment}</strong>${slot.notes ? `<small>${slot.notes}</small>` : ""}</div><span>${slot.owner}</span><span>${slot.location}</span><button class="draft-button danger" data-delete-slot="${slot.id}">Remove</button></div>`).join("")}`
    : `<p class="subtle">No run-of-show slots yet.</p>`;
}

async function renderRosConflicts() {
  try {
    const conflicts = await request("/api/run-of-show/conflicts");
    $("#ros-conflicts").innerHTML = conflicts.length ? `<div class="attention slim"><b>⚠ ${conflicts.length} schedule conflict${conflicts.length === 1 ? "" : "s"}</b><ul>${conflicts.map((conflict) => `<li>${conflict.detail}</li>`).join("")}</ul></div>` : "";
  } catch { $("#ros-conflicts").innerHTML = ""; }
}

function renderVolunteers() {
  const stages = ["Applied", "Interviewed", "Onboarded", "Scheduled", "Active"];
  $("#volunteer-table").innerHTML = `<div class="sponsor-row header five"><span>Volunteer</span><span>Role</span><span>Stage</span><span>Shift</span><span>Action</span></div>${state.volunteers.map((volunteer) => `<div class="sponsor-row five"><div class="sponsor-name"><strong>${volunteer.name}</strong><small>${volunteer.notes || volunteer.contact}</small></div><span>${volunteer.role}</span>${select("volunteer-stage", volunteer.id, stages, volunteer.stage, `Update ${volunteer.name} stage`)}<span>${volunteer.shift}</span><button class="draft-button" data-volunteer-draft="${volunteer.id}">Draft message</button></div>`).join("")}`;
  renderCommsList("#volunteer-comms", ["Volunteer"]);
}

function renderVendors() {
  const statuses = ["Research", "Contacted", "Quote received", "Booked", "Confirmed", "Completed"];
  $("#vendor-table").innerHTML = `<div class="sponsor-row header five"><span>Vendor</span><span>Category</span><span>Status</span><span>Cost</span><span>Deliverables</span></div>${state.vendors.map((vendor) => `<div class="sponsor-row five"><div class="sponsor-name"><strong>${vendor.name}</strong><small>${vendor.contact}</small></div><span>${vendor.category}</span>${select("vendor-status", vendor.id, statuses, vendor.status, `Update ${vendor.name} status`)}<span class="fit">${vendor.cost ? money(vendor.cost) : "—"}</span><span>${vendor.deliverables}</span></div>`).join("")}`;
}

function renderMeetings() {
  $("#meeting-list").innerHTML = state.meetings.length ? state.meetings.map((meeting) => {
    const open = meeting.actionItems.filter((action) => !action.converted);
    return `<article class="report-card"><div><p class="card-kicker">${meeting.date}</p><h3>${meeting.title}</h3><p class="subtle">${meeting.attendees.join(", ")}</p><p>${calendarButton("meetings", meeting)}</p></div><div>${meeting.agenda.length ? `<h4>Agenda</h4><ul>${meeting.agenda.map((item) => `<li>${item}</li>`).join("")}</ul>` : ""}${meeting.notes ? `<h4>Notes</h4><p>${meeting.notes}</p>` : ""}<h4>Action items</h4><ul>${meeting.actionItems.map((action) => `<li>${action.text} — ${action.owner}, ${action.due} ${action.converted ? `<span class="badge">Task created</span>` : ""}</li>`).join("") || "<li>None recorded.</li>"}</ul>${open.length ? `<button class="primary" data-convert-meeting="${meeting.id}">Convert ${open.length} action item${open.length === 1 ? "" : "s"} to tasks</button>` : ""}</div></article>`;
  }).join("") : `<article class="panel">No meetings recorded yet. Ask the agent to prepare your next agenda.</article>`;
}

function renderSponsors() {
  const stages = ["Research", "Qualified", "Contacted", "Meeting", "Committed", "Declined"];
  $("#sponsor-table").innerHTML = `<div class="sponsor-row header"><span>Organization</span><span>Sector</span><span>Fit</span><span>Stage</span><span>Why it fits</span><span>Action</span></div>${state.sponsors.slice().sort((a, b) => b.fit - a.fit).map((sponsor) => `<div class="sponsor-row"><div class="sponsor-name"><strong>${sponsor.name}</strong><small>${sponsor.source}</small></div><span>${sponsor.sector}</span><span class="fit">${sponsor.fit}%</span>${select("sponsor-stage", sponsor.id, stages, sponsor.stage, `Update ${sponsor.name} stage`)}<span>${sponsor.reason}</span><button class="draft-button" data-draft="${sponsor.id}">Draft</button></div>`).join("")}`;
}

function draftControls(draft, kind) {
  const editButton = `<button class="draft-button" data-edit-draft="${kind}:${draft.id}">Edit</button>`;
  if (draft.status === "Needs approval") return `${editButton}<button class="draft-button approve" data-approve="${kind}:${draft.id}">Approve</button><button class="draft-button danger" data-reject="${kind}:${draft.id}">Reject</button>`;
  if (draft.status === "Approved") {
    const gmail = integrations.google?.connected
      ? `<button class="draft-button approve" data-send="${kind}:${draft.id}">Send via Gmail</button>`
      : `<a class="draft-button" href="/auth/google" title="Connect Google to send email">Connect to send</a>`;
    return `${editButton}${gmail}<button class="draft-button" data-send-manual="${kind}:${draft.id}">Mark as sent</button>`;
  }
  if (draft.status === "Rejected") return `${editButton}<button class="draft-button" data-reopen="${kind}:${draft.id}">Reopen</button>`;
  return "";
}

function draftCard(draft, kicker, kind) {
  const statusClass = { "Needs approval": "pending", Approved: "approved", Sent: "sent", Rejected: "rejected" }[draft.status] || "pending";
  const meta = draft.status === "Sent"
    ? `Sent ${draft.sentVia === "gmail" ? "via Gmail" : "manually"} ${draft.sentAt ? relativeTime(draft.sentAt) : ""}`
    : draft.to ? `To: ${draft.to}` : "No recipient email set";
  return `<article class="draft-card" id="card-${draft.id}"><div><p class="card-kicker">${kicker}</p><h3>${draft.subject}</h3><p class="approval ${statusClass}">● ${draft.status}</p><p class="subtle">${meta}</p><div class="draft-actions">${draftControls(draft, kind)}</div></div><div class="draft-body">${draft.body}</div></article>`;
}

function draftEditor(draft, kind) {
  return `<article class="draft-card editing" id="card-${draft.id}"><form class="draft-edit-form" data-save-draft="${kind}:${draft.id}">
    <label>Subject<input name="subject" value="${draft.subject.replace(/"/g, "&quot;")}" required></label>
    <label>Recipient email<input name="to" type="email" value="${(draft.to || "").replace(/"/g, "&quot;")}" placeholder="name@example.com"></label>
    <label>Body<textarea name="body" rows="9" required>${draft.body.replace(/</g, "&lt;")}</textarea></label>
    <div class="draft-actions"><button class="draft-button approve" type="submit">Save</button><button class="draft-button" type="button" data-cancel-edit>Cancel</button></div>
  </form></article>`;
}

const editing = new Set();

function renderOutreach() {
  $("#outreach-list").innerHTML = state.outreach.length
    ? state.outreach.map((draft) => editing.has(draft.id) ? draftEditor(draft, "outreach") : draftCard(draft, draft.sponsor, "outreach")).join("")
    : `<article class="panel">No drafts yet.</article>`;
}

function renderCommsList(selector, audiences) {
  const drafts = state.commsDrafts.filter((draft) => audiences.includes(draft.audience));
  $(selector).innerHTML = drafts.length
    ? drafts.map((draft) => editing.has(draft.id) ? draftEditor(draft, "comms") : draftCard(draft, `${draft.audience} · ${draft.recipient}`, "comms")).join("")
    : `<article class="panel">No drafts yet. Ask the agent to prepare one.</article>`;
}

function renderMarketing() {
  $("#strategy-list").innerHTML = state.strategies.length ? state.strategies.map((strategy) => `<article class="report-card"><div><p class="card-kicker">${strategy.status.toUpperCase()} · ${money(strategy.budget)}</p><h3>${strategy.title}</h3><div class="chip-row">${strategy.channels.map((channel) => `<span class="badge">${channel}</span>`).join("")}</div></div><div><h4>Audience</h4><p>${strategy.audience}</p><h4>Positioning</h4><p>${strategy.positioning}</p>${strategy.summary ? `<h4>Approach</h4><p>${strategy.summary}</p>` : ""}<h4>KPIs</h4><ul>${strategy.kpis.map((kpi) => `<li>${kpi}</li>`).join("")}</ul></div></article>`).join("") : `<article class="panel">No strategies yet. Ask the agent to research the audience and build one.</article>`;
  $("#campaign-list").innerHTML = state.campaigns.length ? state.campaigns.map((campaign) => `<article class="report-card"><div><p class="card-kicker">${campaign.status.toUpperCase()} · ${campaign.channel}</p><h3>${campaign.name}</h3><p class="subtle">${campaign.startDate} → ${campaign.endDate}${campaign.budget ? ` · ${money(campaign.budget)}` : ""}</p><div class="draft-actions"><button class="draft-button" data-export="${campaign.id}:ics">Export .ics</button><button class="draft-button" data-export="${campaign.id}:csv">Export .csv</button></div></div><div><p>${campaign.objective}</p>${campaign.metrics ? `<p class="subtle">Metrics: ${campaign.metrics}</p>` : ""}<h4>Content calendar</h4><ul>${campaign.contentCalendar.map((entry) => `<li>${entry.date} · ${entry.channel} — ${entry.title} <span class="badge">${entry.status}</span>${integrations.buffer?.configured ? ` <button class="text-button" data-buffer="${campaign.id}:${entry.id}">Queue in Buffer</button>` : ""}</li>`).join("") || "<li>No content planned yet.</li>"}</ul></div></article>`).join("") : `<article class="panel">No campaigns yet.</article>`;
}

function renderAttendees() {
  const statuses = ["Planned", "Ready", "Live", "Done"];
  $("#journey-board").innerHTML = ["Before", "During", "After"].map((phase) => {
    const touchpoints = state.attendeeTouchpoints.filter((touchpoint) => touchpoint.phase === phase);
    return `<div class="kanban-column"><div class="column-title"><b>${phase}</b><span>${touchpoints.length}</span></div>${touchpoints.map((touchpoint) => `<article class="task-card"><h3>${touchpoint.title}</h3><p class="subtle" style="font-size:12px">${touchpoint.description}</p><div class="task-meta"><span>${touchpoint.channel}</span><span>${touchpoint.owner}</span></div>${select("touchpoint-status", touchpoint.id, statuses, touchpoint.status, `Update ${touchpoint.title} status`)}</article>`).join("")}</div>`;
  }).join("");
  $("#feedback-list").innerHTML = state.feedback.length
    ? state.feedback.slice(0, 12).map((entry) => `<div class="line-item"><div><h3>${"★".repeat(entry.rating)}${"☆".repeat(5 - entry.rating)} ${entry.comment}</h3><p class="subtle">${entry.source} · ${entry.phase} · ${relativeTime(entry.at)}</p></div></div>`).join("")
    : `<p class="subtle" style="margin-top:14px">No feedback yet. Log the first entry above.</p>`;
  renderCommsList("#attendee-comms", ["Attendee", "Vendor", "Partner"]);
}

function renderDocs() {
  $("#document-list").innerHTML = state.documents.length ? state.documents.map((document) => `<article class="report-card"><div><p class="card-kicker">${document.category.toUpperCase()} · V${document.version}</p><h3>${document.title}</h3><p class="subtle">Updated ${relativeTime(document.updatedAt)}</p><div class="draft-actions"><button class="draft-button" data-download-doc="${document.id}">Download .md</button>${integrations.google?.connected ? `<button class="draft-button" data-drive-doc="${document.id}">Export to Drive</button>` : ""}</div></div><div class="doc-body">${markdown(document.body)}</div></article>`).join("") : `<article class="panel">No documents yet.</article>`;
  $("#improvement-list").innerHTML = state.improvements.length ? state.improvements.map((improvement) => `<div class="line-item"><div><h3>${improvement.idea}</h3><p class="subtle">${improvement.area} · ${improvement.impact} impact</p></div>${select("improvement-status", improvement.id, ["Proposed", "Approved", "In progress", "Done"], improvement.status, `Update improvement status`)}</div>`).join("") : `<p class="subtle">No improvement ideas logged yet.</p>`;
}

function renderReports() {
  $("#report-list").innerHTML = state.reports.length ? state.reports.map((report) => `<article class="report-card"><div><p class="card-kicker">${new Date(report.createdAt).toLocaleDateString()}</p><h3>${report.title}</h3></div><div><p>${report.summary}</p><div class="report-metrics"><span><b>${report.metrics.completed}</b><small>Completed</small></span><span><b>${report.metrics.active}</b><small>Active</small></span><span><b>${report.metrics.qualifiedSponsors}</b><small>Qualified</small></span>${report.metrics.volunteersReady !== undefined ? `<span><b>${report.metrics.volunteersReady}</b><small>Volunteers ready</small></span><span><b>${report.metrics.vendorsBooked}</b><small>Vendors booked</small></span>` : ""}</div><h4>Next moves</h4><ul>${report.nextMoves.map((move) => `<li>${move}</li>`).join("")}</ul></div></article>`).join("") : `<article class="panel">No reports yet. Generate the first weekly report.</article>`;
}

function render() {
  renderOverview(); renderTasks(); renderEvent(); renderVolunteers(); renderVendors(); renderMeetings();
  renderSponsors(); renderOutreach(); renderMarketing(); renderAttendees(); renderDocs(); renderReports();
  renderAttention(); renderRosConflicts();
}

async function refresh() {
  state = await request("/api/state");
  render();
}

function showView(name) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openAgent(prompt) {
  const panel = $("#agent-panel");
  panel.classList.add("open"); panel.setAttribute("aria-hidden", "false");
  if (prompt) { $("#agent-input").value = prompt; $("#agent-form").requestSubmit(); }
}

function message(role, text) {
  const el = document.createElement("div");
  el.className = `message ${role}`; el.textContent = text;
  $("#messages").append(el); el.scrollIntoView({ behavior: "smooth" });
}

async function generateReport() {
  await request("/api/reports/weekly", { method: "POST", body: "{}" });
  await refresh(); showView("reports"); toast("Weekly report generated");
}

const patchRoutes = {
  "task-status": ["/api/tasks", "status", "Task updated"],
  "sponsor-stage": ["/api/sponsors", "stage", "Sponsor stage updated"],
  "milestone-status": ["/api/milestones", "status", "Milestone updated"],
  "logistics-status": ["/api/logistics", "status", "Logistics updated"],
  "budget-status": ["/api/budget", "status", "Budget line updated"],
  "volunteer-stage": ["/api/volunteers", "stage", "Volunteer updated"],
  "vendor-status": ["/api/vendors", "status", "Vendor updated"],
  "touchpoint-status": ["/api/attendee-touchpoints", "status", "Touchpoint updated"],
  "improvement-status": ["/api/improvements", "status", "Improvement updated"]
};

const draftRoutes = { outreach: "/api/outreach", comms: "/api/comms" };

async function draftAction(target, attribute, handler) {
  const el = target.closest(`[data-${attribute}]`);
  if (!el) return false;
  const [kind, id] = el.dataset[attribute.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())].split(":");
  try { await handler(kind, id); } catch (error) { toast(error.message); }
  return true;
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-view]"); if (nav) showView(nav.dataset.view);
  const go = event.target.closest("[data-go]"); if (go) showView(go.dataset.go);
  if (event.target.closest("#agent-toggle")) openAgent();
  if (event.target.closest("#agent-close")) { $("#agent-panel").classList.remove("open"); $("#agent-panel").setAttribute("aria-hidden", "true"); }
  if (event.target.closest("#agent-new")) { localStorage.removeItem("wd-session"); $("#messages").innerHTML = ""; toast("New conversation started"); }
  const suggestion = event.target.closest(".suggestions button"); if (suggestion) openAgent(suggestion.textContent);
  if (event.target.closest("#add-task")) $("#task-dialog").showModal();
  if (event.target.closest("#add-slot")) $("#slot-dialog").showModal();
  if (event.target.closest("#create-report") || event.target.closest("#generate-report")) await generateReport();
  if (event.target.closest("#research-sponsors")) openAgent("Research five current Calgary organizations that align with financial literacy, entrepreneurship, and Black community empowerment. Verify each with web sources and save only strong candidates.");
  if (event.target.closest("#plan-campaign")) openAgent("Research the best marketing channels for reaching Calgary professionals interested in financial literacy, then build a marketing campaign with a two-week content calendar to accelerate RESET ticket sales.");
  if (event.target.closest("#undo-last")) {
    try { const result = await request("/api/undo", { method: "POST", body: "{}" }); await refresh(); toast(`Undid ${result.action} in ${result.collection}`); }
    catch (error) { toast(error.message); }
  }
  if (event.target.closest("#sponsor-packet")) {
    await request("/api/documents/sponsor-packet", { method: "POST", body: "{}" });
    await refresh(); showView("docs"); toast("Sponsor packet created in Docs");
  }
  if (event.target.closest("#shift-plan")) {
    const result = await request("/api/run-of-show/shift-plan", { method: "POST", body: "{}" });
    await refresh(); showView("docs"); toast(`Shift plan created — ${result.unstaffed} unstaffed segment${result.unstaffed === 1 ? "" : "s"}`);
  }
  if (event.target.closest("#sync-tickets")) {
    try { const result = await request("/api/integrations/eventbrite/sync", { method: "POST", body: "{}" }); await refresh(); toast(`Tickets synced: ${result.ticketsSold} sold`); }
    catch (error) { toast(error.message); }
  }

  const draft = event.target.closest("[data-draft]");
  if (draft) { await request("/api/outreach/draft", { method: "POST", body: JSON.stringify({ sponsorId: draft.dataset.draft }) }); await refresh(); showView("outreach"); toast("Draft created — needs approval"); }
  const volunteerDraft = event.target.closest("[data-volunteer-draft]");
  if (volunteerDraft) {
    const volunteer = state.volunteers.find((item) => item.id === volunteerDraft.dataset.volunteerDraft);
    await request("/api/comms/draft", { method: "POST", body: JSON.stringify({ audience: "Volunteer", recipient: volunteer.name, subject: `Your ${volunteer.role} role at The Wealth Dojo Experience | RESET`, body: `Hi ${volunteer.name.split(" ")[0]},\n\nThank you for joining the RESET volunteer team as our ${volunteer.role}.\n\nNext steps:\n- Review the volunteer onboarding guide.\n- Save the date: training session Sep 12, event day Sep 26.\n- ${volunteer.shift === "Unassigned" ? "We will confirm your shift shortly." : `Your shift: ${volunteer.shift}.`}\n\nThe Wealth Dojo Team` }) });
    await refresh(); toast("Volunteer draft created — needs approval");
  }
  const convert = event.target.closest("[data-convert-meeting]");
  if (convert) { const result = await request(`/api/meetings/${convert.dataset.convertMeeting}/convert`, { method: "POST", body: "{}" }); await refresh(); toast(`${result.created.length} task${result.created.length === 1 ? "" : "s"} created from action items`); }
  const removeSlot = event.target.closest("[data-delete-slot]");
  if (removeSlot) { await request(`/api/run-of-show/${removeSlot.dataset.deleteSlot}`, { method: "DELETE" }); await refresh(); toast("Slot removed — undo from Overview if needed"); }

  // Draft workflow actions.
  await draftAction(event.target, "edit-draft", async (kind, id) => { editing.add(id); render(); });
  await draftAction(event.target, "approve", async (kind, id) => {
    await request(`${draftRoutes[kind]}/${id}`, { method: "PATCH", body: JSON.stringify({ status: "Approved" }) });
    await refresh(); toast("Approved — ready to send");
  });
  await draftAction(event.target, "reject", async (kind, id) => {
    await request(`${draftRoutes[kind]}/${id}`, { method: "PATCH", body: JSON.stringify({ status: "Rejected" }) });
    await refresh(); toast("Draft rejected");
  });
  await draftAction(event.target, "reopen", async (kind, id) => {
    await request(`${draftRoutes[kind]}/${id}`, { method: "PATCH", body: JSON.stringify({ status: "Needs approval" }) });
    await refresh(); toast("Draft reopened");
  });
  await draftAction(event.target, "send", async (kind, id) => {
    const result = await request(`${draftRoutes[kind]}/${id}/send`, { method: "POST", body: "{}" });
    await refresh(); toast(result.via === "gmail" ? "Sent via Gmail" : "Marked as sent");
  });
  await draftAction(event.target, "send-manual", async (kind, id) => {
    await request(`${draftRoutes[kind]}/${id}/send`, { method: "POST", body: JSON.stringify({ manual: true }) });
    await refresh(); toast("Marked as sent");
  });
  if (event.target.closest("[data-cancel-edit]")) { editing.clear(); render(); }

  const exportButton = event.target.closest("[data-export]");
  if (exportButton) {
    const [campaignId, format] = exportButton.dataset.export.split(":");
    const campaign = state.campaigns.find((item) => item.id === campaignId);
    try { await downloadFile(`/api/campaigns/${campaignId}/export.${format}`, `${campaign.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${format}`); }
    catch (error) { toast(error.message); }
  }
  const bufferButton = event.target.closest("[data-buffer]");
  if (bufferButton) {
    const [campaignId, entryId] = bufferButton.dataset.buffer.split(":");
    try { await request(`/api/campaigns/${campaignId}/content/${entryId}/buffer`, { method: "POST", body: "{}" }); toast("Queued in Buffer"); }
    catch (error) { toast(error.message); }
  }
  const downloadDoc = event.target.closest("[data-download-doc]");
  if (downloadDoc) {
    const document_ = state.documents.find((item) => item.id === downloadDoc.dataset.downloadDoc);
    try { await downloadFile(`/api/documents/${document_.id}/download`, `${document_.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`); }
    catch (error) { toast(error.message); }
  }
  const driveDoc = event.target.closest("[data-drive-doc]");
  if (driveDoc) {
    try { const result = await request(`/api/documents/${driveDoc.dataset.driveDoc}/export-drive`, { method: "POST", body: "{}" }); toast("Exported to Google Drive"); if (result.link) window.open(result.link, "_blank"); }
    catch (error) { toast(error.message); }
  }
  const calendarButtonEl = event.target.closest("[data-calendar]");
  if (calendarButtonEl) {
    const [kind, id] = calendarButtonEl.dataset.calendar.split(":");
    try { await request(`/api/${kind}/${id}/calendar`, { method: "POST", body: "{}" }); await refresh(); toast("Added to Google Calendar"); }
    catch (error) { toast(error.message); }
  }
});

document.addEventListener("change", async (event) => {
  for (const [attribute, [route, field, note]] of Object.entries(patchRoutes)) {
    const key = attribute.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (event.target.matches(`[data-${attribute}]`)) {
      await request(`${route}/${event.target.dataset[key]}`, { method: "PATCH", body: JSON.stringify({ [field]: event.target.value }) });
      await refresh(); toast(note);
      return;
    }
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-save-draft]");
  if (!form) return;
  event.preventDefault();
  const [kind, id] = form.dataset.saveDraft.split(":");
  const data = Object.fromEntries(new FormData(form));
  try {
    await request(`${draftRoutes[kind]}/${id}`, { method: "PATCH", body: JSON.stringify(data) });
    editing.delete(id);
    await refresh(); toast("Draft saved");
  } catch (error) { toast(error.message); }
});

$("#task-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "submit") return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  await request("/api/tasks", { method: "POST", body: JSON.stringify(data) });
  event.currentTarget.reset(); $("#task-dialog").close(); await refresh(); toast("Task created");
});

$("#slot-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "submit") return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  await request("/api/run-of-show", { method: "POST", body: JSON.stringify(data) });
  event.currentTarget.reset(); $("#slot-dialog").close(); await refresh(); toast("Slot added");
});

$("#feedback-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  await request("/api/feedback", { method: "POST", body: JSON.stringify(data) });
  event.currentTarget.reset(); await refresh(); toast("Feedback logged");
});

$("#agent-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const input = $("#agent-input"); const text = input.value.trim(); if (!text) return;
  message("user", text); input.value = ""; message("agent", "Working…");
  const pending = $("#messages").lastElementChild;
  try { const result = await request("/api/agent", { method: "POST", body: JSON.stringify({ message: text, sessionId: sessionId() }) }); pending.textContent = result.reply; $("#agent-mode").textContent = result.mode === "live" ? "Live OpenAI mode" : "Demo mode"; await refresh(); }
  catch (error) { pending.textContent = error.message; }
});

const params = new URLSearchParams(location.search);
if (params.get("google") === "connected") {
  toast(`Google connected${params.get("email") ? ` as ${params.get("email")}` : ""}`);
  history.replaceState({}, "", "/");
}

renderIntegrations().then(refresh).catch((error) => { console.error(error); toast("Could not load operations data"); });
