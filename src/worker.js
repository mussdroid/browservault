/**
 * BrowserVault Live — Cloudflare Worker
 *
 * Serves the supervision console (static asset) plus:
 *   POST /mcp          — remote MCP server (streamable HTTP, JSON responses).
 *                        Any MCP client (Grok, Claude, etc.) gets shopping tools
 *                        for the mocked "Cartwheel" store. checkout() pauses
 *                        until a human approves in the console.
 *   GET  /api/state    — console polls the live session state
 *   POST /api/approve  — supervisor approves the pending action
 *   POST /api/deny     — supervisor denies it (halts the purchase)
 *   POST /api/reset    — clear the session
 *
 * Everything is simulated: no real store, no real payments.
 */

const CATALOG = [
  { id: "hepa13", name: "Airmax OEM HEPA-13 Filter (300 series)", price: 34.99, rating: 4.8, reviews: 2113, blurb: "Genuine replacement filter, fits Airmax 300/310." },
  { id: "buds",   name: "Pebble ANC Wireless Earbuds",            price: 79.99, rating: 4.6, reviews: 981,  blurb: "Active noise cancelling, 28h battery." },
  { id: "kettle", name: "Voltra Gooseneck Kettle 0.9L",           price: 49.00, rating: 4.7, reviews: 1540, blurb: "Variable temperature, pour-over ready." },
  { id: "lamp",   name: "Lumo Desk Lamp",                         price: 39.95, rating: 4.5, reviews: 622,  blurb: "Adjustable warm/cool light, USB-C powered." },
  { id: "cable",  name: "Corda USB-C 100W Cable 2m",              price: 12.99, rating: 4.4, reviews: 3307, blurb: "Braided, e-marked, 100W PD." },
  { id: "mug",    name: "Terraware Ceramic Mug 350ml",            price: 14.50, rating: 4.9, reviews: 458,  blurb: "Double-walled stoneware, matte glaze." },
];

const FLIGHTS = [
  { id: "CL1184", name: "Coastline Air 1184", depart: "Oct 12, 7:05a → 12:40p", ret: "Oct 15, 6:15p", fare: 312.00, taxes: 35.18, nonstop: true },
  { id: "TP502",  name: "TransPeak 502",      depart: "Oct 12, 9:40a → 3:05p",  ret: "Oct 15, 7:30p", fare: 358.00, taxes: 39.90, nonstop: true },
  { id: "JW88",   name: "Jetway 88",          depart: "Oct 12, 1:20p → 6:45p",  ret: "Oct 15, 8:10p", fare: 371.00, taxes: 41.20, nonstop: true },
];

const LICENSE = { product: "Flux Design Suite — Team", seats: 12, expires: "Sep 30, 2026", pricePerSeat: 99.00 };
const PROMO = { code: "RENEW15", pct: 15, desc: "15% off annual team renewals, valid through Oct 31" };

const TAX_RATE = 0.0825;
const money = (n) => "$" + n.toFixed(2);

function totals(cart) {
  const subtotal = cart.reduce((s, l) => s + l.price * l.qty, 0);
  const shipping = subtotal === 0 ? 0 : subtotal >= 35 ? 0 : 4.99;
  const tax = (subtotal + shipping) * TAX_RATE;
  return { subtotal, shipping, tax, total: subtotal + shipping + tax };
}

function freshState() {
  return {
    status: "waiting", // waiting | browsing | awaiting | approved | denied | done
    agent: null,       // {name, version, connectedAt}
    connections: [],   // recent connection attempts: {t, name, version, ua, org, loc, ip}
    probeLogged: false,
    page: { view: "home", url: "https://cartwheel.example/" },
    cart: [],
    approval: null,    // {id, kind, status, title, rows, amount, consumed}
    lastOrder: null,
    lastBooking: null,
    lastRenewal: null,
    log: [],
  };
}

function maskIp(ip) {
  if (!ip) return "";
  if (ip.includes(".")) return ip.split(".").slice(0, 3).join(".") + ".•••";
  return ip.split(":").slice(0, 2).join(":") + ":••••";
}

const JSON_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS, DELETE",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id",
};

