import { randomBytes, timingSafeEqual } from "node:crypto";
import { deleteToken, getKV, getToken, saveToken, setKV } from "../db.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
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
  return { configured: isConfigured(), connected: isConnected(), email: getToken("google")?.email || null };
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
  saveToken("google", { ...stored, access_token: refreshed.access_token, expires_at: Date.now() + (refreshed.expires_in || 3600) * 1000 });
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
