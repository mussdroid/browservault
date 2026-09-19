# BrowserVault — Agent Supervision Console

**A human-in-the-loop harness that lets AI agents shop, book travel, and renew software — but never spend a cent without a human clicking Approve.**

- **Live console:** https://browservault.mussdroid.workers.dev
- **MCP endpoint (connect any agent):** `https://browservault.mussdroid.workers.dev/mcp`

Built for the TrueFoundry Agent Harness Hackathon (Santa Clara, Sep 19, 2026) by team **Frontera**.

## What it does

Any MCP-capable agent (tested with Meta Muse, Grok, Cursor, and Claude) connects to the remote MCP server and gets tools for three simulated commerce workflows:

| Workflow | Site | Tools |
|---|---|---|
| 🛒 Shopping | Cartwheel | `search_products` → `add_to_cart` → `checkout` → `place_order` |
| ✈️ Travel booking | SkyTrip | `search_flights` → `view_fare` → `book_flight` → `complete_booking` |
| 🔑 License renewal | FluxTools | `get_license_status` → `find_promo_code` → `renew_license` → `complete_renewal` |

The agent browses freely — but **every payment tool call blocks server-side** on a pending approval that only a human can resolve in the supervision console. `list_catalog` shows everything purchasable across all three workflows.

## Runs inside TrueForge (the agent harness)

BrowserVault is a plain remote MCP server, so it drops straight into **[TrueForge](https://trueforge.dev)**, TrueFoundry's open-source agent harness:

1. **Model** — add Grok (`grok-4.5`) as a custom OpenAI-compatible provider (`https://api.x.ai/v1`).
2. **Connector** — Settings → Connectors → Add MCP Server: `https://browservault.mussdroid.workers.dev/mcp` (no auth). All 16 tools appear.
3. **Agent** — build a `browservault-shopper` agent (Grok + BrowserVault tools) instructed to poll `check_approval` after a payment blocks.

Then in TrueForge chat: *"Buy me a HEPA filter from the vault store."* TrueForge runs the loop and streams every tool call; at checkout the agent blocks, the **approval card** lights up in the BrowserVault console, a human clicks **Approve**, and the order completes. Verified end-to-end (order `CW-319820`).

The division of labor: **TrueForge = the harness** (model routing, tool execution, the agent loop, sessions, its own approval capability); **BrowserVault = the MCP tool server + supervision layer** enforcing the human payment gate. Two independent approval layers, defense in depth.

## Voice presenter (Grok realtime)

The console ships a **🎙 Present** mode: a Grok realtime voice guide (xAI `wss://api.x.ai/v1/realtime`, voice `leo`) that gives a spoken tour and answers judge questions live. The `XAI_API_KEY` is a **Cloudflare Worker secret**; the Worker's `/api/voice/session` mints a 5-minute ephemeral token, so the key never reaches the browser. It's open-mic (server VAD — just talk, no push-to-talk) and routes audio through a media element so screen recorders capture it.

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
