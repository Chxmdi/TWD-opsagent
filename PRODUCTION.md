# Private single-user production deployment

This profile is for one private Wealth Dojo operator. It uses one Render web service, an attached persistent disk, a built-in email/password login, a built-in OAuth 2.1 authorization server for ChatGPT, and an HTTPS MCP endpoint. Auth0 or another external identity provider is not required.

## Architecture and limits

- One Node.js service hosts the protected dashboard, API, scheduler, OAuth endpoints, and `/mcp` endpoint.
- SQLite runs in WAL mode on `/var/data`. Keep `numInstances: 1`; this storage profile is intentionally single-instance.
- The application creates a coherent SQLite backup every day and retains 14 days by default. Render also snapshots paid persistent disks daily. Periodically copy a backup outside Render.
- The dashboard accepts only the configured `SINGLE_USER_EMAIL` and `SINGLE_USER_PASSWORD`.
- ChatGPT uses OAuth authorization code + PKCE. Access tokens expire after one hour, refresh tokens expire after 30 days and rotate on use, and every MCP request must have both required scopes.
- Dynamic OAuth client registrations are stateless and signed. Rotating `OAUTH_SIGNING_SECRET` invalidates the existing ChatGPT client registration.

## 1. Put the project in a private Git repository

Do not commit `.env.local`, `data/*.db`, database sidecars, backups, or API credentials. They are excluded by `.gitignore` and `.dockerignore`.

## 2. Deploy the Render Blueprint

Create a new Render Blueprint from the private repository. `render.yaml` provisions a paid Starter web service, one instance, and a 1 GB persistent disk in the Ohio region.

Provide these values when Render prompts:

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | OpenAI project key stored directly as a Render secret |
| `PUBLIC_BASE_URL` | Final HTTPS origin, without a trailing slash |
| `MCP_RESOURCE_URL` | The same final HTTPS origin |
| `SINGLE_USER_EMAIL` | The one email address permitted to sign in |
| `SINGLE_USER_PASSWORD` | A unique password of at least 16 characters; 24+ generated characters is recommended |

Render generates `OAUTH_SIGNING_SECRET` automatically. Do not delete, rotate, or copy it into GitHub.

If Render does not show the service URL before the first creation, use `https://placeholder.invalid` for `PUBLIC_BASE_URL` and `MCP_RESOURCE_URL`, create the service, copy its final `https://...onrender.com` origin, replace both placeholders, and redeploy. The placeholder deployment is intentionally not usable.

Do not set `AUTH_TOKEN` in production. It is a local-development compatibility option and is rejected when `NODE_ENV=production`.

## 3. Verify the deployment

Check:

```text
https://YOUR_DOMAIN/health
https://YOUR_DOMAIN/ready
https://YOUR_DOMAIN/.well-known/oauth-protected-resource
https://YOUR_DOMAIN/.well-known/oauth-authorization-server
```

`/ready` must return HTTP 200 with `database`, `ai`, `dashboardAuth`, `mcpAuth`, and `oauthServer` all ready.

Open `https://YOUR_DOMAIN/`. The application must show the built-in Wealth Dojo sign-in page. Sign in with `SINGLE_USER_EMAIL` and `SINGLE_USER_PASSWORD`, create a test task, redeploy, and confirm the task remains after restart.

## 4. Connect the private ChatGPT app

1. In ChatGPT, enable Developer mode under **Settings → Apps & Connectors → Advanced settings**. Some accounts still show this under **Security and login**.
2. Create a developer-mode app from ChatGPT app settings.
3. Use `https://YOUR_DOMAIN/mcp` as the MCP server URL.
4. Select OAuth with dynamic client registration when prompted.
5. ChatGPT opens the built-in **Connect ChatGPT** page. Sign in with the same single-user credentials and authorize access.
6. Enable the app in a new conversation and ask: `Show the Wealth Dojo operations overview.`

When tool metadata changes, redeploy and use **Refresh** on the developer-mode app.

## 5. Credential operations

- Change the dashboard password by replacing `SINGLE_USER_PASSWORD` in Render and redeploying.
- If the password is lost, set a new value in Render; there is no email-reset flow.
- Rotating `OAUTH_SIGNING_SECRET` requires deleting and recreating the developer-mode app in ChatGPT.
- Never paste `OPENAI_API_KEY`, `SINGLE_USER_PASSWORD`, or `OAUTH_SIGNING_SECRET` into chat, source control, logs, or screenshots.
- Review Render logs for repeated `401` or `429` responses.

## 6. Optional integrations

Add these as Render secrets only when needed:

- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI=https://YOUR_DOMAIN/auth/google/callback`
- Eventbrite: `EVENTBRITE_TOKEN` and `EVENTBRITE_EVENT_ID`
- Buffer: `BUFFER_TOKEN` and `BUFFER_PROFILE_ID`

Google OAuth for Gmail, Calendar, and Drive is separate from the built-in application login.

## Operations

- Logs are structured JSON and include a request ID, route, status, and duration without query strings or credentials.
- Every database mutation records the authenticated actor in the audit history.
- The app handles `SIGTERM`, drains in-flight requests, stops the scheduler, and closes SQLite cleanly.
- Run `npm run backup` for an on-demand coherent backup.
- Run `npm run check`, `npm run smoke`, and `npm run smoke:production` before deployment.

Official references: [OpenAI Apps authentication](https://developers.openai.com/apps-sdk/build/auth), [OpenAI production deployment](https://developers.openai.com/apps-sdk/deploy), and [Render persistent disks](https://render.com/docs/disks).
