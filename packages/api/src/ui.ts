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
  .status.RECEIVED, .status.PARSED, .status.VALIDATED, .status.QUEUED, .status.DELIVERING { color:var(--warn); }
  .status.DUPLICATE, .status.DISCARDED { color:var(--muted); }
  pre { background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:10px; overflow:auto; max-height:280px; font-size:12px; margin:0; white-space:pre-wrap; word-break:break-all; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:6px 12px; cursor:pointer; font-family:inherit; font-size:12px; }
  .muted { color:var(--muted); }
  .detail { margin-top:12px; display:none; }
  .detail.open { display:block; }
  ul.timeline { list-style:none; padding:0; margin:0; }
  ul.timeline li { padding:3px 0; color:var(--muted); }
  ul.timeline li b { color:var(--text); }
  .col-id { color:var(--accent); }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media (max-width:700px){ .grid2 { grid-template-columns:1fr; } }
  .err { color:var(--err); }
</style>
</head>
<body>
<header>
  <h1>Integration Hub <span class="muted">// management console</span></h1>
  <span class="badge" id="health">connecting…</span>
</header>
<main>
  <section>
    <div class="panel"><h2>Dashboard</h2><div class="stats" id="stats"></div></div>
    <div class="panel">
      <h2>Devices</h2>
      <table id="devices"><thead><tr><th>Device</th><th>State</th><th>Last seen</th></tr></thead><tbody></tbody></table>
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

async function refresh() {
  try {
    const [health, stats, devices, messages] = await Promise.all([
      fetch('/api/v1/health').then(r => r.json()),
      fetch('/api/v1/stats').then(r => r.json()),
      fetch('/api/v1/devices').then(r => r.json()),
      fetch('/api/v1/messages?limit=100').then(r => r.json()),
    ]);
    const h = document.getElementById('health');
    h.textContent = health.status === 'ok' ? 'online' : 'degraded';
    h.className = 'badge ' + (health.status === 'ok' ? 'ok' : 'off');
    renderStats(stats);
    renderDevices(devices);
    renderMessages(messages);
    if (selectedId) renderDetail(selectedId);
  } catch {
    const h = document.getElementById('health');
    h.textContent = 'offline';
    h.className = 'badge off';
  }
}

function renderStats(s) {
  document.getElementById('stats').innerHTML = [
    ['Messages', s.total], ['Today', s.today], ['Failed', s.failed], ['Pending', s.pending],
  ].map(([k, v]) => '<div class="stat"><b>' + v + '</b><span>' + k + '</span></div>').join('');
}

function renderDevices(devices) {
  document.getElementById('devices').querySelector('tbody').innerHTML =
    devices.map(d =>
      '<tr><td>' + esc(d.name) + '<br/><span class="muted">' + esc(d.id) + '</span></td>' +
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
      '<td><span class="status ' + esc(m.status) + '">' + esc(m.status) + '</span></td>' +
      '<td>' + (m.payload ? m.payload.results.length : 0) + '</td>' +
      '<td class="col-id">' + esc(m.id.slice(0, 8)) + '</td></tr>'
    ).join('') || '<tr><td colspan="5" class="muted">No messages yet. Start the simulator.</td></tr>';
}

async function openDetail(id) {
  selectedId = id;
  await renderDetail(id);
}

async function renderDetail(id) {
  const m = await fetch('/api/v1/messages/' + id).then(r => r.json());
  const panel = document.getElementById('detail');
  panel.style.display = 'block';
  const errors = m.errors && m.errors.length
    ? '<div class="err">' + m.errors.map(esc).join('<br/>') + '</div>' : '';
  const records = (m.records || []).map(r =>
    '<tr><td>' + esc(r.type) + '</td><td>' + esc(r.fields.join(' | ')) + '</td></tr>').join('');
  const timeline = (m.timeline || []).map(t =>
    '<li><b>' + esc(t.stage) + '</b> ' + new Date(t.at).toLocaleTimeString() + (t.note ? ' — ' + esc(t.note) : '') + '</li>').join('');
  panel.innerHTML =
    '<h2>Message ' + esc(m.id.slice(0, 8)) + ' <span class="status ' + esc(m.status) + '">' + esc(m.status) + '</span></h2>' +
    errors +
    '<p class="muted">' + esc(m.protocol) + ' · ' + esc(m.direction) + ' · device ' + esc(m.deviceId ?? '—') + ' · ' + new Date(m.receivedAt).toLocaleString() + '</p>' +
    '<button onclick="replayMessage(\\'' + m.id + '\\')">Replay</button>' +
    '<div class="grid2" style="margin-top:12px">' +
      '<div><h2>Raw message</h2><pre>' + esc(m.raw) + '</pre></div>' +
      '<div><h2>Parsed records</h2><table><thead><tr><th>T</th><th>Fields</th></tr></thead><tbody>' + records + '</tbody></table></div>' +
    '</div>' +
    '<div class="grid2">' +
      '<div><h2>Canonical payload</h2><pre>' + esc(JSON.stringify(m.payload, null, 2)) + '</pre></div>' +
      '<div><h2>Timeline</h2><ul class="timeline">' + timeline + '</ul></div>' +
    '</div>';
}

async function replayMessage(id) {
  await fetch('/api/v1/messages/' + id + '/replay', { method: 'POST' });
  selectedId = null;
  await refresh();
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}