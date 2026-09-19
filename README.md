# BrowserVault — Agent Supervision Console

**A human-in-the-loop harness that lets AI agents shop, book travel, and renew software — but never spend a cent without a human clicking Approve.**

- **Live console:** https://browservault.mussdroid.workers.dev
- **MCP endpoint (connect any agent):** `https://browservault.mussdroid.workers.dev/mcp`

Built for the TrueFoundry Agent Harness Hackathon (Santa Clara, Sep 19, 2026) by team **Frontera**.

## What it does

Any MCP-capable agent (tested with Grok, Cursor, and Claude) connects to the remote MCP server and gets tools for three simulated commerce workflows:

| Workflow | Site | Tools |
|---|---|---|
| 🛒 Shopping | Cartwheel | `search_products` → `add_to_cart` → `checkout` → `place_order` |
| ✈️ Travel booking | SkyTrip | `search_flights` → `view_fare` → `book_flight` → `complete_booking` |
| 🔑 License renewal | FluxTools | `get_license_status` → `find_promo_code` → `renew_license` → `complete_renewal` |

The agent browses freely — but **every payment tool call blocks server-side** on a pending approval that only a human can resolve in the supervision console. `list_catalog` shows everything purchasable across all three workflows.

## Observe · Control · Test

**Observe** — Split-screen console: the agent's page-by-page activity rendered in a mock browser viewport, a full activity log with per-step snapshots, and network-level connection detection — client name, user agent, ASN/organization, and geo appear the moment any MCP client touches the endpoint (handshake-less traffic is flagged as an unidentified probe).

**Control** — Approvals are single-use, type-checked, and enforced in a Cloudflare Durable Object — not in the agent's prompt. Credentials live in a masked vault the agent never sees. A denial permanently blocks the charge and instructs the agent to stand down.

**Test** — Repeatable end-to-end runs across all three workflows, including failure paths: denied payments hard-fail, consumed approvals cannot be replayed, and an approval for one workflow cannot be spent on another.

Everything on the store side is simulated — no real products, payments, or charges. The supervision mechanics are real and enforced server-side.

## Architecture

```
Agent (Grok / Cursor / Claude / any MCP client)
   │  MCP over streamable HTTP (JSON-RPC)
   ▼
Cloudflare Worker ── /mcp ──► Durable Object (session state, catalog, approvals)
   │                                ▲
   ├── /api/state  (console polls)  │ approve / deny (single-use, type-checked)
   ├── /api/approve · /api/deny ────┘
   └── /  static console (public/index.html)
```

- `src/worker.js` — Worker + Durable Object: MCP server (initialize, tools/list, tools/call), the three workflow tool sets, approval state machine, connection detection.
- `public/index.html` — the supervision console: live browser view, approval card, masked credential vault, cart, connections, activity log with snapshots, and a QR code for connecting a bot from a phone.

## Run it yourself

```bash
npx wrangler dev          # local dev at http://localhost:8787
npx wrangler deploy       # deploy to your Cloudflare account
```

Then open the deployed URL, and point any MCP client at `<your-url>/mcp`. Try:

> "What products are available in the vault?" · "Buy the HEPA filter." · "Book the cheapest nonstop SFO → AUS flight." · "Renew the Flux license — use a promo if you find one."

When the bot reaches the payment step, it blocks — and the approval card appears in the console.
