import { getKV, setKV } from "../db.js";

const API_BASE = "https://api.notion.com/v1";
const API_VERSION = "2026-03-11";

function cleanId(value = "") {
  return String(value).replace(/^collection:\/\//, "").replace(/-/g, "").trim();
}

function configuredIds() {
  return {
    tasks: cleanId(process.env.NOTION_TASKS_DATA_SOURCE_ID),
    projects: cleanId(process.env.NOTION_PROJECTS_DATA_SOURCE_ID),
    defaultProject: cleanId(process.env.NOTION_DEFAULT_PROJECT_PAGE_ID),
    contextPages: String(process.env.NOTION_CONTEXT_PAGE_IDS || "")
      .split(",")
      .map(cleanId)
      .filter(Boolean)
  };
}

export function isConfigured() {
  const ids = configuredIds();
  return Boolean(process.env.NOTION_API_KEY && ids.tasks && ids.projects);
}

export function status() {
  const ids = configuredIds();
  return {
    configured: isConfigured(),
    tasksConfigured: Boolean(ids.tasks),
    projectsConfigured: Boolean(ids.projects),
    contextPages: ids.contextPages.length,
    lastSync: getKV("notionLastSync"),
    lastError: getKV("notionLastError")
  };
}

async function notionRequest(path, options = {}) {
  if (!process.env.NOTION_API_KEY) throw new Error("Notion is not configured. Set NOTION_API_KEY in the service environment.");
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "notion-version": API_VERSION,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Notion API request failed (${response.status})`);
  return data;
}

async function queryDataSource(dataSourceId) {
  const results = [];
  let startCursor;
  do {
    const body = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const data = await notionRequest(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    results.push(...(data.results || []));
    startCursor = data.has_more ? data.next_cursor : null;
  } while (startCursor);
  return results;
}

function plainText(value = []) {
  return value.map((item) => item.plain_text || item.text?.content || "").join("").trim();
}

function propertyText(property) {
  if (!property) return "";
  if (property.type === "title") return plainText(property.title);
  if (property.type === "rich_text") return plainText(property.rich_text);
  if (property.type === "url") return property.url || "";
  if (property.type === "email") return property.email || "";
  return "";
}

function propertyName(property) {
  return property?.select?.name || property?.status?.name || "";
}

function propertyDate(property) {
  return property?.date?.start || "";
}

function mapStatus(status) {
  return ({ "Not started": "To do", "In progress": "In progress", Done: "Done", Archived: "Done" })[status] || "To do";
}

function notionStatus(status) {
  return ({ "To do": "Not started", Todo: "Not started", Doing: "In progress", "In progress": "In progress", Done: "Done" })[status] || "Not started";
}

function mapPriority(priority) {
  return priority === "Critical" ? "High" : ["High", "Medium", "Low"].includes(priority) ? priority : "Medium";
}

function workstream(area = "") {
  return ({
    Marketing: "Marketing Strategy",
    Partnerships: "Sponsors & Partnerships",
    Sponsors: "Sponsors & Partnerships",
    Reporting: "EOD Reporting"
  })[area] || null;
}

export function mapTaskPage(page) {
  const properties = page.properties || {};
  const notionPriority = propertyName(properties.Priority);
  return {
    notionPageId: page.id,
    notionUrl: page.url || null,
    title: propertyText(properties["Task name"]) || "Untitled Notion task",
    area: propertyName(properties.Workstream) || propertyName(properties.Area) || "Operations",
    priority: mapPriority(notionPriority),
    notionPriority: notionPriority || null,
    status: mapStatus(propertyName(properties.Status)),
    due: propertyDate(properties.Due) || "This week",
    nextAction: propertyText(properties["Next action"]) || null,
    notes: propertyText(properties.Notes) || null,
    blocked: Boolean(properties.Blocked?.checkbox),
    lastEditedTime: page.last_edited_time || null,
    source: "notion"
  };
}

export function mapProjectPage(page) {
  const properties = page.properties || {};
  return {
    notionPageId: page.id,
    notionUrl: page.url || null,
    name: propertyText(properties["Project name"]) || "Untitled Notion project",
    status: propertyName(properties.Status) || null,
    health: propertyName(properties.Health) || null,
    priority: propertyName(properties.Priority) || null,
    goal: propertyText(properties.Goal) || null,
    nextMilestone: propertyText(properties["Next milestone"]) || null,
    start: propertyDate(properties.Dates) || null,
    lastEditedTime: page.last_edited_time || null
  };
}

async function retrieveMarkdown(pageId) {
  const [data, page] = await Promise.all([
    notionRequest(`/pages/${pageId}/markdown`),
    notionRequest(`/pages/${pageId}`)
  ]);
  const titleProperty = Object.values(page.properties || {}).find((property) => property.type === "title");
  return {
    id: pageId,
    title: propertyText(titleProperty) || "Notion context page",
    url: page.url || null,
    lastEditedTime: page.last_edited_time || null,
    markdown: data.markdown || "",
    truncated: Boolean(data.truncated),
    unknownBlockIds: data.unknown_block_ids || []
  };
}

export async function syncContext() {
  if (!isConfigured()) throw new Error("Notion is not configured. Add NOTION_API_KEY and the canonical TWD data-source IDs.");
  const ids = configuredIds();
  try {
    const [taskPages, projectPages, contextPages] = await Promise.all([
      queryDataSource(ids.tasks),
      queryDataSource(ids.projects),
      Promise.all(ids.contextPages.map((id) => retrieveMarkdown(id)))
    ]);
    const snapshot = {
      syncedAt: new Date().toISOString(),
      tasks: taskPages.map(mapTaskPage),
      projects: projectPages.map(mapProjectPage),
      pages: contextPages
    };
    setKV("notionContext", snapshot);
    setKV("notionLastSync", snapshot.syncedAt);
    setKV("notionLastError", null);
    return snapshot;
  } catch (error) {
    setKV("notionLastError", error.message);
    throw error;
  }
}

function title(content) {
  return { title: [{ type: "text", text: { content: String(content).slice(0, 2000) } }] };
}

function richText(content) {
  return { rich_text: [{ type: "text", text: { content: String(content).slice(0, 2000) } }] };
}

function taskProperties(task, { includeProject = true } = {}) {
  const ids = configuredIds();
  const properties = {
    "Task name": title(task.title),
    Area: { select: { name: "Work" } },
    Priority: { select: { name: mapPriority(task.priority) } },
    Status: { status: { name: notionStatus(task.status) } }
  };
  const stream = workstream(task.area);
  if (stream) properties.Workstream = { select: { name: stream } };
  if (task.nextAction) properties["Next action"] = richText(task.nextAction);
  if (task.notes) properties.Notes = richText(task.notes);
  if (/^\d{4}-\d{2}-\d{2}/.test(task.due || "")) properties.Due = { date: { start: task.due.slice(0, 10) } };
  if (includeProject && ids.defaultProject) properties.Project = { relation: [{ id: ids.defaultProject }] };
  return properties;
}

export async function createTask(task) {
  if (!isConfigured()) return null;
  const ids = configuredIds();
  const page = await notionRequest("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: ids.tasks },
      properties: taskProperties(task)
    })
  });
  return { id: page.id, url: page.url || null, lastEditedTime: page.last_edited_time || null };
}

export async function updateTask(pageId, task) {
  if (!isConfigured() || !pageId) return null;
  const page = await notionRequest(`/pages/${cleanId(pageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: taskProperties(task, { includeProject: false }) })
  });
  return { id: page.id, url: page.url || null, lastEditedTime: page.last_edited_time || null };
}
