/**
 * Embedded management console (PRD §31 Monitoring Dashboard, §24 Message
 * Viewer). Served at GET / by the API server. Vanilla JS, no build step.
 */
export function renderUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Integration Hub — Console</title>
<style>
  /* ── Design tokens ──────────────────────────────────────────────── */
  :root {
    color-scheme: dark;
    --bg:        #0a0c10;
    --surface:   #0f1218;
    --panel:     #13171f;
    --panel-alt: #161b24;
    --border:    #1e2430;
    --border-hi: #2a3244;
    --text:      #dde2ed;
    --text-dim:  #aab0c0;
    --muted:     #6b748a;
    --ok:        #34d399;
    --ok-dim:    rgba(52,211,153,.12);
    --err:       #f87171;
    --err-dim:   rgba(248,113,113,.12);
    --warn:      #fbbf24;
    --warn-dim:  rgba(251,191,36,.12);
    --accent:    #60a5fa;
    --accent-dim:rgba(96,165,250,.12);
    --purple:    #c084fc;
    --purple-dim:rgba(192,132,252,.12);
    --radius:    10px;
    --radius-sm: 6px;
    --shadow:    0 1px 3px rgba(0,0,0,.4), 0 4px 16px rgba(0,0,0,.25);
  }
  /* ── Reset ──────────────────────────────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  /* ── Scrollbar ──────────────────────────────────────────────────── */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-hi); border-radius: 99px; }

  /* ── Typography ─────────────────────────────────────────────────── */
  h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: -.01em; color: var(--text); }
  h2 {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: .1em;
    font-weight: 600;
    color: var(--muted);
    margin: 0 0 12px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  h2 .sub { font-size: 10px; text-transform: none; letter-spacing: 0; color: var(--muted); font-weight: 400; }
  p { margin: 0 0 8px; }

  /* ── Header ─────────────────────────────────────────────────────── */
  header {
    padding: 0 20px;
    height: 52px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--surface);
    position: sticky;
    top: 0;
    z-index: 5;
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .logo-icon {
    width: 28px; height: 28px;
    background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
    border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
    box-shadow: 0 0 0 1px rgba(99,102,241,.4), 0 2px 8px rgba(59,130,246,.3);
  }
  .logo-text { display: flex; flex-direction: column; gap: 0; }
  .logo-title { font-size: 13px; font-weight: 600; color: var(--text); letter-spacing: -.01em; }
  .logo-sub { font-size: 10px; color: var(--muted); font-weight: 400; }
  header .sep { width: 1px; height: 20px; background: var(--border); margin: 0 2px; }
  header .spacer { flex: 1; }

  /* ── Badges / Pills ─────────────────────────────────────────────── */
  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px; font-weight: 500;
    padding: 2px 8px;
    border-radius: 99px;
    border: 1px solid var(--border-hi);
    color: var(--muted);
    background: var(--panel);
    white-space: nowrap;
    transition: color .15s, border-color .15s, background .15s;
  }
  .badge::before { content: ''; display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .7; }
  .badge.ok  { color: var(--ok);     border-color: rgba(52,211,153,.3);  background: var(--ok-dim);   }
  .badge.off { color: var(--err);    border-color: rgba(248,113,113,.3); background: var(--err-dim);  }
  .badge.role { color: var(--accent); border-color: rgba(96,165,250,.3); background: var(--accent-dim); }
  .badge.role::before { display: none; }

  /* ── Layout ─────────────────────────────────────────────────────── */
  main {
    padding: 20px;
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: 20px;
    align-items: start;
    max-width: 1600px;
  }
  @media (max-width: 960px) { main { grid-template-columns: 1fr; } }

  /* ── Panel / Card ───────────────────────────────────────────────── */
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    margin-bottom: 16px;
    box-shadow: var(--shadow);
    transition: border-color .2s;
  }
  .panel:hover { border-color: var(--border-hi); }

  /* ── Stat cards ─────────────────────────────────────────────────── */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .stat {
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    transition: border-color .2s, background .2s;
  }
  .stat:hover { border-color: var(--border-hi); background: var(--panel); }
  .stat-val {
    font-size: 22px;
    font-weight: 700;
    line-height: 1.1;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    letter-spacing: -.02em;
  }
  .stat-val.has-warn { color: var(--warn); }
  .stat-val.has-err  { color: var(--err);  }
  .stat-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: .07em;
    color: var(--muted);
    margin-top: 2px;
    font-weight: 500;
  }

  /* ── Tables ─────────────────────────────────────────────────────── */
  .tbl-wrap { overflow-x: auto; margin: 0 -2px; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left;
    padding: 6px 10px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: .07em;
    color: var(--muted);
    font-weight: 600;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td {
    text-align: left;
    padding: 8px 10px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
    color: var(--text);
  }
  td.dim { color: var(--text-dim); }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr.clickable { cursor: pointer; transition: background .12s; }
  tbody tr.clickable:hover { background: rgba(96,165,250,.05); }
  tbody tr.clickable:hover td { color: var(--text); }
  .empty-row td { color: var(--muted); font-style: italic; padding: 14px 10px; }

  /* ── Status pills ───────────────────────────────────────────────── */
  .pill {
    display: inline-flex; align-items: center;
    font-size: 10px; font-weight: 600;
    padding: 2px 7px;
    border-radius: 99px;
    letter-spacing: .04em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .pill.ROUTED, .pill.MAPPED  { color: var(--ok);     background: var(--ok-dim);     }
  .pill.FAILED                { color: var(--err);    background: var(--err-dim);    }
  .pill.HELD                  { color: var(--purple); background: var(--purple-dim); }
  .pill.RECEIVED, .pill.PARSED, .pill.VALIDATED,
  .pill.QUEUED, .pill.DELIVERING { color: var(--warn); background: var(--warn-dim); }
  .pill.DUPLICATE, .pill.DISCARDED { color: var(--muted); background: rgba(107,116,138,.12); }
  .pill.admitted              { color: var(--ok);     background: var(--ok-dim);    }
  .pill.discharged            { color: var(--muted);  background: rgba(107,116,138,.12); }

  /* keep .status for backward compat with JS (detail panel inline HTML) */
  .status { font-weight: 600; }
  .status.ROUTED, .status.MAPPED { color: var(--ok); }
  .status.FAILED  { color: var(--err); }
  .status.HELD    { color: var(--purple); }
  .status.RECEIVED, .status.PARSED, .status.VALIDATED,
  .status.QUEUED, .status.DELIVERING { color: var(--warn); }
  .status.DUPLICATE, .status.DISCARDED { color: var(--muted); }

  .match { font-size: 11px; color: var(--muted); }
  .match.MATCHED   { color: var(--ok); }
  .match.AMBIGUOUS, .match.UNMATCHED, .match.REJECTED { color: var(--purple); }

  .prof-status.certified { color: var(--ok); font-weight: 600; }
  .prof-status.draft     { color: var(--warn); font-weight: 600; }

  .conf.ok   { color: var(--ok); }
  .conf.bad  { color: var(--err); }
  .conf.none { color: var(--muted); }

  .alert.FIRING   { color: var(--err); font-weight: 600; }
  .alert.RESOLVED { color: var(--ok); }

  .kstatus.ok      { color: var(--ok); }
  .kstatus.off     { color: var(--muted); }
  .kstatus.warn    { color: var(--warn); }
  .kstatus.expired { color: var(--err); }

  .col-id {
    color: var(--accent);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    opacity: .8;
  }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

  /* ── Code / pre ─────────────────────────────────────────────────── */
  pre {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    overflow: auto;
    max-height: 300px;
    font-size: 11.5px;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--text-dim);
    line-height: 1.6;
  }

  /* ── Buttons ────────────────────────────────────────────────────── */
  button {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-sm);
    padding: 6px 13px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    transition: opacity .15s, transform .1s;
    white-space: nowrap;
  }
  button:hover  { opacity: .88; }
  button:active { transform: scale(.97); }
  button.ghost {
    background: transparent;
    color: var(--text-dim);
    border: 1px solid var(--border-hi);
  }
  button.ghost:hover { color: var(--text); border-color: var(--accent); background: var(--accent-dim); }
  button.danger {
    background: transparent;
    color: var(--err);
    border: 1px solid rgba(248,113,113,.35);
  }
  button.danger:hover { background: var(--err-dim); }

  /* ── Inputs / selects ───────────────────────────────────────────── */
  input, select, textarea {
    background: var(--bg);
    border: 1px solid var(--border-hi);
    color: var(--text);
    border-radius: var(--radius-sm);
    padding: 7px 10px;
    font-family: inherit;
    font-size: 12px;
    transition: border-color .15s, box-shadow .15s;
    outline: none;
  }
  input:focus, select:focus, textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(96,165,250,.18);
  }
  input::placeholder { color: var(--muted); }
  select option { background: var(--panel); }

  /* ── Overlay / modal ────────────────────────────────────────────── */
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,.7);
    backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    z-index: 50;
    animation: fadeIn .15s ease;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .modal {
    background: var(--panel);
    border: 1px solid var(--border-hi);
    border-radius: 14px;
    padding: 24px;
    max-width: 440px;
    width: calc(100% - 32px);
    box-shadow: 0 8px 40px rgba(0,0,0,.5);
    animation: slideUp .18s ease;
  }
  @keyframes slideUp { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  .modal h2 { font-size: 14px; text-transform: none; letter-spacing: 0; color: var(--text); font-weight: 600; margin-bottom: 8px; }
  .modal p  { color: var(--text-dim); font-size: 12.5px; line-height: 1.6; margin-bottom: 14px; }
  .modal-actions { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }

  /* ── Timeline ───────────────────────────────────────────────────── */
  ul.timeline { list-style: none; padding: 0; margin: 0; }
  ul.timeline li {
    padding: 5px 0 5px 16px;
    color: var(--text-dim);
    font-size: 12px;
    position: relative;
    border-left: 2px solid var(--border-hi);
  }
  ul.timeline li::before {
    content: '';
    position: absolute;
    left: -5px; top: 10px;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--border-hi);
    border: 2px solid var(--panel);
  }
  ul.timeline li:last-child { border-left-color: transparent; }
  ul.timeline li b { color: var(--text); font-weight: 600; }

  /* ── 2-col grid ─────────────────────────────────────────────────── */
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
  @media (max-width: 700px) { .grid2 { grid-template-columns: 1fr; } }

  /* ── Section labels ─────────────────────────────────────────────── */
  .section-sub {
    font-size: 10px;
    color: var(--muted);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  /* ── Misc helpers ───────────────────────────────────────────────── */
  .muted  { color: var(--muted); }
  .err    { color: var(--err);   }
  .ok     { color: var(--ok);    }
  .warn   { color: var(--warn);  }
  .detail { margin-top: 12px; display: none; }
  .detail.open { display: block; }

  /* ── Device ID / name sub-text ──────────────────────────────────── */
  .dev-name { font-weight: 500; }
  .dev-id { font-size: 11px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

  /* ── Profile-add textarea ───────────────────────────────────────── */
  #profile-json { width: 100%; resize: vertical; min-height: 100px; }

  /* ── Key-add row ────────────────────────────────────────────────── */
  .key-add-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
  .key-add-row label { display: flex; flex-direction: column; gap: 4px; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; }

  /* ── Action button row ──────────────────────────────────────────── */
  .btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }

  /* ── Detail panel header ────────────────────────────────────────── */
  .detail-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .detail-meta { color: var(--text-dim); font-size: 12px; }

  /* ── Drift warning ──────────────────────────────────────────────── */
  .drift-warn {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--err-dim); color: var(--err);
    border: 1px solid rgba(248,113,113,.25);
    border-radius: var(--radius-sm);
    padding: 3px 8px;
    font-size: 11px; font-weight: 500;
  }

  /* ── Pulse dot for live refresh ─────────────────────────────────── */
  .live-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--ok);
    animation: pulse 2s ease-in-out infinite;
    margin-right: 2px;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: .4; transform: scale(.8); }
  }

  /* ── Alert count badge ──────────────────────────────────────────── */
  .alert-count {
    display: inline-flex; align-items: center;
    background: var(--err-dim); color: var(--err);
    border: 1px solid rgba(248,113,113,.25);
    border-radius: 99px; padding: 1px 7px;
    font-size: 10px; font-weight: 600;
    margin-left: 4px;
  }
  .alert-count.none { background: var(--panel-alt); color: var(--muted); border-color: var(--border); }

  /* ── Radiology console blocks (M3.4) ─────────────────────────────── */
  .rad-block h3 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); margin: 0 0 8px; font-weight: 600;
  }
  .rad-block + .rad-block {
    margin-top: 16px; padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .rad-block .section-sub { color: var(--text-dim); font-size: 11px; }
  .rad-block .has-err { color: var(--err); }
  /* Narrow left column: keep rows single-line (the panel scrolls
     horizontally like the other tables); long study descriptions get an
     ellipsis clamp with the full text in the title tooltip. */
  .rad-block td { white-space: nowrap; }
  .rad-block td.ellipsis {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
</head>
<body>

<!-- ── Header ──────────────────────────────────────────────────────── -->
<header>
  <div class="logo">
    <div class="logo-icon">⬡</div>
    <div class="logo-text">
      <span class="logo-title">Integration Hub</span>
      <span class="logo-sub">management console</span>
    </div>
  </div>
  <div class="sep"></div>
  <span class="badge" id="health">connecting…</span>
  <span class="badge" id="version" style="display:none"></span>
  <span class="badge role" id="role" style="display:none"></span>
  <div class="spacer"></div>
  <span class="live-dot" title="Auto-refreshing every 3 s"></span>
  <button class="ghost" id="keybtn" style="display:none" onclick="showSignIn()">🔑 API key</button>
</header>

<!-- ── Sign-in overlay ──────────────────────────────────────────────── -->
<div class="overlay" id="overlay" style="display:none">
  <div class="modal">
    <h2>🔐 Sign in</h2>
    <p>The hub API requires an API key (PRD §34). Roles: <strong>admin</strong> / <strong>engineer</strong> / <strong>operator</strong> / <strong>viewer</strong>.<br/>
    Paste a key below — ask an administrator, or copy the admin key printed at hub start (or set <code style="color:var(--accent)">HUB_ADMIN_KEY</code>).</p>
    <input id="key-input" type="password" placeholder="ihk_…" style="width:100%;margin-bottom:12px" autocomplete="off"/>
    <div class="modal-actions">
      <button onclick="applyKey()">Sign in</button>
      <button class="ghost" onclick="dismissSignIn()">Cancel</button>
    </div>
  </div>
</div>

<!-- ── Main layout ───────────────────────────────────────────────────── -->
<main>
  <!-- Left column -->
  <section>

    <!-- Dashboard stats -->
    <div class="panel">
      <h2>Dashboard</h2>
      <div class="stats" id="stats"></div>
    </div>

    <!-- Devices -->
    <div class="panel">
      <h2>Devices</h2>
      <div class="tbl-wrap">
        <table id="devices">
          <thead><tr><th>Device</th><th>State</th><th>Last seen</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <!-- Device profiles -->
    <div class="panel">
      <h2>Device profiles <span class="sub">certified config = adapter (A4)</span></h2>
      <div class="tbl-wrap">
        <table id="profiles">
          <thead><tr><th>Profile</th><th>Status</th><th>Ver</th><th>Conformance</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div id="profile-add" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
        <h2 style="margin-bottom:8px;font-size:11px;text-transform:none;letter-spacing:0;color:var(--text-dim)">Add / replace profile — paste profile JSON</h2>
        <textarea id="profile-json" rows="5" placeholder='{"id":"my-device","name":"…","manufacturer":"…","model":"…","protocol":"ASTM","transport":"tcp","version":1,"layout":{},"mappings":{},"status":"draft"}'></textarea>
        <div class="btn-row" style="margin-top:8px">
          <button onclick="addProfile()">Save profile</button>
          <span class="muted" id="profile-add-result" style="font-size:12px;align-self:center"></span>
        </div>
      </div>
    </div>

    <!-- Admissions -->
    <div class="panel">
      <h2>Admissions <span class="sub">ADT^A01 patient feed (B2c)</span></h2>
      <div class="tbl-wrap">
        <table id="admissions">
          <thead><tr><th>Patient</th><th>Status</th><th>Visit</th><th>Received</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <!-- Alerts -->
    <div class="panel">
      <h2>Alerts <span id="alert-count" class="alert-count none">0</span></h2>
      <div class="tbl-wrap">
        <table id="alerts">
          <thead><tr><th>Kind</th><th>State</th><th>Message</th><th>Fired</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <!-- D3 webhooks (PRD §37): subscriptions + signed delivery log. Reads are
         api:read (any signed-in role); add/delete/test/replay are config:write
         (engineer and up) — the action buttons hide below that. -->
    <div class="panel">
      <h2>Webhooks <span class="sub">signed event deliveries · D3 event bus</span></h2>
      <div id="webhook-result" style="white-space:pre-wrap;font-size:12px;margin-bottom:8px;padding:8px;border-radius:var(--radius-sm);background:var(--bg);display:none"></div>
      <div class="tbl-wrap">
        <table id="webhooks">
          <thead><tr><th>Name</th><th>URL</th><th>Events</th><th>State</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div id="webhook-add" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
        <h2 style="margin-bottom:8px;font-size:11px;text-transform:none;letter-spacing:0;color:var(--text-dim)">Add subscription — the hub signs every POST with the HMAC secret</h2>
        <div class="key-add-row" style="flex-wrap:wrap">
          <label>Name <input id="wh-name" placeholder="e.g. LIS results receiver" style="width:160px"/></label>
          <label>URL <input id="wh-url" placeholder="https://receiver.example/hook" style="width:220px"/></label>
          <label>Events <input id="wh-events" placeholder="*  or  result.received, order.received" style="width:220px"/></label>
          <label>Secret <input id="wh-secret" placeholder="blank = auto-generate (shown once)" style="width:200px"/></label>
          <label style="align-items:center"><input id="wh-enabled" type="checkbox" checked/> enabled</label>
          <button onclick="addWebhook()">Add subscription</button>
          <button class="ghost" onclick="testWebhook()">Send test ping</button>
        </div>
      </div>
      <div class="tbl-wrap" style="margin-top:14px">
        <table id="webhook-deliveries">
          <thead><tr><th>Event</th><th>Subscription</th><th>Status</th><th>Attempts</th><th>When</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <!-- Software updates (shown when configured) -->
    <div class="panel" id="updates-panel" style="display:none">
      <h2>Software updates</h2>
      <p id="upd-running" class="muted" style="font-size:12px"></p>
      <p id="upd-note"    class="muted" style="font-size:12px"></p>
      <div class="tbl-wrap">
        <table id="upd-history">
          <thead><tr><th>When</th><th>Event</th><th>Version</th><th>Detail</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div id="upd-actions" style="display:none" class="btn-row">
        <button onclick="updCheck()">Check</button>
        <button class="ghost" onclick="updApply()">Apply available</button>
        <button class="ghost" onclick="updRollback()">Roll back</button>
      </div>
      <p class="muted" id="upd-result" style="margin:8px 0 0;font-size:12px"></p>
    </div>

    <!-- Access keys (admin only) -->
    <div class="panel" id="keys-panel" style="display:none">
      <h2>Access keys <span class="sub">rotation · rename · disable · expiry · re-issue</span></h2>
      <div id="keys-result" style="white-space:pre-wrap;font-size:12px;margin-bottom:8px;padding:8px;border-radius:var(--radius-sm);background:var(--bg);display:none"></div>
      <div class="tbl-wrap">
        <table id="keys">
          <thead><tr><th>Key</th><th>Role</th><th>Status</th><th>Expires</th><th>Last used</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="key-add-row" id="keys-add">
        <label>Name <input id="key-name" placeholder="e.g. LIS interface v2" style="width:180px"/></label>
        <label>Role
          <select id="key-role">
            <option value="viewer">viewer</option>
            <option value="operator">operator</option>
            <option value="engineer">engineer</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label>Expires (days) <input id="key-expiry" type="number" min="1" placeholder="blank = never" style="width:150px"/></label>
        <button onclick="createKey()">Create key</button>
      </div>
    </div>

  </section>

  <!-- Right column -->
  <section>

    <!-- Radiology console (M3.4 — shown when Orthanc is configured; wide
         tables live in the right column next to the detail route) -->
    <div class="panel" id="radiology-panel" style="display:none">
      <h2>Radiology <span class="sub">MWL worklist + performed-study routing (M3.2–M3.4)</span></h2>

      <!-- MWL worklist: what modalities will C-FIND + the sync health -->
      <div class="rad-block" id="rad-mwl-block" style="display:none">
        <h3>Orthanc worklist <span class="section-sub" id="mwl-summary"></span></h3>
        <div id="mwl-status" class="muted" style="font-size:12px;margin-bottom:8px"></div>
        <div class="tbl-wrap">
          <table id="mwl">
            <thead><tr><th>Accession</th><th>Patient</th><th>Modality</th><th>Scheduled</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>

      <!-- Imaging studies: performed-study events + how they routed -->
      <div class="rad-block" id="rad-imaging-block" style="display:none">
        <h3>Imaging studies <span class="section-sub" id="imaging-summary"></span></h3>
        <div class="tbl-wrap">
          <table id="imaging">
            <thead><tr><th>Accession</th><th>Status</th><th>Performed</th><th>Study</th><th>Routing</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Messages -->
    <div class="panel">
      <h2>Messages <span class="muted section-sub" id="msg-count"></span></h2>
      <div class="tbl-wrap">
        <table id="messages">
          <thead><tr><th>Time</th><th>Device</th><th>Status</th><th>Results</th><th>ID</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <!-- Message detail (shown when a row is selected) -->
    <div class="panel" id="detail" style="display:none"></div>

  </section>
</main>

<script>
/* ── Utilities ─────────────────────────────────────────────────────── */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let selectedId   = null;
let confCache    = {};
let meId         = null;
let hubKey       = localStorage.getItem('hub.key') || '';
let meRole       = null;
let signInVisible= false;

/* ── API helper ────────────────────────────────────────────────────── */
function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  if (hubKey) headers['Authorization'] = 'Bearer ' + hubKey;
  return fetch(path, Object.assign({}, opts, { headers })).then((res) => {
    if (res.status === 401) {
      localStorage.removeItem('hub.key');
      hubKey = '';
      if (!sessionStorage.getItem('hub.dismissed')) showSignIn();
      throw new Error('unauthorized');
    }
    return res;
  });
}

/* ── Auth overlay ──────────────────────────────────────────────────── */
function showSignIn() {
  if (signInVisible) return;
  signInVisible = true;
  const input = document.getElementById('key-input');
  input.value = hubKey;
  document.getElementById('overlay').style.display = 'flex';
  setTimeout(() => input.focus(), 80);
}
function hideSignIn() {
  signInVisible = false;
  document.getElementById('overlay').style.display = 'none';
}
async function applyKey() {
  const value = document.getElementById('key-input').value.trim();
  if (!value) return;
  sessionStorage.removeItem('hub.dismissed');
  hubKey = value;
  localStorage.setItem('hub.key', value);
  hideSignIn();
  await updateRole();
  refresh();
}
function dismissSignIn() {
  sessionStorage.setItem('hub.dismissed', '1');
  hideSignIn();
}

/* ── Role / identity ───────────────────────────────────────────────── */
async function updateRole() {
  const roleEl = document.getElementById('role');
  roleEl.style.display = 'none';
  if (!hubKey) return;
  try {
    const me = await api('/api/v1/me').then(r => r.json());
    meRole = me.role; meId = me.id;
    roleEl.textContent = me.role + ' · ' + me.name;
    roleEl.style.display = 'inline-flex';
  } catch { meRole = null; }
}
function canAct()        { return ['admin','engineer','operator'].indexOf(meRole) !== -1; }
function manageProfiles(){ return meRole === 'admin' || meRole === 'engineer'; }

/* ── Full refresh ──────────────────────────────────────────────────── */
async function refresh() {
  try {
  const keysReq = meRole === 'admin'
    ? api('/api/v1/keys').then(r => r.json())
    : Promise.resolve(null);
  // M3.4 radiology views: both endpoints 404 without Orthanc — the panels
  // stay hidden unless the hub is wired (the monitor is running).
  const imagingReq = api('/api/v1/imaging').then(async r => ({ on: r.ok, body: r.ok ? await r.json() : null }));
  const mwlReq     = api('/api/v1/mwl').then(async r => ({ on: r.ok, body: r.ok ? await r.json() : null }));
  // D3 webhook event bus: subscription + delivery views (api:read — any role).
  const webhooksReq   = api('/api/v1/webhooks').then(async r => r.ok ? r.json() : []);
  const deliveriesReq = api('/api/v1/webhooks/deliveries?limit=50').then(async r => r.ok ? r.json() : []);
  const [health, stats, devices, admissions, alerts, messages, profiles, keys, imagingView, mwlView, webhookSubs, webhookDeliveries] = await Promise.all([
    api('/api/v1/health').then(r => r.json()),
    api('/api/v1/stats').then(r => r.json()),
    api('/api/v1/devices').then(r => r.json()),
    api('/api/v1/admissions').then(r => r.json()),
    api('/api/v1/alerts?firing=true&limit=50').then(r => r.json()),
    api('/api/v1/messages?limit=100').then(r => r.json()),
    api('/api/v1/profiles').then(r => r.json()),
    keysReq,
    imagingReq,
    mwlReq,
    webhooksReq,
    deliveriesReq,
  ]);
    const h = document.getElementById('health');
    h.textContent = health.status === 'ok' ? 'online' : 'degraded';
    h.className   = 'badge ' + (health.status === 'ok' ? 'ok' : 'off');
    const vEl = document.getElementById('version');
    if (health.version) { vEl.textContent = 'v' + health.version; vEl.style.display = 'inline-flex'; }
    renderStats(stats);
    renderDevices(devices);
    renderAdmissions(admissions);
    renderAlerts(alerts);
    renderMessages(messages);
    renderProfiles(profiles);
    renderKeys(keys);
    renderRadiology(mwlView, imagingView);
    renderWebhooks(webhookSubs, webhookDeliveries);
    if (selectedId) renderDetail(selectedId);
    renderUpdates();
  } catch {
    const h = document.getElementById('health');
    h.textContent = 'offline';
    h.className   = 'badge off';
  }
}

/* ── Stats ─────────────────────────────────────────────────────────── */
function renderStats(s) {
  const held  = (s.byStatus && s.byStatus.HELD)   || 0;
  const dlq   = (s.byStatus && s.byStatus.FAILED) || 0;
  const defs  = [
    { label:'Messages', val: s.total,   cls: '' },
    { label:'Today',    val: s.today,   cls: '' },
    { label:'Failed',   val: s.failed,  cls: s.failed  > 0 ? 'has-err'  : '' },
    { label:'Pending',  val: s.pending, cls: s.pending > 0 ? 'has-warn' : '' },
    { label:'Held',     val: held,      cls: held      > 0 ? 'has-warn' : '' },
    { label:'DLQ',      val: dlq,       cls: dlq       > 0 ? 'has-err'  : '' },
  ];
  document.getElementById('stats').innerHTML = defs.map(d =>
    '<div class="stat"><div class="stat-val ' + d.cls + '">' + (d.val ?? 0) + '</div><div class="stat-label">' + d.label + '</div></div>'
  ).join('');
}

/* ── Devices ───────────────────────────────────────────────────────── */
function renderDevices(devices) {
  document.getElementById('devices').querySelector('tbody').innerHTML =
    devices.map(d =>
      '<tr>' +
      '<td><span class="dev-name">' + esc(d.name) + '</span><br/><span class="dev-id">' + esc(d.id) + '</span>' +
      ((d.protocol && d.protocol !== 'ASTM') || (d.transport && d.transport !== 'tcp')
        ? '<br/><span class="dev-id">' + esc(d.protocol ?? '—') + ' · ' + esc(d.transport ?? '—') + '</span>' : '') +
      (d.profileId ? '<br/><span class="badge role" style="margin-top:3px;font-size:10px">profile:' + esc(d.profileId) + '</span>' : '') + '</td>' +
      '<td><span class="pill ' + esc(d.state) + '">' + esc(d.state) + '</span></td>' +
      '<td class="dim mono">' + (d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : '—') + '</td></tr>'
    ).join('') || '<tr class="empty-row"><td colspan="3">No devices yet — start the simulator.</td></tr>';
}

/* ── Admissions ────────────────────────────────────────────────────── */
function renderAdmissions(admissions) {
  document.getElementById('admissions').querySelector('tbody').innerHTML =
    admissions.map(a =>
      '<tr>' +
      '<td><span class="dev-name">' + esc(a.patientId) + '</span>' +
      (a.name ? '<br/><span class="muted">' + esc(a.name) + '</span>' : '') + '</td>' +
      '<td><span class="pill ' + esc(a.status) + '">' + esc(a.status) + '</span></td>' +
      '<td class="dim">' + esc(a.visitId ?? '—') + '</td>' +
      '<td class="dim mono">' + (a.receivedAt ? new Date(a.receivedAt).toLocaleTimeString() : '—') + '</td></tr>'
    ).join('') || '<tr class="empty-row"><td colspan="4">No patient admissions yet — send an ADT^A01 over MLLP.</td></tr>';
}

/* ── Alerts ────────────────────────────────────────────────────────── */
function renderAlerts(alerts) {
  const countEl = document.getElementById('alert-count');
  countEl.textContent = alerts.length;
  countEl.className = 'alert-count' + (alerts.length > 0 ? '' : ' none');
  document.getElementById('alerts').querySelector('tbody').innerHTML =
    alerts.map(a =>
      '<tr>' +
      '<td>' + esc(a.kind) + '</td>' +
      '<td><span class="alert ' + esc(a.status) + '">' + esc(a.status) + '</span></td>' +
      '<td>' + esc(a.message) + '</td>' +
      '<td class="dim mono">' + new Date(a.firedAt).toLocaleTimeString() + '</td></tr>'
    ).join('') || '<tr class="empty-row"><td colspan="4">No firing alerts.</td></tr>';
}

/* ── Webhooks (D3 event bus) ──────────────────────────────────────── */
function showWebhookResult(msg, isErr) {
  const el = document.getElementById('webhook-result');
  el.style.display = 'block';
  el.textContent = msg;
  el.className = isErr ? 'err' : 'ok';
}

function renderWebhooks(subs, deliveries) {
  const manage = manageProfiles(); // config:write = admin/engineer
  const addRow = document.getElementById('webhook-add');
  addRow.style.display = manage ? 'flex' : 'none';
  addRow.style.flexDirection = 'column';
  document.getElementById('webhooks').querySelector('tbody').innerHTML =
    subs.map(s => {
      const eventsHtml = s.events === '*'
        ? '<span class="pill ok" style="font-size:10px;padding:1px 6px">* all events</span>'
        : (s.events || []).map(e => '<span class="pill" style="font-size:10px;padding:1px 6px">' + esc(e) + '</span>').join(' ');
      const btns = manage ? [
        '<button class="ghost" style="font-size:11px;padding:3px 8px" onclick="toggleWebhook(\\'' + esc(s.id) + '\\',' + s.enabled + ')">' + (s.enabled ? 'Disable' : 'Enable') + '</button>',
        '<button class="danger" style="font-size:11px;padding:3px 8px" onclick="deleteWebhook(\\'' + esc(s.id) + '\\')">Delete</button>',
      ].join(' ') : '';
      return '<tr>' +
        '<td><span class="dev-name">' + esc(s.name) + '</span><br/><span class="dev-id">' + esc(s.id) + '</span></td>' +
        '<td class="dim ellipsis" style="max-width:260px" title="' + esc(s.url) + '">' + esc(s.url) + '</td>' +
        '<td>' + eventsHtml + '</td>' +
        '<td><span class="pill ' + (s.enabled ? 'connected' : 'disconnected') + '">' + (s.enabled ? 'enabled' : 'disabled') + '</span></td>' +
        '<td style="white-space:nowrap">' + btns + '</td></tr>';
    }).join('') || '<tr class="empty-row"><td colspan="5">No webhook subscriptions yet — add one to receive signed result/order/device events.</td></tr>';

  const names = {};
  (subs || []).forEach(s => { names[s.id] = s.name; });
  document.getElementById('webhook-deliveries').querySelector('tbody').innerHTML =
    (deliveries || []).map(d => {
      const attempts = (d.attempts || []).length;
      const last = (d.attempts || []).slice(-1)[0];
      const err = d.lastError ? ' · ' + esc(d.lastError) : '';
      const replay = manage && !d.ok
        ? '<button class="ghost" style="font-size:11px;padding:3px 8px" onclick="replayWebhook(\\'' + esc(d.eventId) + '\\')" title="Re-send the same signed delivery">↩ Replay</button>' : '';
      return '<tr>' +
        '<td class="mono">' + esc(d.eventId.slice(0, 8)) + '…</td>' +
        '<td>' + esc(names[d.subscriptionId] || d.subscriptionId) + '</td>' +
        '<td><span class="pill ' + (d.ok ? 'connected' : 'disconnected') + '">' + (d.ok ? 'delivered' : 'failed') + '</span></td>' +
        '<td class="dim">' + attempts + (err ? ' — <span title="' + err + '" class="has-err">' + esc((d.lastError || '').slice(0, 40)) + '</span>' : '') + '</td>' +
        '<td class="dim mono">' + (d.deliveredAt ? new Date(d.deliveredAt).toLocaleTimeString() : (last ? new Date(last.at).toLocaleTimeString() : '—')) + '</td>' +
        '<td style="white-space:nowrap">' + replay + '</td></tr>';
    }).join('') || '<tr class="empty-row"><td colspan="6">No webhook deliveries yet — events fire as results/orders/devices flow through the hub.</td></tr>';
}

async function addWebhook() {
  const name = document.getElementById('wh-name').value.trim();
  const url  = document.getElementById('wh-url').value.trim();
  if (!name || !url) { showWebhookResult('name and URL are required', true); return; }
  const rawEvents = document.getElementById('wh-events').value.trim();
  const events = !rawEvents || rawEvents === '*'
    ? '*'
    : rawEvents.split(',').map(e => e.trim()).filter(Boolean);
  const secret = document.getElementById('wh-secret').value.trim() || undefined;
  const enabled = document.getElementById('wh-enabled').checked;
  const res = await api('/api/v1/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url, events, secret, enabled }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { showWebhookResult('create failed: ' + (body.error || res.status), true); return; }
  const holder = document.getElementById('webhook-result');
  holder.style.display = 'block';
  holder.className = '';
  holder.innerHTML =
    '<span style="color:var(--ok);font-size:12px">✓ Created ' + esc(body.id) + '. HMAC secret shown once — copy it now:</span><br/>' +
    '<input readonly value="' + esc(body.secret) + '" style="width:100%;margin:6px 0;font-family:ui-monospace,Menlo,monospace" onfocus="this.select()"/>';
  document.getElementById('wh-name').value = '';
  document.getElementById('wh-url').value = '';
  document.getElementById('wh-secret').value = '';
  await refresh();
}

async function toggleWebhook(id, enabled) {
  const res = await api('/api/v1/webhooks/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !enabled }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { showWebhookResult('toggle failed: ' + (body.error || res.status), true); return; }
  showWebhookResult('✓ ' + id + ' ' + (body.enabled ? 'enabled' : 'disabled'), false);
  await refresh();
}

async function deleteWebhook(id) {
  if (!confirm('Delete webhook subscription ' + id + '? Deliveries to it stop immediately.')) return;
  const res = await api('/api/v1/webhooks/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) { showWebhookResult('delete failed: ' + res.status, true); return; }
  showWebhookResult('✓ deleted ' + id, false);
  await refresh();
}

async function testWebhook() {
  // Pings every enabled subscription matching the event type (a wiring
  // check — the signed POST lands in the delivery log below).
  const res = await api('/api/v1/webhooks/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { showWebhookResult('test ping failed: ' + (out.error || res.status), true); return; }
  showWebhookResult('✓ test ping fired — event ' + out.id + ', delivered to ' + out.matched + ' subscription(s)' + (out.note ? ' (' + out.note + ')' : ''), out.matched === 0);
  await refresh();
}

async function replayWebhook(eventId) {
  const res = await api('/api/v1/webhooks/deliveries/' + encodeURIComponent(eventId) + '/replay', { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { showWebhookResult('replay failed: ' + (body.error || res.status), true); return; }
  showWebhookResult('✓ re-sent to ' + body.attempted + ' subscription(s)', false);
  await refresh();
}

/* ── Radiology console (M3.4) ─────────────────────────────────────── */
function renderRadiology(mwlView, imagingView) {
  renderMwl(mwlView);
  renderImaging(imagingView);
  const panel = document.getElementById('radiology-panel');
  panel.style.display = (mwlView && mwlView.on) || (imagingView && imagingView.on) ? 'block' : 'none';
}

function renderMwl(view) {
  const block = document.getElementById('rad-mwl-block');
  if (!view || !view.on) { block.style.display = 'none'; return; }
  block.style.display = 'block';
  const st = view.body.status || {};
  const totals = st.totals || {};
  const parts = [];
  if (totals.created) parts.push('created ' + totals.created);
  if (totals.queued)  parts.push('queued ' + totals.queued);
  if (totals.failed)  parts.push('failed ' + totals.failed);
  if (st.performed && st.performed.length) parts.push('performed ' + st.performed.length);
  const summary = document.getElementById('mwl-summary');
  summary.innerHTML = parts.length ? '<b>' + parts.join(' · ') + '</b>' : '';
  summary.className = 'section-sub' + (st.lastError ? ' has-err' : '');
  let status = 'poll every ' + (st.pollMs / 1000) + 's' + (st.lastRunAt ? ' · last ' + new Date(st.lastRunAt).toLocaleTimeString() : '');
  const statusEl = document.getElementById('mwl-status');
  statusEl.innerHTML = status;
  statusEl.className = 'muted' + (st.lastError ? ' has-err' : '');
  if (st.lastError) statusEl.innerHTML += ' — <span class="has-err">⚠ poll failed: ' + esc(st.lastError) + '</span>';
  if (view.body.worklistError) statusEl.innerHTML += ' — <span class="has-err">⚠ worklist: ' + esc(view.body.worklistError) + '</span>';
  document.getElementById('mwl').querySelector('tbody').innerHTML =
    (view.body.worklist || []).map(w =>
      '<tr>' +
      '<td class="col-id mono">' + esc(w.accession || '—') + '</td>' +
      '<td>' + esc(w.patientName || (w.patientId ? w.patientId + ' (id)' : '—')) + '</td>' +
      '<td class="dim">' + esc(w.modality || '—') + '</td>' +
      '<td class="dim mono">' + esc(w.scheduledDate || '—') + '</td></tr>'
    ).join('') || '<tr class="empty-row"><td colspan="4">Worklist empty — the next poll pushes active orders here.</td></tr>';
}

function renderImaging(view) {
  const block = document.getElementById('rad-imaging-block');
  if (!view || !view.on) { block.style.display = 'none'; return; }
  block.style.display = 'block';
  const body = view.body;
  const byStatus = body.byStatus || {};
  const order = ['ROUTED', 'DUPLICATE', 'HELD', 'FAILED'];
  const chips = order.filter(k => byStatus[k] > 0)
    .map(k => '<span class="pill ' + k + '" style="font-size:10px;padding:1px 6px">' + k + ' ' + byStatus[k] + '</span>').join(' ');
  const summary = document.getElementById('imaging-summary');
  summary.innerHTML = '<b>' + (body.total || 0) + '</b> event(s)' + (chips ? ' — ' + chips : '');
  summary.className = 'section-sub';
  document.getElementById('imaging').querySelector('tbody').innerHTML =
    (body.messages || []).map(m => {
      const img = m.imaging || {};
      // Whole row opens the message-detail route (its study + routing view);
      // the FAILED retry button acts without navigating.
      const retry = canAct() && m.status === 'FAILED'
        ? '<button class="ghost" style="font-size:11px;padding:2px 8px" onclick="event.stopPropagation(); retryMessage(\\'' + m.id + '\\')" title="Requeue under the current route rules">↩ Retry</button>' : '';
      const action = m.status === 'FAILED' && canAct()
        ? retry
        : '<button class="ghost" style="font-size:11px;padding:2px 8px" onclick="event.stopPropagation(); openDetail(\\'' + m.id + '\\')">Routing ↪</button>';
      return '<tr class="clickable" onclick="openDetail(\\'' + m.id + '\\')" title="Open the full routing view">' +
        '<td class="col-id mono">' + esc(img.accession || '—') + '</td>' +
        '<td><span class="pill ' + esc(m.status) + '">' + esc(m.status) + '</span></td>' +
        '<td class="dim mono">' + (img.performedAt ? new Date(img.performedAt).toLocaleTimeString() : '—') + '</td>' +
        '<td class="dim ellipsis" title="' + esc((img.study && img.study.studyDescription) || (img.study && img.study.orthancId || '').slice(0, 12) || '—') + '">' + esc((img.study && img.study.studyDescription) || (img.study && img.study.orthancId || '').slice(0, 12) || '—') + '</td>' +
        '<td style="white-space:nowrap">' + action + '</td></tr>';
    }).join('') || '<tr class="empty-row"><td colspan="5">No imaging studies yet — perform a study and the monitor routes it here.</td></tr>';
}

/* ── Messages ──────────────────────────────────────────────────────── */
function renderMessages(messages) {
  document.getElementById('msg-count').textContent = '(' + messages.length + ' shown)';
  document.getElementById('messages').querySelector('tbody').innerHTML =
    messages.map(m =>
      '<tr class="clickable" onclick="openDetail(\\'' + m.id + '\\')">' +
      '<td class="dim mono">' + new Date(m.receivedAt).toLocaleTimeString() + '</td>' +
      '<td>' + esc(m.deviceId ?? '—') +
        (m.profile && m.profile.drift ? '<br/><span class="drift-warn">⚠ drift</span>' : '') + '</td>' +
      '<td><span class="pill ' + esc(m.status) + '">' + esc(m.status) + '</span>' +
        (m.match ? '<br/><span class="match ' + esc(m.match.status) + '" style="font-size:10px">' + esc(m.match.status) + '</span>' : '') + '</td>' +
      '<td class="dim">' + (m.imaging ? '📷 study' : (m.payload ? m.payload.results.length : 0)) + '</td>' +
      '<td class="col-id">' + esc(m.id.slice(0, 8)) + '</td></tr>'
    ).join('') || '<tr class="empty-row"><td colspan="5">No messages yet — start the simulator.</td></tr>';
}

/* ── Message detail ────────────────────────────────────────────────── */
async function openDetail(id) {
  selectedId = id;
  await renderDetail(id);
  // The detail panel lives in the messages section, which may be below the
  // fold when opening from the Radiology panel — surface it.
  const panel = document.getElementById('detail');
  if (panel) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function renderDetail(id) {
  const m = await api('/api/v1/messages/' + id).then(r => r.json());
  const panel = document.getElementById('detail');
  panel.style.display = 'block';

  const errors = m.errors && m.errors.length
    ? '<div style="background:var(--err-dim);border:1px solid rgba(248,113,113,.25);border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:12px;color:var(--err);font-size:12px">'
      + m.errors.map(esc).join('<br/>') + '</div>' : '';

  const records = (m.records || []).map(r =>
    '<tr><td class="dim mono">' + esc(r.type) + '</td><td style="font-size:11px;word-break:break-all">' + esc(r.fields.join(' | ')) + '</td></tr>').join('');

  const timeline = (m.timeline || []).map(t =>
    '<li><b>' + esc(t.stage) + '</b> <span class="dim mono">' + new Date(t.at).toLocaleTimeString() + '</span>' +
    (t.note ? ' <span class="muted">— ' + esc(t.note) + '</span>' : '') + '</li>').join('');

  const match = m.match
    ? '<div style="margin-bottom:10px;font-size:12px">' +
      '<span class="match ' + esc(m.match.status) + '" style="font-weight:600">' + esc(m.match.status) + '</span>' +
      (m.match.strategy ? ' <span class="muted">via ' + esc(m.match.strategy) + '</span>' : '') +
      (m.match.matchedOrderId ? ' → <span class="dim">order ' + esc(m.match.matchedOrderId) + '</span>' : '') +
      (m.match.reason ? ' <span class="muted">— ' + esc(m.match.reason) + '</span>' : '') + '</div>' : '';

  const profile = m.profile
    ? '<div style="margin-bottom:10px;font-size:12px">Parsed by <span class="badge role">' + esc(m.profile.id) + ' v' + esc(m.profile.version) + '</span> ' +
      (m.profile.certifiedVersion !== undefined && !m.profile.drift
        ? '<span class="conf ok">✓ matches certified v' + esc(m.profile.certifiedVersion) + '</span>'
        : '') +
      (m.profile.drift ? '<span class="drift-warn">⚠ drifted from certified v' + esc(m.profile.certifiedVersion) + ' — verify config</span>' : '') +
      '</div>' : '';

  const actions = canAct()
    ? '<div class="btn-row">' +
      (m.status === 'HELD' ? '<button onclick="releaseMessage(\\'' + m.id + '\\')">✅ Release</button>' : '') +
      (m.status === 'FAILED' ? '<button onclick="retryMessage(\\'' + m.id + '\\')">↩ Retry from DLQ</button>' : '') +
      (m.status !== 'FAILED' ? '<button class="ghost" onclick="replayMessage(\\'' + m.id + '\\')">↩ Replay</button>' : '') +
      '</div>'
    : '<span class="muted" style="font-size:12px">read-only — actions hidden</span>';

  // Key-value row inside a detail table (label column, wrapped value).
  const kv = (k, v) =>
    '<tr><td class="dim" style="width:150px;text-transform:uppercase;font-size:10px;letter-spacing:.06em;vertical-align:top;padding-top:9px">' + esc(k) + '</td><td style="word-break:break-word">' + v + '</td></tr>';

  const img = m.imaging;
  const isImaging = !!(img && img.kind === 'imaging');

  // Imaging (M3.4 radiology) messages are hub-originated study events — no
  // wire payload to parse, so the detail shows the study's canonical metadata
  // + its routing outcome instead of lab records/payload.
  let studyGrid = '';
  let eventJson = '';
  let timelineBlock = '<div><h2>Timeline</h2><ul class="timeline">' + timeline + '</ul></div>';
  if (isImaging) {
    const s = img.study || {};
    const patientName = s.patient && (s.patient.name || s.patient.patientId);
    const storage = s.storageUrl
      ? '<a href="' + esc(s.storageUrl) + '" target="_blank" rel="noopener" class="mono" style="font-size:11px;word-break:break-all">' + esc(s.storageUrl) + ' ↗</a>'
      : '<span class="muted">—</span>';
    const queued = (m.timeline || []).find((t) => t.stage === 'QUEUED');
    const dests = queued && queued.note && queued.note.includes('destination(s):')
      ? queued.note.split('destination(s):')[1].trim()
      : '—';
    studyGrid =
      '<div class="grid2" style="margin-top:14px">' +
        '<div><h2>Performed study</h2><div class="tbl-wrap"><table class="kv"><tbody>' +
          kv('Accession', '<span class="mono">' + esc(img.accession || '—') + '</span>') +
          kv('Description', esc(s.studyDescription || '—')) +
          kv('Study UID', '<span class="mono" style="word-break:break-all">' + esc(s.studyInstanceUid || s.orthancId || '—') + '</span>') +
          kv('Study date', esc(s.studyDate || '—')) +
          kv('Patient', esc(patientName || (s.patient && s.patient.patientId) || '—')) +
          kv('Performed at', new Date(img.performedAt).toLocaleString()) +
          kv('Storage', storage) +
        '</tbody></table></div></div>' +
        '<div><h2>Routing</h2><div class="tbl-wrap"><table class="kv"><tbody>' +
          kv('Status', '<span class="pill ' + esc(m.status) + '">' + esc(m.status) + '</span>') +
          kv('Device', esc(m.deviceId ?? '—')) +
          kv('Protocol', esc(m.protocol ?? '—') + ' · ' + esc(m.direction ?? '—')) +
          kv('Destination(s)', '<span class="mono" style="font-size:11px">' + esc(dests) + '</span>') +
          kv('Received', new Date(m.receivedAt).toLocaleString()) +
          kv('Message id', '<span class="mono" style="word-break:break-all">' + esc(m.id) + '</span>') +
        '</tbody></table></div></div>' +
      '</div>';
    eventJson =
      '<div><h2>Study event (imaging payload)</h2><pre>' + esc(JSON.stringify(img, null, 2)) + '</pre></div>';
    timelineBlock = '<div style="margin-top:14px"><h2>Routing timeline</h2><ul class="timeline">' + timeline + '</ul></div>';
  }

  panel.innerHTML =
    '<div class="detail-header">' +
      '<h2 style="margin:0;text-transform:none;letter-spacing:0;font-size:14px;font-weight:600;color:var(--text)">Message <span class="col-id">' + esc(m.id.slice(0, 8)) + '</span></h2>' +
      '<span class="pill ' + esc(m.status) + '">' + esc(m.status) + '</span>' +
    '</div>' +
    '<p class="detail-meta">' + esc(m.protocol) + ' · ' + esc(m.direction) + ' · device <strong>' + esc(m.deviceId ?? '—') + '</strong> · ' + new Date(m.receivedAt).toLocaleString() + '</p>' +
    errors + match + profile + actions +
    studyGrid +
    (isImaging
      ? '<div class="grid2">' +
          '<div><h2>Raw message</h2><pre>' + esc(m.raw) + '</pre></div>' +
          eventJson +
        '</div>' + timelineBlock
      : '<div class="grid2">' +
          '<div><h2>Raw message</h2><pre>' + esc(m.raw) + '</pre></div>' +
          '<div><h2>Parsed records</h2><div class="tbl-wrap"><table><thead><tr><th>T</th><th>Fields</th></tr></thead><tbody>' + records + '</tbody></table></div></div>' +
        '</div>' +
        '<div class="grid2">' +
          '<div><h2>Canonical payload</h2><pre>' + esc(JSON.stringify(m.payload, null, 2)) + '</pre></div>' +
          timelineBlock +
        '</div>');
}

/* ── Profiles ──────────────────────────────────────────────────────── */
function renderProfiles(profiles) {
  document.getElementById('profiles').querySelector('tbody').innerHTML = profiles.map(p =>
    '<tr>' +
    '<td><span class="dev-name">' + esc(p.name) + '</span><br/><span class="dev-id">' + esc(p.id) + ' · ' + esc(p.manufacturer || '—') + ' ' + esc(p.model || '') + '</span>' +
    (p.layout && (p.layout.order || p.layout.result || p.layout.patient) ? '' : '<br/><span class="muted" style="font-size:10px">(reference layout)</span>') + '</td>' +
    '<td><span class="prof-status ' + esc(p.status) + '">' + esc(p.status) + '</span></td>' +
    '<td class="dim">v' + esc(p.version) + '</td>' +
    '<td id="conf-' + esc(p.id) + '"><span class="conf none">…</span></td>' +
    '<td style="white-space:nowrap">' +
      '<details style="display:inline-block"><summary style="cursor:pointer;font-size:11px;color:var(--muted)">JSON</summary><pre style="max-height:180px;margin-top:6px">' + esc(JSON.stringify(p, null, 2)) + '</pre></details>' +
      (manageProfiles() ? ' <button class="danger" style="font-size:11px;padding:3px 8px" onclick="deleteProfile(\\'' + esc(p.id) + '\\')">Delete</button>' : '') +
    '</td></tr>'
  ).join('') || '<tr class="empty-row"><td colspan="5">No profiles — add one below (engineer/admin).</td></tr>';

  document.getElementById('profile-add').style.display = manageProfiles() ? 'block' : 'none';

  // Async conformance fetch per profile
  for (const p of profiles) {
    if (confCache[p.id]) continue;
    confCache[p.id] = true;
    api('/api/v1/profiles/' + encodeURIComponent(p.id) + '/conformance').then(r => r.json()).then(conf => {
      const el = document.getElementById('conf-' + esc(p.id));
      if (!el) return;
      if (!conf.available) { el.innerHTML = '<span class="conf none">no goldens</span>'; return; }
      const ok = conf.run && conf.run.failed === 0 && conf.run.cases.length > 0;
      el.innerHTML = conf.run && conf.run.cases.length > 0
        ? '<details style="display:inline-block"><summary class="conf ' + (ok ? 'ok' : 'bad') + '" style="cursor:pointer">' +
          (ok ? '✓ passed' : '✗ FAILED') + ' (' + conf.run.passed + '/' + conf.run.cases.length + ')' + '</summary>' +
          '<ul class="timeline" style="margin-top:6px">' + conf.run.cases.map(c =>
            '<li><b class="conf ' + (c.pass ? 'ok' : 'bad') + '">' + (c.pass ? '✓' : '✗') + '</b> ' + esc(c.name) +
            (c.failures.length ? '<br/><span class="err" style="font-size:11px">' + esc(c.failures.join(' · ')) + '</span>' : '') + '</li>'
          ).join('') + '</ul></details>'
        : '<span class="conf ' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✓ passed' : 'no cases') + '</span>';
    }).catch(() => {});
  }
}

/* ── Profile mutations ─────────────────────────────────────────────── */
async function addProfile() {
  const result = document.getElementById('profile-add-result');
  const raw = document.getElementById('profile-json').value.trim();
  try {
    const profile = JSON.parse(raw);
    const res = await api('/api/v1/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    const body = await res.json();
    if (!res.ok) { result.textContent = 'rejected: ' + (body.error || JSON.stringify(body.issues || body)); result.className = 'err'; return; }
    result.textContent = '✓ saved ' + body.id + ' (v' + body.version + ')';
    result.className = 'ok';
    document.getElementById('profile-json').value = '';
  } catch (err) {
    result.textContent = 'invalid JSON: ' + err.message;
    result.className = 'err';
  }
  await refresh();
}

async function deleteProfile(id) {
  if (!confirm('Delete profile ' + id + '? Devices bound to it detach (they fall back to the reference layout).')) return;
  const res = await api('/api/v1/profiles/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) alert('delete failed: ' + res.status);
  await refresh();
}

/* ── Keys ──────────────────────────────────────────────────────────── */
function showKeyResult(msg, isErr) {
  const el = document.getElementById('keys-result');
  el.style.display = 'block';
  el.textContent = msg;
  el.className = isErr ? 'err' : 'ok';
}

function renderKeys(keys) {
  const panel = document.getElementById('keys-panel');
  if (!keys) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  document.getElementById('keys').querySelector('tbody').innerHTML = keys.map(k => {
    const expired = k.expiresAt && Date.parse(k.expiresAt) <= Date.now();
    const statusHtml = !k.enabled ? '<span class="kstatus off">disabled</span>'
      : expired ? '<span class="kstatus expired">expired</span>'
      : '<span class="kstatus ok">active</span>';
    const neverSeen = !k.lastUsedAt || (k.secretIssuedAt && new Date(k.lastUsedAt).getTime() < new Date(k.secretIssuedAt).getTime());
    const usedHtml  = neverSeen ? '<span class="kstatus warn">never used</span>'
      : k.lastUsedAt ? '<span class="dim mono">' + new Date(k.lastUsedAt).toLocaleString() + '</span>' : '—';
    const self = k.id === meId;
    const btns = [];
    if (k.enabled && !expired && !self) btns.push('<button class="ghost" style="font-size:11px;padding:3px 8px" onclick="toggleKey(\\'' + esc(k.id) + '\\',false)">Disable</button>');
    if (!k.enabled && !self)           btns.push('<button class="ghost" style="font-size:11px;padding:3px 8px" onclick="toggleKey(\\'' + esc(k.id) + '\\',true)">Enable</button>');
    btns.push('<button class="ghost" style="font-size:11px;padding:3px 8px" onclick="renameKey(\\'' + esc(k.id) + '\\')">Rename</button>');
    btns.push('<button class="ghost" style="font-size:11px;padding:3px 8px" onclick="setKeyExpiry(\\'' + esc(k.id) + '\\')">' + (k.expiresAt ? 'Change expiry' : 'Set expiry') + '</button>');
    btns.push('<button class="ghost" style="font-size:11px;padding:3px 8px" onclick="rotateKey(\\'' + esc(k.id) + '\\')">Re-issue</button>');
    if (!self) btns.push('<button class="danger" style="font-size:11px;padding:3px 8px" onclick="deleteKey(\\'' + esc(k.id) + '\\')">Delete</button>');
    return '<tr>' +
      '<td><span class="dev-name">' + esc(k.name) + (self ? ' <span class="kstatus ok">(you)</span>' : '') + '</span><br/><span class="dev-id">' + esc(k.id) + ' · ' + esc(k.prefix) + '…</span></td>' +
      '<td>' + esc(k.role) + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td class="dim mono">' + (k.expiresAt ? new Date(k.expiresAt).toLocaleString() : 'never') + '</td>' +
      '<td>' + usedHtml + '</td>' +
      '<td style="white-space:nowrap">' + btns.join(' ') + '</td></tr>';
  }).join('') || '<tr class="empty-row"><td colspan="6">No keys yet.</td></tr>';
}

async function patchKey(id, patch) {
  const res = await api('/api/v1/keys/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { showKeyResult('failed: ' + (body.error || res.status), true); return; }
  showKeyResult('✓ saved ' + body.id + (patch.name !== undefined ? ' — renamed to "' + body.name + '"' : ''), false);
  await refresh();
}

function toggleKey(id, enabled) { patchKey(id, { enabled }); }

async function renameKey(id) {
  const name = prompt('New name for ' + id + ':');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  await patchKey(id, { name: trimmed });
}

async function setKeyExpiry(id) {
  const input = prompt('Days until expiry for ' + id + ' (blank = clear expiry):');
  if (input === null) return;
  const days = parseInt(input, 10);
  const expiresAt = isNaN(days) || days <= 0 ? null : new Date(Date.now() + days * 86400000).toISOString();
  await patchKey(id, { expiresAt });
}

async function createKey() {
  const name = document.getElementById('key-name').value.trim();
  if (!name) return;
  const role    = document.getElementById('key-role').value;
  const daysRaw = document.getElementById('key-expiry').value;
  const days    = parseInt(daysRaw, 10);
  const expiresAt = !daysRaw || isNaN(days) || days <= 0 ? undefined : new Date(Date.now() + days * 86400000).toISOString();
  const res = await api('/api/v1/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, role, expiresAt }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { showKeyResult('create failed: ' + (body.error || res.status), true); return; }
  showSecretOnce('Created ' + body.key.id + ' (' + body.key.role + '). Secret shown once — copy it now:', body.secret, body.key.expiresAt);
  document.getElementById('key-name').value  = '';
  document.getElementById('key-expiry').value = '';
  await refresh();
}

function showSecretOnce(label, secret, expiresAt) {
  const holder = document.getElementById('keys-result');
  holder.style.display = 'block';
  holder.className = '';
  holder.innerHTML =
    '<span style="color:var(--ok);font-size:12px">' + esc(label) + '</span><br/>' +
    '<input readonly value="' + esc(secret) + '" style="width:100%;margin:6px 0;font-family:ui-monospace,Menlo,monospace" onfocus="this.select()"/>' +
    (expiresAt ? '<span class="muted" style="font-size:11px">expires ' + new Date(expiresAt).toLocaleString() + '</span>' : '');
}

async function rotateKey(id) {
  if (!confirm('Re-issue the secret for ' + id + '? The current secret stops working immediately.')) return;
  const res  = await api('/api/v1/keys/' + encodeURIComponent(id) + '/rotate', { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { showKeyResult('re-issue failed: ' + (body.error || res.status), true); return; }
  const holder = document.getElementById('keys-result');
  holder.style.display = 'block';
  holder.className = '';
  holder.innerHTML =
    '<span style="color:var(--ok);font-size:12px">New secret for ' + esc(body.key.id) + ' — shown once, copy it now:</span><br/>' +
    '<input readonly value="' + esc(body.secret) + '" style="width:100%;margin:6px 0;font-family:ui-monospace,Menlo,monospace" onfocus="this.select()"/>' +
    (body.warning ? '<div class="err" style="font-size:12px;margin-top:4px">⚠ ' + esc(body.warning) + '</div>' : '');
  await refresh();
}

async function deleteKey(id) {
  if (!confirm('Delete key ' + id + '? This revokes it permanently and cannot be undone.')) return;
  const res = await api('/api/v1/keys/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) { showKeyResult('delete failed: ' + res.status, true); return; }
  showKeyResult('✓ deleted ' + id, false);
  await refresh();
}

/* ── Updates ───────────────────────────────────────────────────────── */
async function renderUpdates() {
  const panel = document.getElementById('updates-panel');
  if (!hubKey) { panel.style.display = 'none'; return; }
  try {
    const s = await api('/api/v1/updates/status').then(r => r.json());
    panel.style.display = 'block';
    const cur     = s.current && s.current.release ? s.current.release : s.running;
    const running = cur
      ? '<b>v' + esc(cur.version) + '</b>' + (s.current && !s.current.healthy ? ' <span class="pill FAILED">transitioning…</span>' : '')
      : '—';
    document.getElementById('upd-running').innerHTML = 'Running: ' + running +
      (s.current && s.current.appliedAt ? ' <span class="muted">(' + new Date(s.current.appliedAt).toLocaleTimeString() + ')</span>' : '');
    let note = '';
    if (s.desired)
      note = '<span class="pill DELIVERING">' + esc(s.desired.kind) + ' staged</span> v' + esc(s.desired.release.version) + ' — supervisor will swap + health-gate.';
    else if (!s.enabled)
      note = 'Not configured (HUB_STATE_DIR / UPDATE_SOURCE / UPDATE_PUBLIC_KEY).';
    else if (s.supervisor && s.supervisor.alive)
      note = 'Supervised (pid ' + esc(s.supervisor.pid) + ') — signed updates auto-apply with rollback.';
    else
      note = 'No supervisor watching — staged updates wait until one attaches.';
    document.getElementById('upd-note').innerHTML = note;
    const rows = (s.history || []).slice(0, 6).map(x =>
      '<tr>' +
      '<td class="dim mono">' + new Date(x.at).toLocaleTimeString() + '</td>' +
      '<td><span class="pill ' + esc(x.event === 'failed' ? 'FAILED' : 'ROUTED') + '">' + esc(x.event) + '</span></td>' +
      '<td>' + esc(x.version || '—') + '</td>' +
      '<td class="muted">' + esc(x.reason || '') + '</td></tr>').join('');
    document.getElementById('upd-history').querySelector('tbody').innerHTML =
      rows || '<tr class="empty-row"><td colspan="4">No update events recorded.</td></tr>';
    const manage = meRole === 'admin';
    document.getElementById('upd-actions').style.display = manage && s.enabled ? 'flex' : 'none';
  } catch {
    panel.style.display = 'none';
  }
}

async function updPost(action, label) {
  const result = document.getElementById('upd-result');
  result.textContent = '';
  try {
    const res  = await api('/api/v1/updates/' + action, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) { result.textContent = label + ' failed: ' + (body.error || res.status); result.className = 'err'; return; }
    result.textContent = body.staged
      ? (label + ' staged — ' + (body.release ? 'v' + body.release.version : '') + '; supervisor applies it.').trim()
      : (body.reason || label + ' done');
    result.className = '';
  } catch (err) {
    result.textContent = label + ' failed: ' + err.message;
    result.className = 'err';
  }
  await refresh();
}

function updCheck()    { updPost('check',    'Check');    }
function updApply()    { updPost('apply',    'Apply');    }
function updRollback() { updPost('rollback', 'Rollback'); }

/* ── Message actions ───────────────────────────────────────────────── */
async function replayMessage(id) {
  await api('/api/v1/messages/' + id + '/replay', { method: 'POST' });
  selectedId = null;
  await refresh();
}

async function releaseMessage(id) {
  await api('/api/v1/messages/' + id + '/release', { method: 'POST' });
  selectedId = null;
  await refresh();
}

async function retryMessage(id) {
  const res = await api('/api/v1/messages/' + id + '/retry', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert('retry failed: ' + (body.error || res.status));
    return;
  }
  selectedId = null;
  await refresh();
}

/* ── Boot ──────────────────────────────────────────────────────────── */
updateRole().then(() => refresh());
if (!hubKey) showSignIn();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}
