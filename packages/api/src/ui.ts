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
  :root { color-scheme: dark; --bg:#0f1115; --panel:#171a21; --border:#262b36; --text:#e6e8ee; --muted:#8b93a5; --ok:#3fb68b; --err:#e5484d; --warn:#f5a524; --accent:#4c8dff; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:var(--bg); color:var(--text); font-size:13px; }
  header { padding:14px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:12px; }
  h1 { font-size:15px; margin:0; }
  .badge { font-size:11px; padding:2px 8px; border-radius:10px; border:1px solid var(--border); color:var(--muted); }
  .badge.ok { color:var(--ok); border-color:var(--ok); }
  .badge.off { color:var(--err); border-color:var(--err); }
  main { padding:20px; display:grid; grid-template-columns:330px 1fr; gap:20px; align-items:start; }
  @media (max-width:950px) { main { grid-template-columns:1fr; } }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:16px; }
  h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 10px; }
  .stats { display:flex; gap:8px; flex-wrap:wrap; }
  .stat { flex:1; min-width:80px; background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:8px 10px; }
  .stat b { display:block; font-size:17px; }
  .stat span { color:var(--muted); font-size:11px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); font-size:12px; vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  tr.msg { cursor:pointer; }
  tr.msg:hover { background:rgba(76,141,255,.07); }
  .status { font-weight:600; }
  .status.ROUTED, .status.MAPPED { color:var(--ok); }
  .status.FAILED { color:var(--err); }
  .status.HELD { color:#c084fc; }
  .status.RECEIVED, .status.PARSED, .status.VALIDATED, .status.QUEUED, .status.DELIVERING { color:var(--warn); }
  .status.DUPLICATE, .status.DISCARDED { color:var(--muted); }
  .match { font-size:11px; color:var(--muted); }
  .match.MATCHED { color:var(--ok); }
  .match.AMBIGUOUS, .match.UNMATCHED, .match.REJECTED { color:#c084fc; }
  .prof-status.certified { color:var(--ok); }
  .prof-status.draft { color:var(--warn); }
  .conf.ok { color:var(--ok); }
  .conf.bad { color:var(--err); }
  .conf.none { color:var(--muted); }
  .alert.FIRING { color:#ff6b6b; }
  .alert.RESOLVED { color:var(--ok); }
  pre { background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:10px; overflow:auto; max-height:280px; font-size:12px; margin:0; white-space:pre-wrap; word-break:break-all; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:6px 12px; cursor:pointer; font-family:inherit; font-size:12px; }
  .muted { color:var(--muted); }
  .detail { margin-top:12px; display:none; }
  .detail.open { display:block; }
  ul.timeline { list-style:none; padding:0; margin:0; }
  ul.timeline li { padding:3px 0; color:var(--muted); }
  ul.timeline li b { color:var(--text); }  .col-id { color: var(--accent); }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media (max-width:700px){ .grid2 { grid-template-columns:1fr; } }
  .err { color:var(--err); }
  .kstatus.ok { color:var(--ok); }
  .kstatus.off { color:var(--muted); }
  .kstatus.warn { color:var(--warn); }
  .kstatus.expired { color:var(--err); }
  select { background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:8px; font-family:inherit; font-size:12px; }
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,.65); display:flex; align-items:center; justify-content:center; z-index:10; }
  input { background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:8px; font-family:inherit; font-size:12px; }
  input:focus { outline:1px solid var(--accent); }
  .role { color:var(--accent); border-color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Integration Hub <span class="muted">// management console</span></h1>
  <span class="badge" id="health">connecting…</span>
  <span class="badge" id="version" style="display:none"></span>
  <span class="badge role" id="role" style="display:none"></span>
  <span style="flex:1"></span>
  <button id="keybtn" style="display:none" onclick="showSignIn()">API key</button>
</header>
<div class="overlay" id="overlay" style="display:none">
  <div class="panel" style="max-width:440px;width:100%">
    <h2>API key required</h2>
    <p class="muted">The hub API is authenticated (PRD §34; roles admin / engineer /
      operator / viewer). Paste an API key — ask an administrator, or copy the
      admin key printed when the hub started (or set HUB_ADMIN_KEY).</p>
    <input id="key-input" type="password" placeholder="ihk_…" style="width:100%;margin:10px 0" autocomplete="off"/>
    <button onclick="applyKey()">Sign in</button>
    <button onclick="dismissSignIn()" style="background:transparent;border:1px solid var(--border)">Cancel</button>
  </div>
</div>
<main>
  <section>
    <div class="panel"><h2>Dashboard</h2><div class="stats" id="stats"></div></div>
    <div class="panel">
      <h2>Devices</h2>
      <table id="devices"><thead><tr><th>Device</th><th>State</th><th>Last seen</th></tr></thead><tbody></tbody></table>
    </div>
    <div class="panel">
      <h2>Device profiles <span class="muted">certified config = adapter (A4)</span></h2>
      <table id="profiles"><thead><tr><th>Profile</th><th>Status</th><th>Version</th><th>Conformance</th><th></th></tr></thead><tbody></tbody></table>
      <div id="profile-add" style="display:none;margin-top:10px">
        <h2 style="margin-bottom:4px">Add / replace profile (paste profile JSON)</h2>
        <textarea id="profile-json" rows="6" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px;font-family:inherit;font-size:12px" placeholder='{"id":"my-device","name":"…","manufacturer":"…","model":"…","protocol":"ASTM","transport":"tcp","version":1,"layout":{},"mappings":{},"status":"draft"}'></textarea>
        <button onclick="addProfile()">Save profile</button>
        <span class="muted" id="profile-add-result"></span>
      </div>
    </div>
    <div class="panel">
      <h2>Alerts <span class="muted" id="alert-count"></span></h2>
      <table id="alerts"><thead><tr><th>Kind</th><th>State</th><th>Message</th><th>Fired</th></tr></thead><tbody></tbody></table>
    </div>
    <div class="panel" id="updates-panel" style="display:none">
      <h2>Software updates</h2>
      <p id="upd-running" class="muted"></p>
      <p id="upd-note" class="muted"></p>
      <table id="upd-history"><thead><tr><th>When</th><th>Event</th><th>Version</th><th>Detail</th></tr></thead><tbody></tbody></table>
      <div id="upd-actions" style="display:none;margin-top:8px">
        <button onclick="updCheck()">Check for updates</button>
        <button onclick="updApply()">Apply available</button>
        <button onclick="updRollback()">Roll back</button>
      </div>
      <p class="muted" id="upd-result" style="margin-bottom:0"></p>
    </div>
    <div class="panel" id="keys-panel" style="display:none">
      <h2>Access keys <span class="muted">rotation · rename · disable · expiry · re-issue</span></h2>
      <div id="keys-result" style="white-space:pre-wrap;font-size:12px;margin-bottom:6px"></div>
      <table id="keys"><thead><tr><th>Key</th><th>Role</th><th>Status</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody></tbody></table>
      <div id="keys-add" style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <input id="key-name" placeholder="name e.g. LIS interface v2" style="width:180px"/>
        <select id="key-role"><option value="viewer">viewer</option><option value="operator">operator</option><option value="engineer">engineer</option><option value="admin">admin</option></select>
        <input id="key-expiry" type="number" min="1" placeholder="expire in N days (blank = never)" style="width:200px"/>
        <button onclick="createKey()">Create key</button>
      </div>
    </div>
  </section>
  <section>
    <div class="panel">
      <h2>Messages <span class="muted" id="msg-count"></span></h2>
      <table id="messages"><thead><tr><th>Time</th><th>Device</th><th>Status</th><th>Results</th><th>ID</th></tr></thead><tbody></tbody></table>
    </div>
    <div class="panel" id="detail" style="display:none"></div>
  </section>
</main>
<script>
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let selectedId = null;
let confCache = {};
let meId = null;
let hubKey = localStorage.getItem('hub.key') || '';
let meRole = null;
let signInVisible = false;

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

function showSignIn() {
  if (signInVisible) return;
  signInVisible = true;
  const input = document.getElementById('key-input');
  input.value = hubKey;
  document.getElementById('overlay').style.display = 'flex';
  input.focus();
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

async function updateRole() {
  const roleEl = document.getElementById('role');
  roleEl.style.display = 'none';
  if (!hubKey) return;
  try {
    const me = await api('/api/v1/me').then(r => r.json());
    meRole = me.role;
    meId = me.id;
    roleEl.textContent = me.role + ' · ' + me.name;
    roleEl.style.display = 'inline-block';
  } catch { meRole = null; }
}

function canAct() {
  return ['admin', 'engineer', 'operator'].indexOf(meRole) !== -1;
}

async function refresh() {
  try {
    const keysReq = meRole === 'admin'
      ? api('/api/v1/keys').then(r => r.json())
      : Promise.resolve(null);
    const [health, stats, devices, alerts, messages, profiles, keys] = await Promise.all([
      api('/api/v1/health').then(r => r.json()),
      api('/api/v1/stats').then(r => r.json()),
      api('/api/v1/devices').then(r => r.json()),
      api('/api/v1/alerts?firing=true&limit=50').then(r => r.json()),
      api('/api/v1/messages?limit=100').then(r => r.json()),
      api('/api/v1/profiles').then(r => r.json()),
      keysReq,
    ]);
    const h = document.getElementById('health');
    h.textContent = health.status === 'ok' ? 'online' : 'degraded';
    h.className = 'badge ' + (health.status === 'ok' ? 'ok' : 'off');
    const vEl = document.getElementById('version');
    if (health.version) { vEl.textContent = 'v' + health.version; vEl.style.display = 'inline-block'; }
    renderStats(stats);
    renderDevices(devices);
    renderAlerts(alerts);
    renderMessages(messages);
    renderProfiles(profiles);
    renderKeys(keys);
    if (selectedId) renderDetail(selectedId);
    renderUpdates();
  } catch {
    const h = document.getElementById('health');
    h.textContent = 'offline';
    h.className = 'badge off';
  }
}

function renderAlerts(alerts) {
  document.getElementById('alert-count').textContent = '(' + alerts.length + ' firing)';
  document.getElementById('alerts').querySelector('tbody').innerHTML =
    alerts.map(a =>
      '<tr><td>' + esc(a.kind) + '</td>' +
      '<td><span class="alert ' + esc(a.status) + '">' + esc(a.status) + '</span></td>' +
      '<td>' + esc(a.message) + '</td>' +
      '<td class="muted">' + new Date(a.firedAt).toLocaleTimeString() + '</td></tr>'
    ).join('') || '<tr><td colspan="4" class="muted">No firing alerts.</td></tr>';
}

function renderStats(s) {
  const held = s.byStatus && (s.byStatus.HELD || 0);
  document.getElementById('stats').innerHTML = [
    ['Messages', s.total], ['Today', s.today], ['Failed', s.failed], ['Pending', s.pending],
    ['Held', held], ['DLQ', s.byStatus.FAILED || 0],
  ].map(([k, v]) => '<div class="stat"><b>' + v + '</b><span>' + k + '</span></div>').join('');
}

function renderDevices(devices) {
  document.getElementById('devices').querySelector('tbody').innerHTML =
    devices.map(d =>
      '<tr><td>' + esc(d.name) + '<br/><span class="muted">' + esc(d.id) + '</span>' +
      (d.profileId ? '<br/><span class="badge role">profile ' + esc(d.profileId) + '</span>' : '') + '</td>' +
      '<td><span class="status ' + esc(d.state) + '">' + esc(d.state) + '</span></td>' +
      '<td class="muted">' + (d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : '—') + '</td></tr>'
    ).join('') || '<tr><td colspan="3" class="muted">No devices yet. Start the simulator.</td></tr>';
}

function renderMessages(messages) {
  document.getElementById('msg-count').textContent = '(' + messages.length + ' shown)';
  document.getElementById('messages').querySelector('tbody').innerHTML =
    messages.map(m =>
      '<tr class="msg" onclick="openDetail(\\'' + m.id + '\\')">' +
      '<td class="muted">' + new Date(m.receivedAt).toLocaleTimeString() + '</td>' +
      '<td>' + esc(m.deviceId ?? '—') + '</td>' +
      '<td><span class="status ' + esc(m.status) + '">' + esc(m.status) + '</span>' +
      (m.match ? '<br/><span class="match ' + esc(m.match.status) + '">' + esc(m.match.status) + '</span>' : '') +
      '</td>' +
      '<td>' + (m.payload ? m.payload.results.length : 0) + '</td>' +
      '<td class="col-id">' + esc(m.id.slice(0, 8)) + '</td></tr>'
    ).join('') || '<tr><td colspan="5" class="muted">No messages yet. Start the simulator.</td></tr>';
}

async function openDetail(id) {
  selectedId = id;
  await renderDetail(id);
}

async function renderDetail(id) {
  const m = await api('/api/v1/messages/' + id).then(r => r.json());
  const panel = document.getElementById('detail');
  panel.style.display = 'block';
  const errors = m.errors && m.errors.length
    ? '<div class="err">' + m.errors.map(esc).join('<br/>') + '</div>' : '';
  const records = (m.records || []).map(r =>
    '<tr><td>' + esc(r.type) + '</td><td>' + esc(r.fields.join(' | ')) + '</td></tr>').join('');
  const timeline = (m.timeline || []).map(t =>
    '<li><b>' + esc(t.stage) + '</b> ' + new Date(t.at).toLocaleTimeString() + (t.note ? ' — ' + esc(t.note) : '') + '</li>').join('');
  const match = m.match ?
    '<p><span class="match ' + esc(m.match.status) + '">' + esc(m.match.status) + '</span>' +
    (m.match.strategy ? ' via ' + esc(m.match.strategy) : '') +
    (m.match.matchedOrderId ? ' → order ' + esc(m.match.matchedOrderId) : '') +
    (m.match.reason ? ' — ' + esc(m.match.reason) : '') + '</p>' : '';
  const actions = (canAct()
    ? (m.status === 'HELD'
      ? '<button onclick="releaseMessage(\\'' + m.id + '\\')">Review &amp; release</button> '
      : '') + '<button onclick="replayMessage(\\'' + m.id + '\\')">Replay</button>'
    : '<span class="muted">read-only key — actions hidden</span>');
  panel.innerHTML =
    '<h2>Message ' + esc(m.id.slice(0, 8)) + ' <span class="status ' + esc(m.status) + '">' + esc(m.status) + '</span></h2>' +
    errors +
    match +
    '<p class="muted">' + esc(m.protocol) + ' · ' + esc(m.direction) + ' · device ' + esc(m.deviceId ?? '—') + ' · ' + new Date(m.receivedAt).toLocaleString() + '</p>' +
    actions +
    '<div class="grid2" style="margin-top:12px">' +
      '<div><h2>Raw message</h2><pre>' + esc(m.raw) + '</pre></div>' +
      '<div><h2>Parsed records</h2><table><thead><tr><th>T</th><th>Fields</th></tr></thead><tbody>' + records + '</tbody></table></div>' +
    '</div>' +
    '<div class="grid2">' +
      '<div><h2>Canonical payload</h2><pre>' + esc(JSON.stringify(m.payload, null, 2)) + '</pre></div>' +
      '<div><h2>Timeline</h2><ul class="timeline">' + timeline + '</ul></div>' +
    '</div>';
}

function renderProfiles(profiles) {
  document.getElementById('profiles').querySelector('tbody').innerHTML = profiles.map(p =>
    '<tr>' +
    '<td>' + esc(p.name) + '<br/><span class="muted">' + esc(p.id) + ' · ' + esc(p.manufacturer || '—') + ' ' + esc(p.model || '') + '</span>' +
    (p.layout && (p.layout.order || p.layout.result || p.layout.patient) ? '' : '<br/><span class="muted">(reference layout)</span>') +
    '</td>' +
    '<td><span class="prof-status ' + esc(p.status) + '">' + esc(p.status) + '</span></td>' +
    '<td class="muted">v' + esc(p.version) + '</td>' +
    '<td id="conf-' + esc(p.id) + '"><span class="conf none">loading…</span></td>' +
    '<td style="white-space:nowrap">' +
      '<details class="prof-detail" style="display:inline-block"><summary class="muted" style="cursor:pointer">JSON</summary><pre style="max-height:180px">' + esc(JSON.stringify(p, null, 2)) + '</pre></details> ' +
      (manageProfiles() ? '<button onclick="deleteProfile(\\'' + esc(p.id) + '\\')" style="background:transparent;border:1px solid var(--err);color:var(--err)">Delete</button>' : '') +
    '</td></tr>'
  ).join('') || '<tr><td colspan="5" class="muted">No profiles. Add one below (engineer/admin).</td></tr>';
  document.getElementById('profile-add').style.display = manageProfiles() ? 'block' : 'none';
  // Fetch conformance per profile (async; small set).
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
          (ok ? 'passed ✓' : 'FAILED ✗') + ' (' + conf.run.passed + '/' + conf.run.cases.length + ')' + '</summary>' +
          '<ul class="timeline">' + conf.run.cases.map(c =>
            '<li><b class="conf ' + (c.pass ? 'ok' : 'bad') + '">' + (c.pass ? '✓' : '✗') + '</b> ' + esc(c.name) +
            (c.failures.length ? '<br/><span class="err">' + esc(c.failures.join(' · ')) + '</span>' : '') + '</li>'
          ).join('') + '</ul></details>'
        : '<span class="conf ' + (ok ? 'ok' : 'bad') + '">' + (ok ? 'passed ✓' : 'no cases') + '</span>';
    }).catch(() => {});
  }
}

