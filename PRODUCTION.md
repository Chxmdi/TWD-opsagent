# Production deployment

The supported no-fixed-hosting-cost deployment uses:

- Render Free for the Node.js dashboard and MCP server;
- Neon Free PostgreSQL for durable operations data, sessions, OAuth state, and integration tokens;
- GitHub Actions for daily wake-ups and 14-day database export artifacts;
- the built-in single-user login and OAuth 2.1/PKCE server.

Auth0 and a Render persistent disk are not required.

Follow [PRODUCTION_DEPLOYMENT_GUIDE.md](./PRODUCTION_DEPLOYMENT_GUIDE.md) from beginning to end. Render Free can take approximately one minute to wake after 15 minutes without traffic, so it is suitable for this private personal application but is not an always-warm service.

Before every production release, run:

```bash
npm ci
npm run check
npm run smoke
npm run smoke:production
```

Official references: [Render Free](https://render.com/docs/free), [Neon plans](https://neon.com/docs/introduction/plans), [OpenAI Apps deployment](https://developers.openai.com/apps-sdk/deploy), and [OpenAI Apps authentication](https://developers.openai.com/apps-sdk/build/auth).
