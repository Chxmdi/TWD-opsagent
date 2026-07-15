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

- Neon PostgreSQL storage in hosted production, with local SQLite for development, actor-aware audit history, scheduled exports, and one-click undo
- Built-in single-user login for the production dashboard and built-in OAuth 2.1/PKCE protection for ChatGPT
- Agent conversation memory: follow-up messages build on the same session
- Approval-to-send pipeline: drafts move Needs approval → Approved → Sent; only a person can approve or send
- Synchronized context: Notion tasks/projects/planning, Gmail message summaries, Calendar events, Drive files, Eventbrite ticket data, and Buffer status refresh automatically at startup and every 15 minutes while active
- Integrations with graceful fallbacks: Notion, Google (Gmail/Calendar/Drive), Eventbrite, and Buffer — core operations remain available until credentials are added
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

`npm start` automatically loads `.env.local`. The app runs in safe demo mode without an API key and switches to the live OpenAI agent when `OPENAI_API_KEY` is present. It uses Neon PostgreSQL when `DATABASE_URL` is present and local SQLite otherwise. Existing `data/runtime.json` files from older versions are imported into SQLite automatically on first local boot.

## Validate

```bash
npm run check
npm run smoke
npm run smoke:production
```

## Integrations

All integrations are optional. The dashboard's Integrations panel (Overview view) shows live status.

### Notion — canonical planning context

1. Create an internal integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations) with read, insert, and update content capabilities.
2. Share the canonical **TWD Operations Dashboard**, **TWD Tasks**, **TWD Projects**, and planning pages with that integration.
3. Set `NOTION_API_KEY` plus the four `NOTION_*_ID` values in the environment. Keep the workspace IDs out of a public repository.
4. Select **Refresh all** in the dashboard or ask ChatGPT to refresh connected context.

Notion is the human-readable source for tasks, projects, and planning pages. Neon remains the durable application database for audit history, OAuth tokens, agent memory, recovery, and data from services that do not belong in Notion. Task changes write through to Notion; failed writes remain in Neon and retry on the next refresh.

### Google — Gmail send, Calendar, Drive

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com), enable the **Gmail API**, **Calendar API**, and **Drive API**.
2. Create OAuth 2.0 credentials (Web application) with redirect URI `http://localhost:8787/auth/google/callback`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in the environment.
4. Click **Connect Google** in the dashboard's Integrations panel and approve the consent screen.

Once connected: approved drafts gain a **Send via Gmail** button, milestones/meetings gain **+ Calendar**, documents gain **Export to Drive**, and recent email metadata/snippets, upcoming calendar events, and app-visible Drive files join the agent's refreshed context. Reconnect Google after upgrading so the app receives the new Gmail read-only scope. Email attachments and full mailbox bodies are not copied into the operations database.

### Eventbrite — live ticket counts

Set `EVENTBRITE_TOKEN` (private token from your Eventbrite account settings) and `EVENTBRITE_EVENT_ID`. Tickets sync hourly and on demand from the Integrations panel.

### Buffer — content queue

Set `BUFFER_TOKEN` and `BUFFER_PROFILE_ID` to queue content-calendar entries as Buffer drafts from the Marketing view.

### Auth

`AUTH_TOKEN` is a local-development compatibility option. Production uses one configured email/password, secure server sessions, and expiring OAuth access tokens for `/mcp`. The server refuses to start in production if required security settings are missing or `AUTH_TOKEN` is present. Keep `.env.local`, `data/*.db`, database sidecars, and backups out of source control and deployment bundles.

## Deploy privately

Use the included `render.yaml` for a Render Free web service backed by Neon Free PostgreSQL. Scheduled GitHub Actions wake the service and export the operations database. Follow [PRODUCTION_DEPLOYMENT_GUIDE.md](./PRODUCTION_DEPLOYMENT_GUIDE.md) for the complete setup. No external identity provider is required.

## Connect to ChatGPT

1. Deploy the server with the production single-user settings from [PRODUCTION.md](./PRODUCTION.md).
2. In ChatGPT, enable Developer mode under **Settings → Apps & Connectors → Advanced settings**.
3. Create a developer-mode app in ChatGPT app settings.
4. Use `https://YOUR_PUBLIC_HOST/mcp` as the MCP URL and select OAuth with dynamic client registration.
5. Sign in on the built-in **Connect ChatGPT** page with the same email/password as the dashboard.
6. Refresh the app in ChatGPT whenever tool metadata changes.

## Safety boundary

Every communication — sponsor, volunteer, attendee, vendor, partner — follows the approval pipeline: the agent can only create and edit drafts; a person must approve, and a person must click send. The agent cannot change draft statuses, cannot send email, and cannot make external commitments (vendor bookings and spending are tracked, never executed). All writes are audited and undoable.
