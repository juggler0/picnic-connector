# Security

## Reporting a problem
Please **do not** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository instead.

## Never commit secrets
This repository must never contain:
- your `CONNECTOR_SECRET` or connector address (the `/mcp/<secret>` URL),
- Picnic passwords or login tokens,
- a Notion integration secret (`NOTION_TOKEN`).

All of these belong in **Netlify → Project configuration → Environment variables** (or, for the Picnic token,
in Netlify Blobs, where the login page puts it). `.env` files are ignored by git.

## If a secret leaked
- **Connector address / `CONNECTOR_SECRET`:** set a new value in Netlify, trigger a deploy, and update the address in
  your AI assistant.
- **Picnic login:** click *Uitloggen* on the login page, or change your Picnic password.
- **Notion token:** delete or regenerate the integration secret in Notion and update `NOTION_TOKEN`.