export class Session {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.state = freshState();
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get("s");
      if (saved) this.state = saved;
    });
  }

  async save() { await this.ctx.storage.put("s", this.state); }

  log(actor, action, outcome, badge) {
    this.state.log.push({
      t: new Date().toISOString(),
      actor, action, outcome, badge,
      page: JSON.parse(JSON.stringify(this.state.page)),
    });
    if (this.state.log.length > 100) this.state.log.splice(0, this.state.log.length - 100);
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

    try {
      if (url.pathname === "/api/state") {
        return new Response(JSON.stringify(this.state), { headers: JSON_HEADERS });
      }
      if (url.pathname === "/api/approve" && req.method === "POST") {
        if (this.state.approval && this.state.approval.status === "pending") {
          this.state.approval.status = "approved";
          this.state.status = "approved";
          this.log("supervisor", "You approved: " + this.state.approval.title, "Approved by you", "accent");
          await this.save();
        }
        return new Response(JSON.stringify(this.state), { headers: JSON_HEADERS });
      }
      if (url.pathname === "/api/deny" && req.method === "POST") {
        if (this.state.approval && this.state.approval.status === "pending") {
          this.state.approval.status = "denied";
          this.state.status = "denied";
          this.log("supervisor", "You denied: " + this.state.approval.title, "Denied", "bad");
          this.log("system", "Purchase blocked — the agent cannot charge this card", "Halted", "bad");
          await this.save();
        }
        return new Response(JSON.stringify(this.state), { headers: JSON_HEADERS });
      }
      if (url.pathname === "/api/reset" && req.method === "POST") {
        this.state = freshState();
        await this.ctx.storage.put("s", this.state);
        return new Response(JSON.stringify(this.state), { headers: JSON_HEADERS });
      }
      if (url.pathname === "/mcp") {
        if (req.method === "GET") return new Response("SSE not supported; POST JSON-RPC here.", { status: 405, headers: JSON_HEADERS });
        if (req.method === "DELETE") return new Response(null, { status: 200, headers: JSON_HEADERS });
        const body = await req.json();
        const meta = {
          ua: req.headers.get("x-bv-ua") || "unknown",
          ip: maskIp(req.headers.get("x-bv-ip") || ""),
          org: req.headers.get("x-bv-org") || "",
          loc: req.headers.get("x-bv-loc") || "",
        };
        return this.mcp(body, meta);
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: JSON_HEADERS });
    }
  }

  /* ---------------- MCP (JSON-RPC over streamable HTTP) ---------------- */
  async mcp(msg, meta = {}) {
    const reply = (result) => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }),
      { headers: { ...JSON_HEADERS, "mcp-session-id": "main" } });
    const rpcError = (code, message) => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } }),
      { headers: JSON_HEADERS });

    if (Array.isArray(msg)) return rpcError(-32600, "Batching not supported");
    if (!msg || msg.jsonrpc !== "2.0") return rpcError(-32600, "Invalid request");

    // Notifications get an empty 202
    if (msg.id === undefined || msg.id === null) {
      return new Response(null, { status: 202, headers: JSON_HEADERS });
    }

    // Detection: traffic on /mcp before any handshake = an unidentified probe.
    if (msg.method !== "initialize" && !this.state.agent && !this.state.probeLogged) {
      this.state.probeLogged = true;
      this.log("system", `Unidentified MCP traffic (no handshake yet) — ${meta.org || "unknown network"}${meta.loc ? ", " + meta.loc : ""} · UA: ${meta.ua}`, "Probe", "warn");
      await this.save();
    }

    switch (msg.method) {
      case "initialize": {
        const ci = msg.params?.clientInfo || {};
        this.state.agent = { name: ci.name || "unknown-agent", version: ci.version || "", connectedAt: new Date().toISOString() };
        this.state.connections.unshift({
          t: new Date().toISOString(),
          name: this.state.agent.name, version: this.state.agent.version,
          ua: meta.ua, org: meta.org, loc: meta.loc, ip: meta.ip,
        });
        if (this.state.connections.length > 10) this.state.connections.length = 10;
        if (this.state.status === "waiting") this.state.status = "browsing";
        this.log("system",
          `Incoming MCP connection — client "${this.state.agent.name}${this.state.agent.version ? " " + this.state.agent.version : ""}" from ${meta.org || "unknown network"}${meta.loc ? " (" + meta.loc + ")" : ""}`,
          "Connected", "accent");
        await this.save();
        return reply({
          protocolVersion: msg.params?.protocolVersion || "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "browservault-cartwheel", version: "1.0.0" },
          instructions:
            "BrowserVault demo — three SIMULATED workflows, all supervised by a human console. " +
            "Asked what is available to buy? Call list_catalog and show the user the items with prices. " +
            "SHOPPING (Cartwheel store): search_products → add_to_cart → checkout → place_order. " +
            "TRAVEL (SkyTrip): search_flights → view_fare → book_flight → complete_booking. " +
            "SOFTWARE RENEWAL (FluxTools): get_license_status → find_promo_code → renew_license → complete_renewal. " +
            "Every payment step PAUSES for HUMAN APPROVAL: poll check_approval every few seconds until approved or denied, " +
            "then call the matching completion tool. Only one approval can be pending at a time. No real money is involved.",
        });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        const { name, arguments: args = {} } = msg.params || {};
        try {
          const out = await this.callTool(name, args);
          await this.save();
          return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: false });
        } catch (e) {
          await this.save();
          return reply({ content: [{ type: "text", text: String(e.message || e) }], isError: true });
        }
      }
      default: return rpcError(-32601, "Method not found: " + msg.method);
    }
  }

  async callTool(name, args) {
    const S = this.state;
    const findProduct = (id) => {
      const p = CATALOG.find((p) => p.id === id);
      if (!p) throw new Error(`Unknown product_id "${id}". Use search_products first.`);
      return p;
    };

    switch (name) {
      case "list_catalog": {
        S.status = "browsing";
        S.page = { view: "results", url: "https://cartwheel.example/results?q=all", query: "all products", items: CATALOG.map((p) => p.id) };
        this.log("agent", "Listed the full BrowserVault catalog (products, flights, renewal)", "OK", "ok");
        return {
          note: "Everything available in the BrowserVault demo. All items are SIMULATED — purchases require human approval in the console.",
          cartwheel_products: CATALOG.map((p) => ({ product_id: p.id, name: p.name, price: money(p.price), rating: p.rating, description: p.blurb })),
          skytrip_flights: FLIGHTS.map((f) => ({ flight_id: f.id, name: f.name, route: "SFO → AUS round trip, Oct 12–15", depart: f.depart, total_with_taxes: money(f.fare + f.taxes) })),
          fluxtools_renewal: { product: LICENSE.product, seats: LICENSE.seats, expires: LICENSE.expires, renewal_price: money(LICENSE.seats * LICENSE.pricePerSeat) + "/yr", promo_hint: "Call find_promo_code for a discount." },
          how_to_buy: "Products: add_to_cart → checkout. Flights: book_flight. License: renew_license. Each pauses for human approval.",
        };
      }
      case "search_products": {
        const q = (args.query || "").toLowerCase().trim();
        const items = q ? CATALOG.filter((p) => (p.name + " " + p.blurb).toLowerCase().includes(q)) : CATALOG;
        S.status = "browsing";
        S.page = { view: "results", url: `https://cartwheel.example/results?q=${encodeURIComponent(q || "all")}`, query: q || "all products", items: items.map((p) => p.id) };
        this.log("agent", `Searched Cartwheel for "${q || "all products"}" — ${items.length} result(s)`, "OK", "ok");
        return { results: items.map((p) => ({ product_id: p.id, name: p.name, price: money(p.price), rating: p.rating, reviews: p.reviews })) };
      }
      case "view_product": {
        const p = findProduct(args.product_id);
        S.status = "browsing";
        S.page = { view: "product", url: `https://cartwheel.example/p/${p.id}`, id: p.id };
        this.log("agent", `Viewed product: ${p.name}`, "OK", "ok");
        return { product_id: p.id, name: p.name, price: money(p.price), rating: p.rating, reviews: p.reviews, description: p.blurb, stock: "In stock", delivery: "2–3 business days (free over $35)" };
      }
      case "add_to_cart": {
        const p = findProduct(args.product_id);
        const qty = Math.max(1, Math.min(5, Number(args.quantity) || 1));
        const line = S.cart.find((l) => l.id === p.id);
        if (line) line.qty = Math.min(5, line.qty + qty); else S.cart.push({ id: p.id, name: p.name, price: p.price, qty });
        S.status = "browsing";
        S.page = { view: "cart", url: "https://cartwheel.example/cart" };
        this.log("agent", `Added to cart: ${qty} × ${p.name}`, "OK", "ok");
        const t = totals(S.cart);
        return { cart: S.cart.map((l) => ({ product_id: l.id, name: l.name, qty: l.qty, line_total: money(l.price * l.qty) })), subtotal: money(t.subtotal), note: "Call checkout when ready." };
      }
      case "view_cart": {
        const t = totals(S.cart);
        S.page = { view: "cart", url: "https://cartwheel.example/cart" };
        this.log("agent", "Reviewed the cart", "OK", "ok");
        return { cart: S.cart.map((l) => ({ product_id: l.id, name: l.name, qty: l.qty, line_total: money(l.price * l.qty) })), subtotal: money(t.subtotal), shipping: money(t.shipping), tax: money(t.tax), total: money(t.total) };
      }
      case "checkout": {
        if (!S.cart.length) throw new Error("Cart is empty — add_to_cart first.");
        if (S.approval && S.approval.status === "pending") {
          return { approval_id: S.approval.id, status: "pending", message: "Approval already pending. Poll check_approval." };
        }
        const t = totals(S.cart);
        const id = crypto.randomUUID().slice(0, 8);
        S.approval = {
          id, kind: "order", status: "pending", consumed: false, amount: t.total,
          title: `Charge ${money(t.total)} to Visa •••• 4821`,
          rows: [
            ["Permission", "Use stored payment method"],
            ["Merchant", "Cartwheel (simulated store)"],
            ["Items", S.cart.map((l) => `${l.qty} × ${l.name}`).join("; ")],
            ["Amount", `${money(t.total)} (${money(t.subtotal)} + ${money(t.shipping)} shipping + ${money(t.tax)} tax)`],
            ["Card", "Visa •••• •••• •••• 4821 (vault, masked)"],
            ["Requested by", (S.agent && S.agent.name) || "MCP agent"],
          ],
        };
        S.status = "awaiting";
        S.page = { view: "checkout", url: "https://cartwheel.example/checkout" };
        this.log("agent", "Requested checkout: " + S.approval.title, "Waiting", "warn");
        return {
          approval_id: id, status: "pending",
          message: "PAUSED FOR HUMAN APPROVAL. A supervisor must approve this charge in the BrowserVault console. Poll check_approval with this approval_id every 5 seconds until approved or denied.",
        };
      }
      case "check_approval": {
        const a = S.approval;
        if (!a || a.id !== args.approval_id) throw new Error("Unknown approval_id.");
        if (a.status === "pending") return { status: "pending", message: "Still waiting for the human supervisor." };
        if (a.status === "denied") return { status: "denied", message: "The supervisor DENIED this action. Do not retry; report back to the user." };
        const next = { order: "place_order", booking: "complete_booking", renewal: "complete_renewal" }[a.kind];
        return { status: "approved", message: `Approved! Call ${next} with the same approval_id to finish.` };
      }
      case "place_order": {
        const a = this.takeApproval(args.approval_id, "order");
        const orderNo = "CW-" + Math.floor(100000 + Math.random() * 899999);
        S.lastOrder = { number: orderNo, amount: a.amount, items: S.cart.map((l) => `${l.qty} × ${l.name}`), eta: "Arrives in 2–3 business days" };
        S.page = { view: "confirmation", url: `https://cartwheel.example/orders/${orderNo}` };
        S.status = "done";
        this.log("agent", `Order placed: ${orderNo} — ${money(a.amount)}`, "Success", "ok");
        const order = S.lastOrder;
        S.cart = [];
        return { order_number: order.number, total: money(order.amount), eta: order.eta, message: "Simulated purchase complete. No real charge occurred." };
      }
      /* ---------- Travel booking (SkyTrip) ---------- */
      case "search_flights": {
        const from = (args.from || "SFO").toUpperCase(), to = (args.to || "AUS").toUpperCase();
        S.status = "browsing";
        S.page = { view: "sky-results", url: `https://skytrip.example/results?${from.toLowerCase()}-${to.toLowerCase()}&nonstop`, from, to };
        this.log("agent", `Searched SkyTrip: ${from} → ${to}, Oct 12–15, nonstop — ${FLIGHTS.length} fares`, "OK", "ok");
        return { note: "Simulated fares for " + from + " → " + to + ", Oct 12–15 round trip, nonstop.",
          flights: FLIGHTS.map((f) => ({ flight_id: f.id, name: f.name, depart: f.depart, return: f.ret, fare: money(f.fare), total_with_taxes: money(f.fare + f.taxes) })) };
      }
      case "view_fare": {
        const f = FLIGHTS.find((f) => f.id === args.flight_id);
        if (!f) throw new Error(`Unknown flight_id "${args.flight_id}". Use search_flights first.`);
        S.page = { view: "sky-fare", url: `https://skytrip.example/fare/${f.id}`, id: f.id };
        this.log("agent", `Reviewed fare details: ${f.name}`, "OK", "ok");
        return { flight_id: f.id, name: f.name, depart: f.depart, return: f.ret, fare: money(f.fare), taxes: money(f.taxes), total: money(f.fare + f.taxes), rules: "Carry-on included; checked bag $35; free cancellation within 24h." };
      }
      case "book_flight": {
        const f = FLIGHTS.find((f) => f.id === args.flight_id);
        if (!f) throw new Error(`Unknown flight_id "${args.flight_id}". Use search_flights first.`);
        if (S.approval && S.approval.status === "pending")
          return { approval_id: S.approval.id, status: "pending", message: "Approval already pending. Poll check_approval." };
        const total = f.fare + f.taxes;
        const id = crypto.randomUUID().slice(0, 8);
        S.approval = {
          id, kind: "booking", status: "pending", consumed: false, amount: total, flightId: f.id,
          title: `Charge ${money(total)} to Visa •••• 4821`,
          rows: [
            ["Permission", "Use stored payment method"],
            ["Merchant", `SkyTrip · ${f.name} (simulated)`],
            ["Itinerary", `SFO → AUS ${f.depart} · returns ${f.ret}`],
            ["Amount", `${money(total)} (${money(f.fare)} fare + ${money(f.taxes)} taxes)`],
            ["Card", "Visa •••• •••• •••• 4821 (vault, masked)"],
            ["Refundable", "Free cancellation within 24h"],
            ["Requested by", (S.agent && S.agent.name) || "MCP agent"],
          ],
        };
        S.status = "awaiting";
        S.page = { view: "sky-checkout", url: "https://skytrip.example/checkout/payment", id: f.id };
        this.log("agent", "Requested flight booking: " + S.approval.title, "Waiting", "warn");
        return { approval_id: id, status: "pending", message: "PAUSED FOR HUMAN APPROVAL. Poll check_approval every 5 seconds, then call complete_booking if approved." };
      }
      case "complete_booking": {
        const a = this.takeApproval(args.approval_id, "booking");
        const f = FLIGHTS.find((f) => f.id === a.flightId) || FLIGHTS[0];
        const code = "SKT-" + Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");
        S.lastBooking = { code, flight: f.name, itinerary: `SFO → AUS ${f.depart} · returns ${f.ret}`, amount: a.amount };
        S.page = { view: "sky-confirmation", url: `https://skytrip.example/confirmation/${code}` };
        S.status = "done";
        this.log("agent", `Flight booked: ${code} — ${money(a.amount)}`, "Success", "ok");
        return { confirmation_code: code, flight: f.name, total: money(a.amount), message: "Simulated booking complete. No real charge occurred." };
      }

      /* ---------- Software renewal (FluxTools) ---------- */
      case "get_license_status": {
        S.status = "browsing";
        S.page = { view: "flux-licenses", url: "https://fluxtools.example/account/licenses" };
        this.log("agent", `Checked license: ${LICENSE.product}, ${LICENSE.seats} seats, expires ${LICENSE.expires}`, "OK", "ok");
        return { product: LICENSE.product, seats: LICENSE.seats, expires: LICENSE.expires, list_renewal_price: money(LICENSE.seats * LICENSE.pricePerSeat) + "/yr", note: "Renewal available now. Check find_promo_code before renewing." };
      }
      case "find_promo_code": {
        S.page = { view: "flux-promos", url: "https://fluxtools.example/promos/renewal" };
        this.log("agent", `Found promo: ${PROMO.code} — ${PROMO.desc}`, "OK", "ok");
        return { promo_code: PROMO.code, discount: PROMO.pct + "%", details: PROMO.desc };
      }
      case "renew_license": {
        if (S.approval && S.approval.status === "pending")
          return { approval_id: S.approval.id, status: "pending", message: "Approval already pending. Poll check_approval." };
        const list = LICENSE.seats * LICENSE.pricePerSeat;
        const promoOk = (args.promo_code || "").toUpperCase() === PROMO.code;
        const total = promoOk ? list * (1 - PROMO.pct / 100) : list;
        const id = crypto.randomUUID().slice(0, 8);
        S.approval = {
          id, kind: "renewal", status: "pending", consumed: false, amount: total, promo: promoOk,
          title: `Charge ${money(total)} to Corporate Amex •3007`,
          rows: [
            ["Permission", "Use stored payment method"],
            ["Merchant", "FluxTools — annual team renewal (simulated)"],
            ["License", `${LICENSE.product}, ${LICENSE.seats} seats`],
            ["Amount", promoOk ? `${money(total)} (list ${money(list)} − ${PROMO.pct}% ${PROMO.code})` : `${money(total)} (list price, no promo)`],
            ["Card", "Corporate Amex •••• •••••• •3007 (vault, masked)"],
            ["Recurring", "No — single renewal, auto-renew stays off"],
            ["Requested by", (S.agent && S.agent.name) || "MCP agent"],
          ],
        };
        S.status = "awaiting";
        S.page = { view: "flux-checkout", url: "https://fluxtools.example/checkout/renewal" + (promoOk ? "?promo=" + PROMO.code : ""), promo: promoOk, total };
        this.log("agent", "Requested license renewal: " + S.approval.title, "Waiting", "warn");
        return { approval_id: id, status: "pending", message: "PAUSED FOR HUMAN APPROVAL. Poll check_approval every 5 seconds, then call complete_renewal if approved." };
      }
      case "complete_renewal": {
        const a = this.takeApproval(args.approval_id, "renewal");
        const invoice = "INV-" + Math.floor(10000 + Math.random() * 89999);
        S.lastRenewal = { invoice, amount: a.amount, product: LICENSE.product, seats: LICENSE.seats, newExpiry: "Sep 30, 2027" };
        S.page = { view: "flux-receipt", url: `https://fluxtools.example/receipt/${invoice}` };
        S.status = "done";
        this.log("agent", `License renewed: ${invoice} — ${money(a.amount)}`, "Success", "ok");
        return { invoice, total: money(a.amount), new_expiry: "Sep 30, 2027", message: "Simulated renewal complete. No real charge occurred." };
      }

      default: throw new Error("Unknown tool: " + name);
    }
  }

  takeApproval(approvalId, kind) {
    const a = this.state.approval;
    if (!a || a.id !== approvalId) throw new Error("Unknown approval_id.");
    if (a.kind !== kind) throw new Error(`This approval is for a ${a.kind}, not a ${kind}.`);
    if (a.status === "denied") throw new Error("This action was denied by the supervisor.");
    if (a.status !== "approved") throw new Error("Not approved yet — poll check_approval.");
    if (a.consumed) throw new Error("This approval was already used.");
    a.consumed = true;
    return a;
  }
}

