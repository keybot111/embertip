// EmberTip — serverless BCH payment pages.
// A page config is encoded in the URL hash; nothing is stored on any server.
// Payments: BIP-21 QR for any wallet, or WizardConnect signing.
// Live feed: Haskoin public API (no key, CORS-enabled).

import { connectWizard, wizardPay, wizardConnected, disconnectWizard } from "./wallet.js";
import { decodeCashAddress } from "@bitauth/libauth";
import qrcode from "qrcode-generator";

const HASKOIN = "https://api.haskoin.com/bch";
const EXPLORER_TX = "https://www.blockchair.com/bitcoin-cash/transaction/";

// The project's own demo page (also receives EMBER2026 votes — see banner).
export const PROJECT_PAGE = {
  n: "EmberTip — official demo",
  a: "bitcoincash:qpankkh7t7w9kaajlfwh7djdtatmz7qjgqr7876ctu",
  amts: ["0.001", "0.005", "0.01"],
  note: "This live demo page receives real BCH on mainnet. Try a tiny tip, watch it land in the feed below, or send EMBER2026 tokens to vote for us in Community Choice.",
};

const app = document.getElementById("app");
let feedTimer = null;

// ── helpers ────────────────────────────────────────────────────────────────
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

function bchToSats(str) {
  const m = String(str).trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) return null;
  return BigInt(m[1]) * 100000000n + BigInt((m[2] || "").padEnd(8, "0"));
}
function satsToBch(sats) {
  const v = BigInt(sats);
  const whole = v / 100000000n;
  const frac = (v % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
function encodeConfig(cfg) {
  const json = JSON.stringify(cfg);
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeConfig(payload) {
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

let usdRate = null;
async function getUsdRate() {
  if (usdRate) return usdRate;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd");
    const j = await r.json();
    usdRate = j["bitcoin-cash"].usd;
  } catch {
    try {
      const r = await fetch("https://api.blockchair.com/bitcoin-cash/stats");
      const j = await r.json();
      usdRate = j.data.market_price_usd;
    } catch { usdRate = null; }
  }
  return usdRate;
}

// ── Haskoin data ───────────────────────────────────────────────────────────
async function fetchUtxos(address) {
  const r = await fetch(`${HASKOIN}/address/${address}/unspent`);
  if (!r.ok) throw new Error(`UTXO lookup failed (${r.status})`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

async function fetchIncoming(address) {
  const [balRes, txRes] = await Promise.all([
    fetch(`${HASKOIN}/address/${address}/balance`),
    fetch(`${HASKOIN}/address/${address}/transactions/full?limit=25`),
  ]);
  const balance = balRes.ok ? await balRes.json() : null;
  const txs = txRes.ok ? await txRes.json() : [];
  const incoming = [];
  for (const tx of Array.isArray(txs) ? txs : []) {
    let sum = 0n;
    for (const out of tx.outputs || []) {
      if (out.address === address) sum += BigInt(out.value);
    }
    if (sum > 0n) {
      incoming.push({
        txid: tx.txid,
        sats: sum,
        time: tx.time || tx.block?.time || null,
        confirmed: Boolean(tx.block?.height),
      });
    }
  }
  return { received: balance?.received ?? null, incoming };
}

// ── QR rendering ───────────────────────────────────────────────────────────
async function drawQr(canvas, text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const scale = Math.max(4, Math.floor(264 / n));
  canvas.width = canvas.height = n * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#12211c";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(c * scale, r * scale, scale, scale);
    }
  }
}

// ── views ──────────────────────────────────────────────────────────────────
function homeView() {
  stopFeed();
  app.innerHTML = `
    <section class="hero">
      <h1>Your BCH payment page,<br><span class="grad">live in 30 seconds.</span></h1>
      <p>EmberTip turns any Bitcoin Cash address into a beautiful payment page —
      preset amounts, one-tap wallet payments and a live receipt feed.
      No server, no account, no custody. Your keys stay yours.</p>
      <div class="cta-row">
        <a class="btn" href="#/create">Create your page — free</a>
        <a class="btn secondary" href="#/p/demo">See the live demo</a>
      </div>
    </section>
    <section class="features">
      <div class="feature"><h3>⚡ Real mainnet payments</h3>
        <p>Visitors pay real BCH: scan the BIP-21 QR with any wallet, or connect
        with WizardConnect and sign in one tap.</p></div>
      <div class="feature"><h3>🛰️ Live receipt feed</h3>
        <p>Payments appear on your page as they hit the chain — amount, time and
        an explorer link for every tip.</p></div>
      <div class="feature"><h3>🔑 Non-custodial by design</h3>
        <p>Your page config lives inside its own link. EmberTip has no database
        and never sees a private key or a satoshi.</p></div>
      <div class="feature"><h3>🎁 Made for creators &amp; merchants</h3>
        <p>Tip jars, donations, pay-what-you-want downloads, invoice links —
        if it has a price in BCH, it has an EmberTip page.</p></div>
    </section>
    <section class="card">
      <h2>How it works</h2>
      <p><strong>1.</strong> Enter your name and BCH address. <strong>2.</strong> Share
      your page link or QR anywhere. <strong>3.</strong> Get paid on mainnet and watch
      the feed. That's it — the page works from any static host, forever, even if
      this site disappears.</p>
    </section>`;
}

function createView() {
  stopFeed();
  app.innerHTML = `
    <section class="card">
      <h2>Create your EmberTip page</h2>
      <label for="f-name">Page name</label>
      <input type="text" id="f-name" placeholder="e.g. Sari's Coffee Truck" maxlength="60">
      <label for="f-addr">Your Bitcoin Cash address</label>
      <input type="text" id="f-addr" placeholder="bitcoincash:q…" spellcheck="false">
      <div class="hint">Payments go straight to this address in your own wallet. EmberTip never holds funds.</div>
      <label for="f-amts">Preset amounts (BCH, comma separated)</label>
      <input type="text" id="f-amts" value="0.001, 0.005, 0.01">
      <label for="f-note">Short note (optional)</label>
      <textarea id="f-note" rows="2" maxlength="180" placeholder="Thanks for supporting my work!"></textarea>
      <div class="error" id="f-error"></div>
      <button class="btn" id="f-create">Create my page</button>
      <div id="f-result"></div>
    </section>`;
  $("#f-create").addEventListener("click", async () => {
    const err = $("#f-error");
    err.textContent = "";
    const name = $("#f-name").value.trim();
    const addr = $("#f-addr").value.trim();
    const amts = $("#f-amts").value.split(",").map((s) => s.trim()).filter(Boolean);
    const note = $("#f-note").value.trim();
    if (!name) { err.textContent = "Give your page a name."; return; }
    if (amts.length === 0 || amts.some((a) => bchToSats(a) === null)) {
      err.textContent = "Amounts must be BCH numbers like 0.005 (up to 8 decimals).";
      return;
    }
    try {
      const decoded = decodeCashAddress(addr);
      if (typeof decoded === "string" || !decoded?.payload) throw new Error("bad address");
    } catch {
      err.textContent = "That doesn't look like a valid Bitcoin Cash address (bitcoincash:q…).";
      return;
    }
    const cfg = { n: name, a: addr, amts, note };
    const link = `${location.origin}${location.pathname}#/p/${encodeConfig(cfg)}`;
    $("#f-result").innerHTML = `
      <label>Your page link — share it anywhere</label>
      <div class="share-box">
        <input type="text" readonly value="${esc(link)}" id="share-link">
        <button class="btn small" id="share-copy">Copy</button>
        <a class="btn small secondary" href="#/p/${encodeConfig(cfg)}">Open page</a>
      </div>
      <div class="hint">Tip: the whole page lives inside this link. Bookmark it — there is no account to log into.</div>`;
    $("#share-copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(link).catch(() => {});
      $("#share-copy").textContent = "Copied!";
    });
  });
}

function pageView(cfg) {
  stopFeed();
  const amounts = cfg.amts?.length ? cfg.amts : ["0.001", "0.005", "0.01"];
  let selected = amounts[Math.min(1, amounts.length - 1)];
  app.innerHTML = `
    <section class="card paypage">
      <div class="avatar">🔥</div>
      <h1>${esc(cfg.n)}</h1>
      ${cfg.note ? `<p class="note">${esc(cfg.note)}</p>` : ""}
      <div class="addr-line">Pays to <code>${esc(cfg.a)}</code></div>
      <div class="total-line" id="total-line">Loading total received…</div>
      <div class="amounts" id="amounts">
        ${amounts.map((a) => `<button class="amount-chip${a === selected ? " active" : ""}" data-amt="${esc(a)}">${esc(a)} BCH</button>`).join("")}
      </div>
      <div class="custom-amount">
        <input type="text" id="custom-amt" placeholder="Custom amount (BCH)">
      </div>
      <div class="qr-wrap"><canvas id="pay-qr" width="264" height="264"></canvas></div>
      <p class="status" id="pay-status">Scan with any BCH wallet — or pay in one tap:</p>
      <div class="cta-row">
        <button class="btn" id="btn-wizard">Pay with WizardConnect wallet</button>
      </div>
      <div id="wizard-box"></div>
    </section>
    <section class="card feed">
      <h3>🛰️ Live payments</h3>
      <div id="feed-list"><div class="feed-empty">Listening for payments…</div></div>
    </section>`;

  const status = (msg, cls = "") => {
    const el = $("#pay-status");
    el.textContent = msg;
    el.className = `status ${cls}`;
  };

  async function refreshQr() {
    const custom = $("#custom-amt").value.trim();
    const amt = custom || selected;
    if (bchToSats(amt) === null) {
      status("Enter a valid BCH amount.", "err");
      return;
    }
    const uri = `${cfg.a}?amount=${amt}`;
    await drawQr($("#pay-qr"), uri).catch(() => {
      status("QR library failed to load — copy the address above instead.", "err");
    });
    const rate = await getUsdRate();
    const usd = rate ? ` ≈ $${(parseFloat(amt) * rate).toFixed(2)}` : "";
    status(`Pay ${amt} BCH${usd} — scan with any BCH wallet, or pay in one tap:`);
    return amt;
  }

  $("#amounts").addEventListener("click", (e) => {
    const chip = e.target.closest(".amount-chip");
    if (!chip) return;
    selected = chip.dataset.amt;
    document.querySelectorAll(".amount-chip").forEach((c) => c.classList.toggle("active", c === chip));
    $("#custom-amt").value = "";
    refreshQr();
  });
  $("#custom-amt").addEventListener("input", refreshQr);
  refreshQr();

  // WizardConnect pay flow
  $("#btn-wizard").addEventListener("click", async () => {
    const box = $("#wizard-box");
    const amtStr = $("#custom-amt").value.trim() || selected;
    const amountSats = bchToSats(amtStr);
    if (amountSats === null) { status("Enter a valid BCH amount first.", "err"); return; }
    try {
      if (!wizardConnected()) {
        box.innerHTML = `
          <div class="qr-wrap"><canvas id="wiz-qr" width="264" height="264"></canvas></div>
          <p class="status" id="wiz-status">Preparing pairing…</p>`;
        await connectWizard(
          (uri) => { drawQr($("#wiz-qr"), uri).catch(() => {}); },
          (msg) => { const el = $("#wiz-status"); if (el) el.textContent = msg; }
        );
        box.innerHTML = `<p class="status ok">Wallet connected ✓ — tap the button again to send the payment.</p>`;
        $("#btn-wizard").textContent = `Send ${amtStr} BCH from my wallet`;
        return;
      }
      status("Building transaction…");
      const { txid } = await wizardPay({
        toCashaddr: cfg.a,
        amountSats,
        fetchUtxos,
        onStatus: (m) => status(m),
      });
      status(`Payment sent! txid ${txid}`, "ok");
      box.innerHTML = `<p class="status ok">✅ Broadcast — <a href="${EXPLORER_TX}${txid}" target="_blank" rel="noopener">view on explorer</a>. It will appear in the feed below within seconds.</p>`;
      setTimeout(() => refreshFeed(cfg), 4000);
    } catch (e) {
      status(`WizardConnect: ${e.message}`, "err");
    }
  });

  refreshFeed(cfg);
  feedTimer = setInterval(() => refreshFeed(cfg), 30000);
}

async function refreshFeed(cfg) {
  try {
    const { received, incoming } = await fetchIncoming(cfg.a);
    const totalEl = $("#total-line");
    if (totalEl && received !== null) {
      const rate = await getUsdRate();
      const usd = rate ? ` (≈ $${(parseFloat(satsToBch(received)) * rate).toFixed(2)})` : "";
      totalEl.textContent = `Total received: ${satsToBch(received)} BCH${usd}`;
    }
    const list = $("#feed-list");
    if (!list) return;
    if (incoming.length === 0) {
      list.innerHTML = `<div class="feed-empty">No payments yet — be the first! 🧡</div>`;
      return;
    }
    list.innerHTML = incoming.slice(0, 8).map((p) => `
      <div class="feed-item">
        <span><span class="amt">+${satsToBch(p.sats)} BCH</span>
          <span class="meta"> · ${p.confirmed ? "confirmed" : "in mempool"}${p.time ? " · " + new Date(p.time * 1000).toLocaleString() : ""}</span></span>
        <a href="${EXPLORER_TX}${p.txid}" target="_blank" rel="noopener">tx ↗</a>
      </div>`).join("");
  } catch {
    const list = $("#feed-list");
    if (list) list.innerHTML = `<div class="feed-empty">Feed unavailable right now (indexer unreachable) — payments still work via QR/wallet.</div>`;
  }
}

function stopFeed() {
  if (feedTimer) { clearInterval(feedTimer); feedTimer = null; }
}

// ── router ─────────────────────────────────────────────────────────────────
function route() {
  const hash = location.hash || "#/";
  disconnectWizard().catch(() => {});
  if (hash === "#/" || hash === "") return homeView();
  if (hash.startsWith("#/create")) return createView();
  if (hash.startsWith("#/p/demo")) return pageView(PROJECT_PAGE);
  if (hash.startsWith("#/p/")) {
    try {
      const cfg = decodeConfig(hash.slice(4));
      if (!cfg.n || !cfg.a) throw new Error("bad config");
      return pageView(cfg);
    } catch {
      app.innerHTML = `<section class="card"><h2>That page link is broken</h2>
        <p>The configuration inside the link couldn't be read. <a href="#/create">Create a fresh page</a>.</p></section>`;
      return;
    }
  }
  homeView();
}
window.addEventListener("hashchange", route);
route();
