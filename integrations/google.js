import { randomBytes, timingSafeEqual } from "node:crypto";
import { deleteToken, getKV, getToken, saveToken, setKV } from "../db.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email"
].join(" ");

function config() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  return {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 8787}/auth/google/callback`
  };
}

export function isConfigured() {
  const { clientId, clientSecret } = config();
  return Boolean(clientId && clientSecret);
}

export function isConnected() {
  return Boolean(getToken("google")?.refresh_token);
}

export function status() {
  const token = getToken("google");
  const scopes = String(token?.scope || "").split(/\s+/).filter(Boolean);
  return {
    configured: isConfigured(),
    connected: isConnected(),
    email: token?.email || null,
    gmailRead: scopes.includes("https://www.googleapis.com/auth/gmail.readonly") || scopes.includes("https://mail.google.com/"),
    lastSync: getKV("googleContext")?.syncedAt || null
  };
}

export function getAuthUrl() {
  if (!isConfigured()) throw new Error("Google is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  const { clientId, redirectUri } = config();
  const state = randomBytes(32).toString("base64url");
  const now = Date.now();
  const pending = (getKV("googleOauthStates", []) || []).filter((entry) => entry.expiresAt > now).slice(-4);
  setKV("googleOauthStates", [...pending, { value: state, expiresAt: now + 10 * 60 * 1000 }]);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Google token request failed");
  return data;
}

export async function handleCallback(code, state) {
  if (!code) throw new Error("Google authorization did not return a code.");
  if (!state) throw new Error("Google authorization state is missing. Start the connection again from the dashboard.");
  const now = Date.now();
  const pending = (getKV("googleOauthStates", []) || []).filter((entry) => entry.expiresAt > now);
  const candidate = Buffer.from(state);
  const match = pending.find((entry) => {
    const expected = Buffer.from(entry.value);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!match) throw new Error("Google authorization state is invalid or expired. Start the connection again from the dashboard.");
  setKV("googleOauthStates", pending.filter((entry) => entry.value !== match.value));
  const { clientId, clientSecret, redirectUri } = config();
  const tokens = await tokenRequest({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" });
  let email = null;
  try {
    const info = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } }).then((response) => response.json());
    email = info.email || null;
  } catch {}
  saveToken("google", {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
    scope: tokens.scope || SCOPES,
    email
  });
  return { email };
}

export function disconnect() {
  deleteToken("google");
}

async function accessToken() {
  const stored = getToken("google");
  if (!stored?.refresh_token) throw new Error("Google is not connected. Open the Integrations panel and connect Google first.");
  if (stored.access_token && stored.expires_at > Date.now() + 60000) return stored.access_token;
  const { clientId, clientSecret } = config();
  const refreshed = await tokenRequest({ refresh_token: stored.refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" });
  saveToken("google", { ...stored, access_token: refreshed.access_token, expires_at: Date.now() + (refreshed.expires_in || 3600) * 1000, scope: refreshed.scope || stored.scope });
  return refreshed.access_token;
}

async function googleApi(url, options = {}) {
  const token = await accessToken();
  const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Google API request failed (${response.status})`);
  return data;
}

export async function sendEmail({ to, subject, body }) {
  if (!to) throw new Error("Add a recipient email address to the draft before sending.");
  const from = getToken("google")?.email || "me";
  const message = [
    `From: The Wealth Dojo <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body
  ].join("\r\n");
  const raw = Buffer.from(message).toString("base64url");
  const result = await googleApi("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw })
  });
  return { messageId: result.id };
}

export async function createCalendarEvent({ title, description, date, startTime, endTime }) {
  const event = startTime && endTime
    ? {
        summary: title,
        description,
        start: { dateTime: `${date}T${startTime}:00`, timeZone: "America/Edmonton" },
        end: { dateTime: `${date}T${endTime}:00`, timeZone: "America/Edmonton" }
      }
    : { summary: title, description, start: { date }, end: { date } };
  const result = await googleApi("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event)
  });
  return { eventId: result.id, link: result.htmlLink };
}

export async function uploadDoc({ title, markdown }) {
  const boundary = `wealthdojo${Date.now()}`;
  const metadata = { name: title, mimeType: "application/vnd.google-apps.document" };
  const multipart = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    markdown,
    `--${boundary}--`
  ].join("\r\n");
  const result = await googleApi("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body: multipart
  });
  return { fileId: result.id, link: result.webViewLink };
}

function header(message, name) {
  return (message.payload?.headers || []).find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

export async function syncRecentMessages() {
  if (!isConnected()) throw new Error("Google is not connected. Connect Google before refreshing Gmail context.");
  const maxResults = Math.min(50, Math.max(1, Number(process.env.GMAIL_SYNC_LIMIT || 25)));
  const query = process.env.GMAIL_SYNC_QUERY || "newer_than:30d";
  const params = new URLSearchParams({ maxResults: String(maxResults), q: query });
  const list = await googleApi(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`);
  const messages = await Promise.all((list.messages || []).map(async ({ id }) => {
    const metadata = new URLSearchParams({ format: "metadata" });
    for (const name of ["From", "To", "Subject", "Date"]) metadata.append("metadataHeaders", name);
    const message = await googleApi(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${metadata}`);
    return {
      id: message.id,
      threadId: message.threadId,
      from: header(message, "From"),
      to: header(message, "To"),
      subject: header(message, "Subject") || "(no subject)",
      date: header(message, "Date") || (message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null),
      snippet: message.snippet || "",
      labels: message.labelIds || [],
      url: `https://mail.google.com/mail/u/0/#all/${message.id}`
    };
  }));
  const context = { syncedAt: new Date().toISOString(), query, messages };
  setKV("gmailContext", context);
  return context;
}

export async function syncUpcomingEvents() {
  if (!isConnected()) throw new Error("Google is not connected. Connect Google before refreshing Calendar context.");
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + Number(process.env.CALENDAR_SYNC_DAYS || 90) * 86400000).toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(100, Math.max(1, Number(process.env.CALENDAR_SYNC_LIMIT || 50))))
  });
  const data = await googleApi(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
  const context = {
    syncedAt: new Date().toISOString(),
    events: (data.items || []).map((event) => ({
      id: event.id,
      title: event.summary || "Untitled event",
      description: event.description || "",
      start: event.start?.dateTime || event.start?.date || null,
      end: event.end?.dateTime || event.end?.date || null,
      status: event.status || null,
      attendees: (event.attendees || []).map((attendee) => attendee.email).filter(Boolean),
      url: event.htmlLink || null
    }))
  };
  setKV("calendarContext", context);
  return context;
}

export async function syncDriveFiles() {
  if (!isConnected()) throw new Error("Google is not connected. Connect Google before refreshing Drive context.");
  const params = new URLSearchParams({
    q: "trashed = false",
    orderBy: "modifiedTime desc",
    pageSize: String(Math.min(100, Math.max(1, Number(process.env.DRIVE_SYNC_LIMIT || 25)))),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,description)"
  });
  const data = await googleApi(`https://www.googleapis.com/drive/v3/files?${params}`);
  const context = {
    syncedAt: new Date().toISOString(),
    files: (data.files || []).map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime || null,
      description: file.description || "",
      url: file.webViewLink || null
    }))
  };
  setKV("driveContext", context);
  return context;
}