const TOOLS = [
  { name: "list_catalog", description: "List EVERYTHING available in the BrowserVault demo vault: all Cartwheel store products, all SkyTrip flights, and the FluxTools license renewal, with prices and ids. ALWAYS call this first when the user asks what products, items, flights, or services are available, what's in the vault/store, or what can be purchased.",
    inputSchema: { type: "object", properties: {} } },
  { name: "search_products", description: "Search the Cartwheel demo store. Returns product ids, names, prices, ratings. Empty query lists everything.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Search terms, e.g. 'hepa filter'" } } } },
  { name: "view_product", description: "Get details for one product (price, rating, delivery).",
    inputSchema: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] } },
  { name: "add_to_cart", description: "Add a product to the cart.",
    inputSchema: { type: "object", properties: { product_id: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 5 } }, required: ["product_id"] } },
  { name: "view_cart", description: "Show the cart with subtotal, shipping, tax, and total.",
    inputSchema: { type: "object", properties: {} } },
  { name: "checkout", description: "Start the purchase. This PAUSES for human approval in the BrowserVault console and returns an approval_id — poll check_approval until it resolves.",
    inputSchema: { type: "object", properties: {} } },
  { name: "check_approval", description: "Check whether the human supervisor approved or denied the purchase. Poll every ~5 seconds while pending.",
    inputSchema: { type: "object", properties: { approval_id: { type: "string" } }, required: ["approval_id"] } },
  { name: "place_order", description: "Complete the shop purchase after check_approval returns approved.",
    inputSchema: { type: "object", properties: { approval_id: { type: "string" } }, required: ["approval_id"] } },

  { name: "search_flights", description: "TRAVEL DEMO — search SkyTrip for simulated round-trip flights (defaults SFO → AUS, Oct 12–15, nonstop). Returns flight ids and fares.",
    inputSchema: { type: "object", properties: { from: { type: "string", description: "Origin airport code, e.g. SFO" }, to: { type: "string", description: "Destination airport code, e.g. AUS" } } } },
  { name: "view_fare", description: "TRAVEL DEMO — fare rules and total with taxes for one flight.",
    inputSchema: { type: "object", properties: { flight_id: { type: "string" } }, required: ["flight_id"] } },
  { name: "book_flight", description: "TRAVEL DEMO — book a flight. PAUSES for human approval of the payment; poll check_approval, then complete_booking.",
    inputSchema: { type: "object", properties: { flight_id: { type: "string" } }, required: ["flight_id"] } },
  { name: "complete_booking", description: "TRAVEL DEMO — finish the booking after approval. Returns the confirmation code.",
    inputSchema: { type: "object", properties: { approval_id: { type: "string" } }, required: ["approval_id"] } },

  { name: "get_license_status", description: "RENEWAL DEMO — read the FluxTools license (product, seats, expiry, renewal price).",
    inputSchema: { type: "object", properties: {} } },
  { name: "find_promo_code", description: "RENEWAL DEMO — check FluxTools promotions for a renewal discount code.",
    inputSchema: { type: "object", properties: {} } },
  { name: "renew_license", description: "RENEWAL DEMO — start the license renewal (optionally with promo_code). PAUSES for human approval; poll check_approval, then complete_renewal.",
    inputSchema: { type: "object", properties: { promo_code: { type: "string" } } } },
  { name: "complete_renewal", description: "RENEWAL DEMO — finish the renewal after approval. Returns the invoice number.",
    inputSchema: { type: "object", properties: { approval_id: { type: "string" } }, required: ["approval_id"] } },
];

const ascii = (s) => String(s || "").replace(/[^\x20-\x7E]/g, "?").slice(0, 300);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
      const name = url.searchParams.get("session") || "main";
      const id = env.SESSION.idFromName(name);
      if (url.pathname === "/mcp") {
        // Attach network-level identity: user agent, IP, AS org, geo (from Cloudflare).
        const cf = req.cf || {};
        const hdrs = new Headers(req.headers);
        hdrs.set("x-bv-ua", ascii(req.headers.get("user-agent") || "unknown"));
        hdrs.set("x-bv-ip", ascii(req.headers.get("cf-connecting-ip") || ""));
        hdrs.set("x-bv-org", ascii(cf.asOrganization ? cf.asOrganization + (cf.asn ? " (AS" + cf.asn + ")" : "") : ""));
        hdrs.set("x-bv-loc", ascii([cf.city, cf.country].filter(Boolean).join(", ")));
        req = new Request(req, { headers: hdrs });
      }
      return env.SESSION.get(id).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
