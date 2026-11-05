# Picnic connector for Claude (MCP on Netlify)

A small, self-hosted **MCP connector** that lets Claude — or any other AI assistant that supports remote MCP
servers — work with your own [Picnic](https://picnic.app) account: search products, look at promotions and your
order history, and fill your cart.

**It can never place an order or pay.** You always check out yourself in the Picnic app.

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/juggler0/picnic-connector)

> Unofficial project. Not affiliated with or endorsed by Picnic. It uses the unofficial
> [picnic-api](https://github.com/MRVDH/picnic-api) library, which talks to the same endpoints as the Picnic app.
> Picnic can change those at any time. Use at your own risk.

---

## How it works

```
Your AI assistant (Claude chat, a scheduled task, …)
   │  connector URL that contains your secret key
   ▼
Your own Netlify project (free plan is enough)
   ├─ public/index.html               login page: one-time Picnic login + SMS code
   ├─ netlify/functions/login.mts     handles that login and stores Picnic's login token
   ├─ netlify/functions/mcp.mts       the connector: checks the key, runs a tool
   ├─ netlify/lib/tools.mts           all tools (what the AI can do)
   └─ netlify/functions/history-sync.mts   optional: copies your order history to Notion
   │
   ▼
Picnic
```

Everyone runs **their own copy**: their own Netlify project, their own secret key, their own Picnic login.
Nothing is shared with the author of this repository or with other users.

## Tools

| Read-only | Changes something |
|---|---|
| `picnic_status`, `picnic_get_cart` | `picnic_add_to_cart` |
| `picnic_search`, `picnic_product`, `picnic_favorites` | `picnic_remove_from_cart` |
| `picnic_promotions`, `picnic_promotion_group` | `picnic_clear_cart` (only on explicit request) |
| `picnic_order_history`, `picnic_order_details`, `picnic_purchase_stats` | `picnic_set_delivery_slot` (choosing a slot is not ordering) |
| `picnic_next_delivery` | |
| `picnic_saved_recipes`, `picnic_recipe` | |

Deliberately **not** included: checkout, payment and cancelling orders.

---

## Set up your own copy (about 15 minutes)

You need: a free [Netlify](https://netlify.com) account, a free GitHub account, your Picnic account and phone (for the SMS code).

### 1. Make a secret key
This key protects your connector. Make a long random one (at least 32 characters), for example:

- Mac/Linux terminal: `openssl rand -hex 32`
- Or any password manager: 64 random letters and digits, no spaces.

Keep it somewhere safe (a password manager). **Never put it in this repository or in a file you commit.**

### 2. Deploy
Click **Deploy to Netlify** above. Netlify copies this repository to your GitHub account, asks for
`CONNECTOR_SECRET` (paste the key from step 1) and builds the site. Wait until it says **Published**.

*Without the button:* fork this repository, then in Netlify choose **Add new project → Import an existing project →
GitHub**, pick your fork, and add `CONNECTOR_SECRET` under **Project configuration → Environment variables**.
Then **Deploys → Trigger deploy**.

### 3. Log in to Picnic (once)
1. Open your site's address (`https://<your-project>.netlify.app`).
2. Paste your secret key.
3. Click **Test verbinding met Picnic** — it should say Picnic is reachable.
4. Enter your Picnic e-mail and password, click **Inloggen**, then enter the SMS code.

Your password is only passed on to Picnic and is **never stored**. Only Picnic's login token is kept, in your own
Netlify project's storage (Netlify Blobs).

### 4. Connect your AI assistant
Your connector address is:

```
https://<your-project>.netlify.app/mcp/<your-secret-key>
```

- **Claude (claude.ai / desktop / mobile):** Settings → Connectors → *Add custom connector* → name `Picnic`,
  paste the address, leave OAuth empty.
- **Other MCP clients** (Claude Code, Cursor, …): add a remote MCP server (Streamable HTTP) with the same address.

Treat this address like a password: anyone who has it can use your cart.

---

## Settings (Netlify → Project configuration → Environment variables)

| Variable | Required | What it is |
|---|---|---|
| `CONNECTOR_SECRET` | yes | Your secret key, at least 32 characters. Shorter keys are refused. |
| `PICNIC_COUNTRY` | no | `NL` (default), `DE` or `FR`. |
| `ALLOWED_IP_PREFIXES` | no | Comma-separated IP prefixes; when set, only those callers are served (extra safety net). |
| `NOTION_TOKEN` | no | Enables the order-history copy to Notion (see below). |

See [`.env.example`](.env.example). After changing a variable: **Deploys → Trigger deploy**.

## Optional: order history in Notion

1. In Notion, create an internal integration (notion.so/profile/integrations → *New integration*), give it
   *Read*, *Update* and *Insert content*, and copy its secret.
2. Create a page named exactly **Picnic-geschiedenis** and add the integration to it (••• → *Connections*).
3. Add the secret as `NOTION_TOKEN` in Netlify and redeploy.

A scheduled function then creates two databases on that page — **Picnic bestellingen** (one row per delivery) and
**Picnic bestelregels** (one row per product per delivery) — copies all completed deliveries once (newest first;
large histories take a few hours because Notion allows ~3 changes per second) and afterwards checks every 6 hours for
new deliveries. Progress: button **Voortgang bestelgeschiedenis** on the login page. Payment details are never copied.

---

## Security model

- **Two separate secrets.** `CONNECTOR_SECRET` decides who may talk to your connector; Picnic's login token decides
  what the connector may do at Picnic. Both live only in your Netlify project, never in the code.
- **Wrong or missing key → `404 Not found`.** The connector doesn't reveal that it exists.
- **No ordering or payment tools.** The worst a misbehaving assistant can do is change your cart.
- **Rate limits** on the connector and the login page.
- **Revoking:** *Uitloggen* on the login page invalidates the Picnic token. A new `CONNECTOR_SECRET` (plus redeploy)
  locks out the old connector address.
- **Recommended:** two-factor login on GitHub, Netlify (or the account you log in with) and Picnic.

Found a security problem? See [SECURITY.md](SECURITY.md).

## Updating

Netlify redeploys automatically on every change to your repository's `main` branch.
To get improvements from this repository into your fork: on GitHub, **Sync fork**.

## Development

```bash
npm install
npm run typecheck
npx netlify-cli dev      # local test at http://localhost:8888 (Blobs are local and empty)
```

## License

[MIT](LICENSE) — uses [picnic-api](https://github.com/MRVDH/picnic-api) (MIT) and the
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (MIT).
