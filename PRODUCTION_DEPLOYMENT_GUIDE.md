# Wealth Dojo Operations Agent — Free Production Deployment

This guide deploys the private single-user application using Render Free and Neon Free. The application does not depend on your computer remaining online, and its information survives Render restarts and redeployments.

## What this setup provides

- Public HTTPS dashboard protected by one email/password login
- Public HTTPS `/mcp` endpoint protected by OAuth 2.1 with PKCE
- Durable PostgreSQL storage outside Render's temporary filesystem
- Persistent tasks, sponsors, reports, audit history, agent memory, sessions, and integration tokens
- Daily scheduled operations and database export artifacts
- Automatic deployment from GitHub
- No Auth0 and no paid Render disk

## Cost and limitation

Render and Neon can both remain on their free plans for a small personal application. OpenAI API usage is still billed separately from ChatGPT.

Render Free sleeps after 15 minutes without inbound traffic and can take approximately one minute to wake. ChatGPT may occasionally need a retry during a cold start. The database remains safe because it lives in Neon, not on Render's filesystem.

Current limits and terms can change. Check [Render Free](https://render.com/docs/free), [Neon plans](https://neon.com/docs/introduction/plans), and [OpenAI API pricing](https://developers.openai.com/api/docs/pricing).

## Architecture

```text
Browser / ChatGPT
        |
        v
Render Free web service
        |
        v
Neon Free PostgreSQL

GitHub Actions ---> scheduled Render endpoint
GitHub Actions ---> encrypted Neon connection ---> 14-day export artifact
```

The application uses local SQLite only when `DATABASE_URL` is absent. Production must use Neon PostgreSQL.

## Values you will create

Prepare the following without pasting their values into chat or source code:

| Name | Where it comes from | Where it is stored |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI Platform project | Render secret |
| `DATABASE_URL` | Neon project connection string | Render secret and GitHub Actions secret |
| `CRON_SECRET` | Random 32+ character value | Render secret and GitHub Actions secret |
| `SINGLE_USER_EMAIL` | Your chosen login email | Render secret |
| `SINGLE_USER_PASSWORD` | Your password manager | Render secret |
| `PUBLIC_BASE_URL` | Assigned Render HTTPS origin | Render environment |
| `MCP_RESOURCE_URL` | Same Render HTTPS origin | Render environment |
| `APP_BASE_URL` | Same Render HTTPS origin | GitHub Actions secret |

Render automatically generates `OAUTH_SIGNING_SECRET`. Do not rotate it after connecting ChatGPT unless you are prepared to recreate the ChatGPT app connection.

## 1. Confirm the GitHub repository

Repository: <https://github.com/Chxmdi/TWD-opsagent>

The production branch must contain:

```text
render.yaml
db.js
db-postgres.js
db-sqlite.js
.github/workflows/scheduled-operations.yml
scripts/backup-postgres.mjs
```

The repository is currently public. The code contains no credentials, but making it private is recommended for a personal operations system. Never commit `.env.local`, database exports, API keys, passwords, or connection strings.

## 2. Create the Neon Free database

1. Open <https://console.neon.tech> and create a free account.
2. Create a project named `wealth-dojo-operations`.
3. Choose a region close to the Render service region.
4. Open the project's **Connect** panel.
5. Select the pooled connection option if Neon offers both pooled and direct connections.
6. Copy the complete PostgreSQL connection string.
7. Save it temporarily in a password manager as `DATABASE_URL`.

The value resembles this structure:

```text
postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
```

Do not edit, shorten, display, or commit it. The application creates its tables automatically on first boot.

## 3. Confirm OpenAI API access

1. Open <https://platform.openai.com>.
2. Select the project for this application.
3. Confirm API billing or credits are active.
4. Set a project budget and usage notification.
5. Create a project API key if the existing key has been revoked.
6. Store the key directly in Render in Step 6.

The ChatGPT subscription and OpenAI API billing are separate.

## 4. Generate the application secrets

Choose the one email address permitted to sign in. Generate two separate random values using Node.js:

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use the first as `SINGLE_USER_PASSWORD` and the second as `CRON_SECRET`. Store both in a password manager.

Requirements:

- `SINGLE_USER_PASSWORD`: at least 16 characters; 24+ recommended
- `CRON_SECRET`: at least 32 characters
- The two values must be different
- Do not use a GitHub, Google, Render, OpenAI, or email password

There is no email reset flow. If the dashboard password is lost, replace it in Render and redeploy.

## 5. Connect Render to GitHub

1. Open <https://dashboard.render.com>.
2. Sign in and select **New → Blueprint**.
3. Connect GitHub if prompted.
4. Authorize Render to access `Chxmdi/TWD-opsagent`.
5. Select the repository and its `main` branch.
6. Use `render.yaml` as the Blueprint path.
7. Review the proposed service.

The Blueprint must show a **Free** Node.js web service and no persistent disk. The source of durable data is Neon.

## 6. Enter the Render environment variables

Enter these values when the Blueprint requests them:

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | Existing OpenAI project API key |
| `DATABASE_URL` | Neon pooled PostgreSQL connection string |
| `CRON_SECRET` | Random scheduler value from Step 4 |
| `SINGLE_USER_EMAIL` | Your chosen operator email |
| `SINGLE_USER_PASSWORD` | Random dashboard password from Step 4 |
| `PUBLIC_BASE_URL` | Final Render HTTPS origin, no trailing slash |
| `MCP_RESOURCE_URL` | Exactly the same HTTPS origin |

The Blueprint sets these automatically:

```text
NODE_ENV=production
SCHEDULER=on
OPENAI_MODEL=gpt-5.4
MCP_REQUIRED_SCOPES=operations:read operations:write
```

Do not add `AUTH_TOKEN`, `DB_PATH`, or `BACKUP_DIR` to the Render service.

### If Render has not assigned the URL yet

1. Enter `https://placeholder.invalid` for both URL variables.
2. Deploy once.
3. Copy the assigned origin, such as `https://wealth-dojo-operations.onrender.com`.
4. Replace both placeholder values with that exact origin.
5. Save and redeploy.

Both values must be identical HTTPS origins without `/mcp`, a trailing slash, query parameters, or fragments.

## 7. Deploy and inspect startup

1. Select **Deploy Blueprint**.
2. Open the Render deployment logs.
3. Confirm dependencies install successfully.
4. Confirm the startup log includes `"database":"postgres"`.
5. Confirm there are no `Unsafe production configuration` or `database_write_error` messages.

The first startup creates the Neon schema and imports the initial application seed. Later restarts load the existing Neon records instead of resetting them.

## 8. Verify health and authentication

Replace `YOUR_ORIGIN` with the Render origin and open:

```text
https://YOUR_ORIGIN/health
https://YOUR_ORIGIN/ready
https://YOUR_ORIGIN/.well-known/oauth-protected-resource
https://YOUR_ORIGIN/.well-known/oauth-authorization-server
```

Expected:

- `/health` returns HTTP 200.
- `/ready` returns HTTP 200.
- `/ready` reports `database`, `ai`, `dashboardAuth`, `mcpAuth`, and `oauthServer` as `true`.
- OAuth metadata uses the same public origin.

Open `https://YOUR_ORIGIN/` and sign in with `SINGLE_USER_EMAIL` and `SINGLE_USER_PASSWORD`.

## 9. Prove information persists

1. Create a uniquely named test task in the dashboard.
2. Trigger a manual Render redeploy.
3. Wait for the service to return to ready status.
4. Sign in again.
5. Confirm the test task still exists.

If the task disappears, stop entering real information. Confirm `DATABASE_URL` is present and the startup log says `"database":"postgres"`.

## 10. Configure GitHub Actions secrets

Open the repository and go to **Settings → Secrets and variables → Actions**. Create these repository secrets:

| Secret | Value |
|---|---|
| `APP_BASE_URL` | Render origin without trailing slash |
| `CRON_SECRET` | Exact same value used in Render |
| `DATABASE_URL` | Exact Neon connection string used in Render |

Do not create ordinary repository variables for these values. Use encrypted Actions secrets.

The workflow `.github/workflows/scheduled-operations.yml` runs daily at 10:17 UTC. It:

1. wakes the Render service;
2. calls the protected scheduler endpoint;
3. generates the daily digest and one report per ISO week;
4. syncs Eventbrite when configured;
5. exports operations records, key/value state, and audit history;
6. uploads the export as a GitHub Actions artifact retained for 14 days.

OAuth sessions and integration tokens are deliberately excluded from exported artifacts. They remain in Neon and can be recreated by signing in or reconnecting an integration.

## 11. Test the scheduled workflow

1. Open the repository's **Actions** tab.
2. Select **Scheduled operations and backup**.
3. Select **Run workflow** on `main`.
4. Wait for both jobs to succeed.
5. Open the workflow run and confirm a database artifact exists.
6. Review Render logs for the authenticated scheduler request.

If the repository remains public and receives no repository activity for 60 days, GitHub may disable scheduled workflows. Re-enable the workflow from the Actions tab or make the repository private. The in-process scheduler also runs whenever Render wakes, but it cannot run while Render is asleep.

## 12. Connect the private app to ChatGPT

1. In ChatGPT, open **Settings → Security and login**.
2. Enable **Developer mode**.
3. Open **Settings → Plugins** or <https://chatgpt.com/plugins>.
4. Create a developer-mode app.
5. Use:

```text
Name: Wealth Dojo Operations Agent
MCP URL: https://YOUR_ORIGIN/mcp
```

6. Choose OAuth with dynamic client registration if asked.
7. Sign in through the Wealth Dojo authorization screen using the dashboard email and password.
8. Approve the requested read/write operations scopes.
9. Add the app to a new conversation.
10. Test:

```text
Show the Wealth Dojo operations overview and tell me what needs attention.
```

Private personal use does not require public plugin submission. OpenAI requires the MCP endpoint to be reachable over HTTPS. See [Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt).

## 13. Understand cold starts

After approximately 15 minutes without traffic, Render Free sleeps. The next browser or ChatGPT request wakes it and may take approximately one minute.

During a cold start:

- wait for the Render loading page to finish;
- retry the ChatGPT tool call if it times out;
- check `/ready` before diagnosing the app as broken;
- do not use artificial continuous pings to bypass Render's free-plan behavior.

Neon stores the data independently, so a Render cold start does not erase it.

## 14. Optional integrations

### Google

Enable Gmail, Calendar, and Drive APIs in a Google Cloud project. Create a Web application OAuth client with this redirect URI:

```text
https://YOUR_ORIGIN/auth/google/callback
```

Add these Render secrets:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=https://YOUR_ORIGIN/auth/google/callback
```

Redeploy, sign in, and select **Connect Google**. All communications remain approval-gated.

### Eventbrite

Add these Render secrets and redeploy:

```text
EVENTBRITE_TOKEN
EVENTBRITE_EVENT_ID
```

Run one manual sync from the dashboard before relying on the scheduler.

### Buffer

Add these Render secrets and redeploy:

```text
BUFFER_TOKEN
BUFFER_PROFILE_ID
```

Queue one test entry as a draft and verify it in Buffer.

## 15. Updating production

Before pushing a release:

```bash
npm ci
npm run check
npm run smoke
npm run smoke:production
```

After Render deploys:

1. confirm `/ready`;
2. sign in and read an existing record;
3. create or update a test task;
4. refresh the ChatGPT developer-mode app if MCP metadata changed;
5. review logs for database errors.

## 16. Recovery

Neon Free currently provides a limited restore-history window. GitHub Actions artifacts provide an additional 14-day operations export.

If data is damaged:

1. stop making changes;
2. download the newest known-good `wealth-dojo-database-*` artifact;
3. preserve a copy of the current Neon database;
4. restore into a separate Neon project first;
5. verify records before switching `DATABASE_URL`;
6. reconnect Google and ChatGPT if sessions or tokens are not restored.

The export format is JSON. A production restore must be performed deliberately; do not paste its contents into chat or commit it to GitHub.

## 17. Troubleshooting

### Demo mode

- Confirm `OPENAI_API_KEY` is set in Render.
- Confirm OpenAI API billing is active.
- Confirm `/ready` reports `"ai": true`.
- Redeploy after replacing a revoked key.

### Database is not ready

- Confirm `DATABASE_URL` is complete and stored as one Render secret.
- Confirm the URL uses `postgresql://` or `postgres://`.
- Confirm Neon's project is active and within free limits.
- Review logs for `database_write_error`.

### GitHub Actions scheduler receives 401

`CRON_SECRET` differs between GitHub and Render. Replace one so the values match exactly, then rerun the workflow.

### GitHub Actions cannot connect to Neon

Confirm the Actions secret is named exactly `DATABASE_URL` and contains the same full connection string used by Render.

### Login actions return `Invalid request origin`

Use the exact origin configured in `PUBLIC_BASE_URL`. Do not alternate between the Render subdomain and a custom domain.

### ChatGPT cannot connect

- Wake Render by opening `/ready` first.
- Confirm the MCP URL ends with `/mcp`.
- Confirm the OAuth metadata URLs are public.
- Recreate the ChatGPT developer-mode app if the origin or signing secret changed.

## Completion checklist

- [ ] Neon Free project exists.
- [ ] Render Blueprint uses the Free plan and has no disk.
- [ ] Render has `DATABASE_URL` and `CRON_SECRET`.
- [ ] Startup log reports PostgreSQL mode.
- [ ] `/ready` returns HTTP 200 with every field true.
- [ ] Dashboard login works.
- [ ] A task survives a redeploy.
- [ ] GitHub Actions secrets are configured.
- [ ] Manual scheduled workflow succeeds.
- [ ] A 14-day database export artifact is created.
- [ ] ChatGPT connects through OAuth.
- [ ] OpenAI project budget alerts are enabled.
- [ ] No secret appears in source code or logs.

## Official references

- [Render Free services](https://render.com/docs/free)
- [Render Blueprints](https://render.com/docs/infrastructure-as-code)
- [Render environment variables](https://render.com/docs/configure-environment-variables)
- [Neon Free plan](https://neon.com/docs/introduction/plans)
- [GitHub Actions billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage)
- [GitHub scheduled workflows](https://docs.github.com/actions/using-workflows/events-that-trigger-workflows)
- [OpenAI Apps deployment](https://developers.openai.com/apps-sdk/deploy)
- [OpenAI Apps authentication](https://developers.openai.com/apps-sdk/build/auth)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
