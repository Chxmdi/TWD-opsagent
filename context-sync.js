import { getKV, setKV } from "./db.js";
import * as buffer from "./integrations/buffer.js";
import * as eventbrite from "./integrations/eventbrite.js";
import * as google from "./integrations/google.js";
import * as notion from "./integrations/notion.js";
import { importNotionTasks, readState, syncPendingTasksToNotion } from "./store.js";

let activeRefresh;

function refreshWindowMs() {
  return Math.max(1, Number(process.env.CONTEXT_REFRESH_MINUTES || 15)) * 60000;
}

function previousSnapshot() {
  return getKV("connectedContext", {
    refreshedAt: null,
    sources: {},
    notion: getKV("notionContext"),
    gmail: getKV("gmailContext"),
    calendar: getKV("calendarContext"),
    drive: getKV("driveContext"),
    eventbrite: getKV("eventbriteContext")
  });
}

async function capture(source, enabled, operation, previous) {
  if (!enabled) return { data: previous || null, status: { configured: false, refreshed: false, error: null } };
  try {
    const data = await operation();
    return { data, status: { configured: true, refreshed: true, error: null, syncedAt: data?.syncedAt || new Date().toISOString() } };
  } catch (error) {
    return { data: previous || null, status: { configured: true, refreshed: false, error: error.message } };
  }
}

export function getConnectedContext() {
  return previousSnapshot();
}

export function contextSummary() {
  const context = previousSnapshot();
  const notionContext = context.notion || {};
  return {
    refreshedAt: context.refreshedAt,
    sources: context.sources,
    notion: {
      tasks: (notionContext.tasks || []).filter((task) => task.status !== "Done").slice(0, 40),
      projects: (notionContext.projects || []).slice(0, 20),
      pages: (notionContext.pages || []).map((page) => ({
        id: page.id,
        title: page.title,
        url: page.url,
        lastEditedTime: page.lastEditedTime,
        excerpt: String(page.markdown || "").slice(0, 8000),
        truncated: page.truncated
      }))
    },
    gmail: { messages: (context.gmail?.messages || []).slice(0, 25), query: context.gmail?.query || null },
    calendar: { events: (context.calendar?.events || []).slice(0, 50) },
    drive: { files: (context.drive?.files || []).slice(0, 25) },
    eventbrite: context.eventbrite || null,
    buffer: { configured: buffer.isConfigured() }
  };
}

async function performRefresh() {
  const previous = previousSnapshot();
  const notionResult = await capture("notion", notion.isConfigured(), notion.syncContext, previous.notion);
  if (notionResult.status.refreshed) {
    notionResult.status.imported = importNotionTasks(notionResult.data.tasks || []);
    notionResult.status.pendingWrites = await syncPendingTasksToNotion();
  }

  const googleConnected = google.isConnected();
  const gmailResult = await capture("gmail", googleConnected, google.syncRecentMessages, previous.gmail);
  const calendarResult = await capture("calendar", googleConnected, google.syncUpcomingEvents, previous.calendar);
  const driveResult = await capture("drive", googleConnected, google.syncDriveFiles, previous.drive);
  const eventbriteResult = await capture("eventbrite", eventbrite.isConfigured(), eventbrite.syncTickets, previous.eventbrite);

  const snapshot = {
    refreshedAt: new Date().toISOString(),
    sources: {
      notion: notionResult.status,
      gmail: gmailResult.status,
      calendar: calendarResult.status,
      drive: driveResult.status,
      eventbrite: eventbriteResult.status,
      buffer: { configured: buffer.isConfigured(), refreshed: false, error: null }
    },
    notion: notionResult.data,
    gmail: gmailResult.data,
    calendar: calendarResult.data,
    drive: driveResult.data,
    eventbrite: eventbriteResult.data
  };
  setKV("connectedContext", snapshot);
  return snapshot;
}

export async function refreshConnectedContext({ force = false } = {}) {
  const current = previousSnapshot();
  if (!force && current.refreshedAt && Date.now() - new Date(current.refreshedAt).getTime() < refreshWindowMs()) return current;
  if (activeRefresh) return activeRefresh;
  activeRefresh = performRefresh().finally(() => { activeRefresh = null; });
  return activeRefresh;
}

function matchExcerpt(text, query) {
  const value = String(text || "");
  const index = value.toLowerCase().indexOf(query);
  if (index < 0) return value.slice(0, 500);
  return value.slice(Math.max(0, index - 180), Math.min(value.length, index + query.length + 320));
}

export function searchConnectedContext(query, limit = 12) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) throw new Error("A search query is required.");
  const context = previousSnapshot();
  const items = [];
  const add = (type, title, text, url, data) => {
    const haystack = `${title || ""}\n${text || ""}`.toLowerCase();
    if (!haystack.includes(needle)) return;
    const score = String(title || "").toLowerCase().includes(needle) ? 2 : 1;
    items.push({ type, title, excerpt: matchExcerpt(text, needle), url: url || null, score, data });
  };

  for (const task of context.notion?.tasks || []) add("notion-task", task.title, `${task.status} ${task.priority} ${task.area} ${task.nextAction || ""} ${task.notes || ""}`, task.notionUrl, task);
  for (const project of context.notion?.projects || []) add("notion-project", project.name, `${project.status || ""} ${project.health || ""} ${project.goal || ""} ${project.nextMilestone || ""}`, project.notionUrl, project);
  for (const page of context.notion?.pages || []) add("notion-page", page.title, page.markdown, page.url, { id: page.id, lastEditedTime: page.lastEditedTime });
  for (const message of context.gmail?.messages || []) add("gmail", message.subject, `${message.from} ${message.to} ${message.snippet}`, message.url, message);
  for (const event of context.calendar?.events || []) add("calendar", event.title, `${event.description} ${event.start} ${(event.attendees || []).join(" ")}`, event.url, event);
  for (const file of context.drive?.files || []) add("drive", file.name, `${file.description} ${file.mimeType}`, file.url, file);
  if (context.eventbrite) add("eventbrite", context.eventbrite.event?.name || "Eventbrite", JSON.stringify(context.eventbrite), context.eventbrite.event?.url, context.eventbrite);
  for (const task of readState().tasks || []) add("operations-task", task.title, `${task.status} ${task.priority} ${task.area} ${task.due}`, task.notionUrl, task);

  return items.sort((a, b) => b.score - a.score).slice(0, Math.min(25, Math.max(1, Number(limit) || 12))).map(({ score, ...item }) => item);
}