function manageProfiles() {
  return meRole === 'admin' || meRole === 'engineer';
}

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
    result.textContent = 'saved ' + body.id + ' (v' + body.version + ')';
    result.className = '';
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

function renderKeys(keys) {
  const panel = document.getElementById('keys-panel');
  if (!keys) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  document.getElementById('keys').querySelector('tbody').innerHTML = keys.map(k => {
    const expired = k.expiresAt && Date.parse(k.expiresAt) <= Date.now();
    const status = !k.enabled ? '<span class="kstatus off">disabled</span>'
      : expired ? '<span class="kstatus expired">expired</span>'
      : '<span class="kstatus ok">active</span>';
    const neverSeen = !k.lastUsedAt || (k.secretIssuedAt && new Date(k.lastUsedAt).getTime() < new Date(k.secretIssuedAt).getTime());
    const used = neverSeen ? '<span class="kstatus warn">never used</span>'
      : k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : '—';
    const self = k.id === meId;
    const actions = [];
    if (k.enabled && !expired && !self) actions.push('<button onclick="toggleKey(\\'' + esc(k.id) + '\\',false)">Disable</button>');
    if (!k.enabled && !self) actions.push('<button onclick="toggleKey(\\'' + esc(k.id) + '\\',true)">Enable</button>');
    actions.push('<button onclick="renameKey(\\'' + esc(k.id) + '\\')">Rename</button>');
    actions.push('<button onclick="setKeyExpiry(\\'' + esc(k.id) + '\\')">' + (k.expiresAt ? 'Change expiry' : 'Set expiry') + '</button>');
    actions.push('<button onclick="rotateKey(\\'' + esc(k.id) + '\\')">Re-issue</button>');
    if (!self) actions.push('<button style="background:transparent;border:1px solid var(--err);color:var(--err)" onclick="deleteKey(\\'' + esc(k.id) + '\\')">Delete</button>');
    return '<tr><td>' + esc(k.name) + (self ? ' <span class="kstatus ok">(this session)</span>' : '') + '<br/><span class="muted">' + esc(k.id) + ' · ' + esc(k.prefix) + '…</span></td>' +
      '<td>' + esc(k.role) + '</td>' +
      '<td>' + status + '</td>' +
      '<td class="muted">' + (k.expiresAt ? new Date(k.expiresAt).toLocaleString() : 'never') + '</td>' +
      '<td>' + used + '</td>' +
      '<td style="white-space:nowrap">' + actions.join(' ') + '</td></tr>';
  }).join('') || '<tr><td colspan="6" class="muted">No keys yet.</td></tr>';
}

