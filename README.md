# Wealth Dojo Operations Agent

A shared operations backend powering both a standalone dashboard and a ChatGPT App. It covers the full Experience Operations Coordinator role for The Wealth Dojo Experience | RESET (Calgary, September 26, 2026) — and, once connected, executes approved communications through Gmail.

## What works

**Operations**

- Event operations: milestone timeline, logistics checklist, CAD budget with per-category guardrails, and an event-day run of show with conflict detection and volunteer shift-plan generation
- Volunteer coordination: roster, onboarding stages, shifts, and approval-gated communications
- Vendor and partner coordination: vendor pipeline separate from the sponsor pipeline
- Meeting support: agendas, notes, and one-click conversion of action items into tasks
- Digital documentation: SOPs, checklists, and templates in markdown with versioning, markdown download, and Google Drive export
- Attendee experience: Before/During/After journey touchpoints, feedback logging with agent analysis, and draft-only attendee comms
- Continuous improvement backlog fed by feedback analysis
- Marketing: strategies, campaigns, content calendars (.ics/.csv export, optional Buffer queueing), and a sponsor packet generator
- Weekly operations reports (generated automatically every Monday) and a daily "needs attention" digest

**Platform**

- SQLite storage (`better-sqlite3`) with actor-aware audit history, daily coherent backups, and one-click undo
- Built-in single-user login for the production dashboard and built-in OAuth 2.1/PKCE protection for ChatGPT
- Agent conversation memory: follow-up messages build on the same session
- Approval-to-send pipeline: drafts move Needs approval → Approved → Sent; only a person can approve or send
- Integrations with graceful fallbacks: Google (Gmail/Calendar/Drive), Eventbrite ticket sync, Buffer — everything works locally until credentials are added
- OpenAI Agents SDK assistant with web search and 45+ tools when `OPENAI_API_KEY` is configured
- ChatGPT MCP tools and an inline operations widget at `/mcp`

## Run locally

Requires Node.js 20.6 or newer.

```bash
npm install
cp .env.example .env.local
# Add your OPENAI_API_KEY to .env.local
npm start
```

Open `http://localhost:8787`.

`npm start` automatically loads `.env.local`. The app runs in safe demo mode without an API key and switches to the live OpenAI agent when `OPENAI_API_KEY` is present. Existing `data/runtime.json` files from older versions are imported into SQLite automatically on first boot.

## Validate

```bash
npm run check
npm run smoke
npm run smoke:production
```

## Integrations

All integrations are optional. The dashboard's Integrations panel (Overview view) shows live status.

### Google — Gmail send, Calendar, Drive

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com), enable the **Gmail API**, **Calendar API**, and **Drive API**.
2. Create OAuth 2.0 credentials (Web application) with redirect URI `http://localhost:8787/auth/google/callback`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in the environment.
4. Click **Connect Google** in the dashboard's Integrations panel and approve the consent screen.

Once connected: approved drafts gain a **Send via Gmail** button, milestones/meetings gain **+ Calendar**, and documents gain **Export to Drive**. Without it, everything still works — use **Mark as sent** and **Download .md**.

### Eventbrite — live ticket counts

Set `EVENTBRITE_TOKEN` (private token from your Eventbrite account settings) and `EVENTBRITE_EVENT_ID`. Tickets sync hourly and on demand from the Integrations panel.

### Buffer — content queue

Set `BUFFER_TOKEN` and `BUFFER_PROFILE_ID` to queue content-calendar entries as Buffer drafts from the Marketing view.

### Auth

`AUTH_TOKEN` is a local-development compatibility option. Production uses one configured email/password, secure server sessions, and expiring OAuth access tokens for `/mcp`. The server refuses to start in production if required security settings are missing or `AUTH_TOKEN` is present. Keep `.env.local`, `data/*.db`, database sidecars, and backups out of source control and deployment bundles.

## Deploy privately

Use the included `render.yaml` for a single-instance Render deployment with a persistent disk, health checks, graceful shutdown, automatic backups, and a generated OAuth signing secret. Follow [PRODUCTION.md](./PRODUCTION.md) for the single-user Render and private ChatGPT connection steps. No external identity provider is required.

## Connect to ChatGPT

1. Deploy the server with the production single-user settings from [PRODUCTION.md](./PRODUCTION.md).
2. In ChatGPT, enable Developer mode under **Settings → Apps & Connectors → Advanced settings**.
3. Create a developer-mode app in ChatGPT app settings.
4. Use `https://YOUR_PUBLIC_HOST/mcp` as the MCP URL and select OAuth with dynamic client registration.
5. Sign in on the built-in **Connect ChatGPT** page with the same email/password as the dashboard.
6. Refresh the app in ChatGPT whenever tool metadata changes.

## Safety boundary

Every communication — sponsor, volunteer, attendee, vendor, partner — follows the approval pipeline: the agent can only create and edit drafts; a person must approve, and a person must click send. The agent cannot change draft statuses, cannot send email, and cannot make external commitments (vendor bookings and spending are tracked, never executed). All writes are audited and undoable.