function showKeyResult(msg, isErr) {
  const el = document.getElementById('keys-result');
  el.textContent = msg;
  el.className = isErr ? 'err' : '';
}

async function patchKey(id, patch) {
  const res = await api('/api/v1/keys/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { showKeyResult('failed: ' + (body.error || res.status), true); return; }
  showKeyResult('saved ' + body.id + (patch.name !== undefined ? ' — renamed to "' + body.name + '"' : ''));
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
  const role = document.getElementById('key-role').value;
  const daysRaw = document.getElementById('key-expiry').value;
  const days = parseInt(daysRaw, 10);
  const expiresAt = !daysRaw || isNaN(days) || days <= 0 ? undefined : new Date(Date.now() + days * 86400000).toISOString();
  const res = await api('/api/v1/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, role, expiresAt }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { showKeyResult('create failed: ' + (body.error || res.status), true); return; }
  showSecretOnce('Created ' + body.key.id + ' (' + body.key.role + '). Secret shown once — copy it now:', body.secret, body.key.expiresAt);
  document.getElementById('key-name').value = '';
  document.getElementById('key-expiry').value = '';
  await refresh();
}

function showSecretOnce(label, secret, expiresAt) {
  const holder = document.getElementById('keys-result');
  holder.className = '';
  holder.innerHTML = '<span style="color:var(--ok)">' + esc(label) + '</span><br/>' +
    '<input readonly value="' + esc(secret) + '" style="width:100%;margin:6px 0" onfocus="this.select()"/>' +
    (expiresAt ? '<span class="muted">expires ' + new Date(expiresAt).toLocaleString() + '</span>' : '');
}

async function rotateKey(id) {
  if (!confirm('Re-issue the secret for ' + id + '? The current secret stops working immediately.')) return;
  const res = await api('/api/v1/keys/' + encodeURIComponent(id) + '/rotate', { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { showKeyResult('re-issue failed: ' + (body.error || res.status), true); return; }
  const holder = document.getElementById('keys-result');
  holder.className = '';
  holder.innerHTML = '<span style="color:var(--ok)">New secret for ' + esc(body.key.id) + ' — shown once, copy it now:</span><br/>' +
    '<input readonly value="' + esc(body.secret) + '" style="width:100%;margin:6px 0" onfocus="this.select()"/>' +
    (body.warning ? '<div class="err">⚠ ' + esc(body.warning) + '</div>' : '');
  await refresh();
}

async function deleteKey(id) {
  if (!confirm('Delete key ' + id + '? This revokes it permanently and cannot be undone.')) return;
  const res = await api('/api/v1/keys/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) { showKeyResult('delete failed: ' + res.status, true); return; }
  showKeyResult('deleted ' + id);
  await refresh();
}

async function renderUpdates() {
  const panel = document.getElementById('updates-panel');
  if (!hubKey) { panel.style.display = 'none'; return; }
  try {
    const s = await api('/api/v1/updates/status').then(r => r.json());
    panel.style.display = 'block';
    const cur = s.current && s.current.release ? s.current.release : s.running;
    const running = cur ? '<b>v' + esc(cur.version) + '</b>' + (s.current && !s.current.healthy ? ' <span class="status FAILED">transitioning…</span>' : '') : '—';
    document.getElementById('upd-running').innerHTML = 'Running: ' + running +
      (s.current && s.current.appliedAt ? ' <span class="muted">(' + new Date(s.current.appliedAt).toLocaleTimeString() + ')</span>' : '');
    let note = '';
    if (s.desired) note = '<span class="status DELIVERING">' + esc(s.desired.kind) + ' staged:</span> v' + esc(s.desired.release.version) + ' — the supervisor will swap + health-gate it.';
    else if (!s.enabled) note = 'not configured (HUB_STATE_DIR / UPDATE_SOURCE / UPDATE_PUBLIC_KEY)';
    else if (s.supervisor && s.supervisor.alive) note = 'supervised (pid ' + esc(s.supervisor.pid) + ') — signed updates auto-apply with rollback.';
    else note = 'no supervisor watching — staged updates wait until one attaches.';
    document.getElementById('upd-note').innerHTML = note;
    const rows = (s.history || []).slice(0, 6).map(x =>
      '<tr><td class="muted">' + new Date(x.at).toLocaleTimeString() + '</td>' +
      '<td><span class="status ' + esc(x.event === 'failed' ? 'FAILED' : 'ok') + '">' + esc(x.event) + '</span></td>' +
      '<td>' + esc(x.version || '—') + '</td><td class="muted">' + esc(x.reason || '') + '</td></tr>').join('');
    document.getElementById('upd-history').querySelector('tbody').innerHTML = rows ||
      '<tr><td colspan="4" class="muted">No update events recorded.</td></tr>';
    const manage = meRole === 'admin';
    document.getElementById('upd-actions').style.display = manage && s.enabled ? 'block' : 'none';
  } catch {
    panel.style.display = 'none';
  }
}

async function updPost(action, label) {
  const result = document.getElementById('upd-result');
  result.textContent = '';
  try {
    const res = await api('/api/v1/updates/' + action, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) { result.textContent = label + ' failed: ' + (body.error || res.status); result.className = 'err'; return; }
    result.textContent = body.staged ? (label + ' staged — ' + (body.release ? 'v' + body.release.version : '') + '; the supervisor applies it.').trim() : (body.reason || label + ' done');
    result.className = '';
  } catch (err) {
    result.textContent = label + ' failed: ' + err.message;
    result.className = 'err';
  }
  await refresh();
}

function updCheck() { updPost('check', 'Check'); }
function updApply() { updPost('apply', 'Apply'); }
function updRollback() { updPost('rollback', 'Rollback'); }

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

updateRole().then(() => refresh());
if (!hubKey) showSignIn();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}