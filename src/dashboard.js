/**
 * Admin dashboard. Password-only login (DASHBOARD_PASSWORD env); successful
 * login returns a bearer token kept in memory (restart = re-login).
 *
 * Sections:
 *   - Contacts:  conversation view, manual send, pending reply/followup
 *                inspect + edit + send-now + cancel, memory view/edit/distill,
 *                and a danger zone to prune chat / memory / state.
 *   - Settings:  allowed accounts (or allow-all), model + media-model selection,
 *                and humanisation/behaviour knobs + global pause — all stored in
 *                settings.json (S3), no redeploy needed.
 *   - Connection: live userbot status and the full phone → code → 2FA login flow
 *                that mints & persists the Telegram session from the browser.
 */
import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { getChat, getMemory, setMemory } from './store.js';
import {
  getSettings,
  updateSettings,
  redactedSettings,
  isAllowed,
} from './settings.js';
import { listModels } from './llm.js';
import {
  connectionStatus,
  loginStart,
  loginCode,
  loginPassword,
  restart as restartTelegram,
  logout as logoutTelegram,
} from './telegram.js';
import {
  statusSnapshot,
  knownContactIds,
  cancelPending,
  sendManual,
  regenerateFollowup,
  forceMemoryUpdate,
  editPendingReply,
  sendReplyNow,
  editPendingFollowup,
  sendFollowupNow,
  pruneContact,
} from './bot.js';

const tokens = new Set();

function checkPassword(pw) {
  const a = Buffer.from(String(pw ?? ''));
  const b = Buffer.from(config.dashboard.password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function auth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token && tokens.has(token)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

async function knownUser(req, res, next) {
  const id = req.params.id;
  if (isAllowed(id)) return next();
  if ((await knownContactIds()).includes(id)) return next();
  res.status(404).json({ error: 'unknown contact' });
}

const BEHAVIOR_NUM_KEYS = [
  'typoProbability',
  'typingCharsPerSecMin',
  'typingCharsPerSecMax',
  'typingMaxSeconds',
  'typingPauseChance',
  'burstGapMinMs',
  'burstGapMaxMs',
  'onlineLingerMinMs',
  'onlineLingerMaxMs',
  'answerDelayJitter',
  'minAnswerDelaySeconds',
  'maxAnswerDelaySeconds',
  'replyTemperature',
];

function sanitizeSettingsPatch(body = {}) {
  const patch = {};
  if (Array.isArray(body.allowedUserIds)) {
    patch.allowedUserIds = [...new Set(body.allowedUserIds.map((s) => String(s).trim()).filter(Boolean))];
  }
  if (typeof body.allowAll === 'boolean') patch.allowAll = body.allowAll;
  if (typeof body.model === 'string') patch.model = body.model.trim();
  if (typeof body.mediaModel === 'string') patch.mediaModel = body.mediaModel.trim();
  if (body.behavior && typeof body.behavior === 'object') {
    const b = {};
    for (const k of BEHAVIOR_NUM_KEYS) {
      if (k in body.behavior) {
        const n = Number(body.behavior[k]);
        if (Number.isFinite(n)) b[k] = n;
      }
    }
    if (typeof body.behavior.paused === 'boolean') b.paused = body.behavior.paused;
    patch.behavior = b;
  }
  return patch;
}

export function dashboardRouter() {
  const router = express.Router();
  router.use(express.json());

  router.post('/api/login', (req, res) => {
    if (!checkPassword(req.body?.password)) {
      return res.status(401).json({ error: 'wrong password' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    tokens.add(token);
    res.json({ token });
  });

  // ── Overview / settings ───────────────────────────────────────────────────

  router.get('/api/stats', auth, async (_req, res) => {
    try {
      const ids = await knownContactIds();
      const snap = await statusSnapshot();
      let messages = 0;
      let pendingReplies = 0;
      let pendingFollowups = 0;
      for (const c of Object.values(snap)) {
        messages += c.messagesInLog || 0;
        if (c.pendingReply) pendingReplies++;
        if (c.pendingFollowup) pendingFollowups++;
      }
      res.json({
        contacts: ids.length,
        messages,
        pendingReplies,
        pendingFollowups,
        model: getSettings().model,
        mediaModel: getSettings().mediaModel,
        paused: getSettings().behavior.paused,
        timezone: config.timezone,
        uptimeSeconds: Math.round(process.uptime()),
        connection: await connectionStatus(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/settings', auth, (_req, res) => {
    res.json(redactedSettings());
  });

  router.put('/api/settings', auth, async (req, res) => {
    try {
      await updateSettings(sanitizeSettingsPatch(req.body));
      res.json(redactedSettings());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/models', auth, async (_req, res) => {
    res.json({ models: await listModels() });
  });

  // ── Connection / Telegram login ───────────────────────────────────────────

  router.get('/api/connection', auth, async (_req, res) => {
    res.json({ ...(await connectionStatus()), hasSession: Boolean(getSettings().session) });
  });

  router.post('/api/connection/login/start', auth, async (req, res) => {
    try {
      res.json(await loginStart(req.body?.phone));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/connection/login/code', auth, async (req, res) => {
    try {
      const result = await loginCode(req.body?.loginId, req.body?.code);
      if (result.status === 'authorized') return res.json(await persistSessionAndRestart(result.session));
      res.json(result); // { status: 'password_needed' }
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/connection/login/password', auth, async (req, res) => {
    try {
      const result = await loginPassword(req.body?.loginId, req.body?.password);
      res.json(await persistSessionAndRestart(result.session));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/connection/restart', auth, async (_req, res) => {
    try {
      res.json(await restartTelegram());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/connection/logout', auth, async (_req, res) => {
    try {
      await updateSettings({ session: '' });
      await logoutTelegram();
      res.json({ ok: true, ...(await connectionStatus()), hasSession: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  async function persistSessionAndRestart(session) {
    await updateSettings({ session });
    const status = await restartTelegram();
    return { status: 'authorized', ...status, hasSession: true };
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  router.get('/api/contacts', auth, async (_req, res) => {
    res.json(await statusSnapshot());
  });

  router.get('/api/contacts/:id/chat', auth, knownUser, async (req, res) => {
    res.json(await getChat(req.params.id));
  });

  router.get('/api/contacts/:id/memory', auth, knownUser, async (req, res) => {
    res.json({ memory: await getMemory(req.params.id) });
  });

  router.put('/api/contacts/:id/memory', auth, knownUser, async (req, res) => {
    await setMemory(req.params.id, String(req.body?.memory ?? ''));
    res.json({ ok: true });
  });

  router.post('/api/contacts/:id/send', auth, knownUser, async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    try {
      res.json({ sent: await sendManual(req.params.id, text) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/contacts/:id/cancel', auth, knownUser, async (req, res) => {
    const kind = req.body?.kind;
    if (!['reply', 'followup'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be reply|followup' });
    }
    await cancelPending(req.params.id, kind);
    res.json({ ok: true });
  });

  router.post('/api/contacts/:id/reply/edit', auth, knownUser, async (req, res) => {
    try {
      res.json({ pendingReply: await editPendingReply(req.params.id, req.body ?? {}) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/contacts/:id/reply/send-now', auth, knownUser, async (req, res) => {
    try {
      await sendReplyNow(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/contacts/:id/followup/edit', auth, knownUser, async (req, res) => {
    try {
      res.json({ pendingFollowup: await editPendingFollowup(req.params.id, String(req.body?.text ?? '')) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/contacts/:id/followup/send-now', auth, knownUser, async (req, res) => {
    try {
      res.json({ sent: await sendFollowupNow(req.params.id) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/contacts/:id/regenerate-followup', auth, knownUser, async (req, res) => {
    try {
      res.json({ pendingFollowup: await regenerateFollowup(req.params.id) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/contacts/:id/update-memory', auth, knownUser, async (req, res) => {
    try {
      res.json({ memory: await forceMemoryUpdate(req.params.id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/contacts/:id/reset', auth, knownUser, async (req, res) => {
    try {
      const parts = {
        chat: req.body?.chat !== false,
        memory: req.body?.memory !== false,
        state: req.body?.state !== false,
      };
      res.json({ reset: await pruneContact(req.params.id, parts) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/', (_req, res) => {
    res.type('html').send(PAGE);
  });

  return router;
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Socrates — Dashboard</title>
<style>
  :root { --bg:#0f1216; --panel:#171c22; --panel2:#1d242c; --line:#262d36; --text:#dde3ea; --dim:#8b96a5; --accent:#4f9cf9; --me:#1d4e89; --them:#222a33; --danger:#d9534f; --ok:#3fb950; --warn:#d29922; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.45 system-ui,sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }
  header { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:12px; }
  header h1 { font-size:15px; margin:0; white-space:nowrap; }
  header .meta { display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
  .badge { font-size:12px; padding:3px 8px; border-radius:999px; border:1px solid var(--line); color:var(--dim); white-space:nowrap; }
  .badge.on { color:var(--ok); border-color:#1f4d2c; }
  .badge.off { color:var(--danger); border-color:#52312f; }
  .badge.warn { color:var(--warn); border-color:#5a4a1f; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:6px 12px; cursor:pointer; font:inherit; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--dim); }
  button.danger { background:var(--danger); }
  button.warn { background:var(--warn); color:#1a1a1a; }
  button.sm { padding:4px 9px; font-size:12px; }
  button:disabled { opacity:.5; cursor:default; }
  input, textarea, select { background:var(--panel); border:1px solid var(--line); border-radius:6px; color:var(--text); padding:8px 10px; font:inherit; width:100%; }
  label.fld { display:block; margin:10px 0 4px; color:var(--dim); font-size:12px; }
  #login { margin:auto; width:300px; display:flex; flex-direction:column; gap:10px; }
  #app { display:none; flex:1; min-height:0; }
  #app.on { display:flex; }
  nav.side { width:120px; border-right:1px solid var(--line); display:flex; flex-direction:column; padding:8px; gap:4px; flex-shrink:0; }
  nav.side button { background:transparent; color:var(--dim); text-align:left; }
  nav.side button.sel { background:var(--panel); color:var(--text); }
  .view { flex:1; display:flex; min-width:0; }
  aside { width:280px; border-right:1px solid var(--line); overflow-y:auto; flex-shrink:0; }
  .contact { padding:11px 14px; border-bottom:1px solid var(--line); cursor:pointer; }
  .contact:hover, .contact.sel { background:var(--panel); }
  .contact .id { font-weight:600; display:flex; justify-content:space-between; gap:6px; }
  .contact .sub { color:var(--dim); font-size:12px; margin-top:2px; }
  .tag { font-size:10px; color:var(--dim); border:1px solid var(--line); border-radius:4px; padding:0 4px; }
  main { flex:1; display:flex; flex-direction:column; min-width:0; }
  .tabs { display:flex; gap:4px; padding:8px 12px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .tabs button { background:transparent; color:var(--dim); }
  .tabs button.sel { background:var(--panel); color:var(--text); }
  .scroll { flex:1; overflow-y:auto; padding:14px; }
  .pane { max-width:760px; }
  .msg { max-width:62%; padding:7px 11px; border-radius:12px; margin:3px 0; white-space:pre-wrap; word-break:break-word; }
  .msg.me { background:var(--me); margin-left:auto; }
  .msg.them { background:var(--them); }
  .msg.react { background:transparent; border:1px dashed var(--line); color:var(--dim); font-size:12px; }
  .msg .ts { display:block; font-size:10px; color:var(--dim); margin-top:3px; }
  .card { border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:12px; background:var(--panel); }
  .card.dashed { border-style:dashed; background:transparent; }
  .card h3 { margin:0 0 8px; font-size:13px; color:var(--accent); }
  .card .due { color:var(--dim); font-size:12px; margin:4px 0; }
  .row { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:8px 14px; }
  #composer { display:flex; gap:8px; padding:10px 12px; border-top:1px solid var(--line); }
  .memText { height:48vh; font-family:ui-monospace,monospace; }
  .hint { color:var(--dim); font-size:12px; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .chip { background:var(--panel2); border:1px solid var(--line); border-radius:999px; padding:3px 10px; display:flex; gap:6px; align-items:center; font-size:12px; }
  .chip button { background:transparent; color:var(--danger); padding:0; font-size:14px; line-height:1; }
  .switch { display:flex; align-items:center; gap:8px; }
  #toast { position:fixed; bottom:16px; right:16px; background:var(--panel); border:1px solid var(--line); padding:10px 14px; border-radius:8px; display:none; max-width:360px; }
  code.k { color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Socrates — Persona Dashboard</h1>
  <div class="meta" id="headerMeta"></div>
</header>

<form id="login">
  <h2 style="margin:0;font-size:16px">Login</h2>
  <input id="pw" type="password" placeholder="Dashboard password" autofocus>
  <button>Enter</button>
  <div class="hint" id="loginErr"></div>
</form>

<div id="app">
  <nav class="side" id="sidenav">
    <button data-view="contacts" class="sel">Contacts</button>
    <button data-view="settings">Settings</button>
    <button data-view="connection">Connection</button>
  </nav>
  <div class="view" id="viewRoot"></div>
</div>
<div id="toast"></div>

<script>
var token = sessionStorage.getItem('t') || null;
var contacts = {}, sel = null, tab = 'chat', viewMode = 'contacts';
var stats = null, settings = null, models = [], login = { id:null, stage:null };

function $(s){ return document.querySelector(s); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function toast(m){ var t=$('#toast'); t.textContent=m; t.style.display='block'; clearTimeout(t._h); t._h=setTimeout(function(){ t.style.display='none'; },2800); }
function fmtTime(t){ return t ? new Date(t).toLocaleString() : 'never'; }

async function api(path, opts){
  opts = opts || {};
  var res = await fetch(path, Object.assign({}, opts, { headers: Object.assign({ 'Content-Type':'application/json', Authorization:'Bearer '+token }, opts.headers||{}) }));
  if (res.status === 401){ logout(); throw new Error('session expired'); }
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

function logout(){ token=null; sessionStorage.removeItem('t'); $('#app').classList.remove('on'); $('#login').style.display='flex'; }

$('#login').addEventListener('submit', async function(e){
  e.preventDefault();
  try {
    var res = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: $('#pw').value }) });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error);
    token = data.token; sessionStorage.setItem('t', token);
    enter();
  } catch (err){ $('#loginErr').textContent = err.message; }
});

async function enter(){
  $('#login').style.display='none'; $('#app').classList.add('on');
  await refresh();
  if (!window._poll) window._poll = setInterval(refresh, 10000);
}

document.querySelectorAll('#sidenav button').forEach(function(b){
  b.onclick = function(){
    viewMode = b.dataset.view;
    document.querySelectorAll('#sidenav button').forEach(function(x){ x.classList.toggle('sel', x===b); });
    renderView();
  };
});

async function refresh(){
  try { stats = await api('/api/stats'); } catch(e){ return; }
  try { contacts = await api('/api/contacts'); } catch(e){}
  renderHeader();
  // Only the contacts sidebar is safe to auto-refresh. The Settings & Connection
  // views hold live form state (and a login flow), so the 10s poll must NOT
  // re-render them — they update on explicit actions instead.
  if (viewMode === 'contacts') renderContactsSidebar();
}

function renderHeader(){
  var c = stats && stats.connection || {};
  var conn = c.authorized ? '<span class="badge on">online as '+esc((c.me&&(c.me.firstName||c.me.username))||'account')+'</span>'
            : (c.connected ? '<span class="badge warn">not logged in</span>' : '<span class="badge off">disconnected</span>');
  var paused = stats && stats.paused ? '<span class="badge warn">PAUSED</span>' : '<span class="badge on">live</span>';
  var model = '<span class="badge">'+esc((stats&&stats.model)||'no model')+'</span>';
  $('#headerMeta').innerHTML = conn + ' ' + paused + ' ' + model +
    ' <button class="ghost sm" id="pauseBtn">'+(stats&&stats.paused?'Resume':'Pause')+'</button>' +
    ' <button class="ghost sm" id="logoutBtn">Logout</button>';
  $('#logoutBtn').onclick = logout;
  $('#pauseBtn').onclick = async function(){
    try { await api('/api/settings', { method:'PUT', body: JSON.stringify({ behavior:{ paused: !(stats&&stats.paused) } }) }); toast('Updated'); await refresh(); }
    catch(err){ toast(err.message); }
  };
}

function renderView(){
  var root = $('#viewRoot');
  if (viewMode === 'contacts') return renderContacts(root);
  if (viewMode === 'settings') return renderSettings(root);
  if (viewMode === 'connection') return renderConnection(root);
}

// ── Contacts ────────────────────────────────────────────────────────────────

function renderContacts(root){
  if (!root.querySelector('#contacts')){
    root.innerHTML = '<aside id="contacts"></aside><main>'
      + '<div class="tabs" id="tabs">'
      + '<button data-tab="chat" class="sel">Chat</button>'
      + '<button data-tab="pending">Pending</button>'
      + '<button data-tab="memory">Memory</button>'
      + '<button data-tab="danger">Reset</button>'
      + '</div>'
      + '<div class="scroll" id="cview"><div class="hint">Select a contact.</div></div>'
      + '<div id="composer" style="display:none"><input id="manualText" placeholder="Send a message as the persona (typed human-like)…"><button id="manualSend">Send</button></div>'
      + '</main>';
    root.querySelectorAll('#tabs button').forEach(function(b){
      b.onclick = function(){ tab=b.dataset.tab; root.querySelectorAll('#tabs button').forEach(function(x){ x.classList.toggle('sel', x===b); }); renderContactMain(); };
    });
    $('#manualSend').onclick = manualSend;
    $('#manualText').addEventListener('keydown', function(e){ if(e.key==='Enter') manualSend(); });
  }
  renderContactsSidebar();
  renderContactMain();
}

function renderContactsSidebar(){
  var el = $('#contacts'); if (!el) return;
  var ids = Object.keys(contacts);
  if (!ids.length){ el.innerHTML = '<div class="hint" style="padding:14px">No contacts yet. They appear once someone messages, or add allowed IDs in Settings.</div>'; return; }
  el.innerHTML = ids.map(function(id){
    var c = contacts[id];
    var badges = [c.pendingReply?'⏳ reply':null, c.pendingFollowup?'📌 followup':null].filter(Boolean).join(' · ');
    var name = c.name ? esc(c.name) : esc(id);
    return '<div class="contact'+(id===sel?' sel':'')+'" data-id="'+esc(id)+'">'
      + '<div class="id"><span>'+name+'</span>'+(c.configured?'<span class="tag">allowed</span>':'')+'</div>'
      + '<div class="sub">'+(c.name?esc(id)+' · ':'')+(c.messagesInLog||0)+' msgs · '+fmtTime(c.lastMessageAt)+(badges?'<br>'+badges:'')+'</div></div>';
  }).join('');
  el.querySelectorAll('.contact').forEach(function(d){ d.onclick = function(){ sel=d.dataset.id; renderContactsSidebar(); renderContactMain(); }; });
}

async function renderContactMain(){
  var view = $('#cview'); if (!view) return;
  $('#composer').style.display = sel && tab==='chat' ? 'flex' : 'none';
  if (!sel){ view.innerHTML='<div class="hint">Select a contact.</div>'; return; }
  var c = contacts[sel] || {};

  if (tab === 'chat'){
    var chat = await api('/api/contacts/'+sel+'/chat');
    view.innerHTML = chat.map(function(m){
      var cls = m.type==='reaction' ? 'react' : (m.from==='me'?'me':'them');
      return '<div class="msg '+cls+'">'+esc(m.text)+'<span class="ts">'+fmtTime(m.ts)+'</span></div>';
    }).join('') || '<div class="hint">No messages yet.</div>';
    view.scrollTop = view.scrollHeight;
  }

  if (tab === 'pending'){
    var html = '<div class="pane">';
    if (c.pendingReply){
      html += '<div class="card"><h3>Pending reply</h3>'
        + '<textarea id="rEdit" rows="3">'+esc(c.pendingReply.text||'')+'</textarea>'
        + '<label class="fld">Reaction (emoji, optional)</label><input id="rReact" value="'+esc(c.pendingReply.reaction||'')+'">'
        + '<div class="due">due '+fmtTime(c.pendingReply.dueAt)+'</div>'
        + '<div class="row"><button class="sm" onclick="saveReply()">Save</button><button class="sm warn" onclick="sendReplyNow()">Send now</button><button class="sm danger" onclick="cancelP(\\'reply\\')">Cancel</button></div></div>';
    } else {
      html += '<div class="card dashed"><h3>Pending reply</h3><span class="hint">none</span></div>';
    }
    if (c.pendingFollowup){
      html += '<div class="card"><h3>Pending followup</h3>'
        + '<textarea id="fEdit" rows="3">'+esc(c.pendingFollowup.text||'')+'</textarea>'
        + '<div class="due">due '+fmtTime(c.pendingFollowup.dueAt)+'</div>'
        + '<div class="row"><button class="sm" onclick="saveFollowup()">Save</button><button class="sm warn" onclick="sendFollowupNow()">Send now</button><button class="sm" onclick="regen()">Regenerate</button><button class="sm danger" onclick="cancelP(\\'followup\\')">Cancel</button></div></div>';
    } else {
      html += '<div class="card dashed"><h3>Pending followup</h3><span class="hint">none</span><div class="row"><button class="sm" onclick="regen()">Plan a followup now</button></div></div>';
    }
    html += '</div>';
    view.innerHTML = html;
  }

  if (tab === 'memory'){
    var mem = await api('/api/contacts/'+sel+'/memory');
    view.innerHTML = '<div class="pane"><textarea id="memText" class="memText"></textarea>'
      + '<div class="row"><button onclick="saveMem()">Save memory</button><button class="ghost" onclick="redistill(this)">Re-distill from chat now</button></div></div>';
    $('#memText').value = mem.memory || '';
  }

  if (tab === 'danger'){
    view.innerHTML = '<div class="pane"><div class="card"><h3>Reset this conversation</h3>'
      + '<p class="hint">Permanently delete stored data for this contact so the persona starts fresh. This cannot be undone.</p>'
      + '<div class="row">'
      + '<button class="warn sm" onclick="resetContact({chat:true,memory:false,state:true})">Clear chat history</button>'
      + '<button class="warn sm" onclick="resetContact({chat:false,memory:true,state:false})">Clear memory</button>'
      + '<button class="danger sm" onclick="resetContact({chat:true,memory:true,state:true})">Full wipe (chat + memory + timers)</button>'
      + '</div></div></div>';
  }
}

async function manualSend(){
  var text = $('#manualText').value.trim(); if (!text || !sel) return;
  $('#manualSend').disabled = true; toast('Sending (human-like, may take a moment)…');
  try { await api('/api/contacts/'+sel+'/send', { method:'POST', body: JSON.stringify({ text }) }); $('#manualText').value=''; toast('Sent'); renderContactMain(); }
  catch (err){ toast(err.message); }
  $('#manualSend').disabled = false;
}

window.cancelP = async function(kind){ await api('/api/contacts/'+sel+'/cancel', { method:'POST', body: JSON.stringify({ kind }) }); toast('Cancelled '+kind); await refresh(); renderContactMain(); };
window.regen = async function(){ toast('Planning followup…'); try { await api('/api/contacts/'+sel+'/regenerate-followup', { method:'POST' }); toast('Followup planned'); } catch(err){ toast(err.message); } await refresh(); renderContactMain(); };
window.saveReply = async function(){ try { await api('/api/contacts/'+sel+'/reply/edit', { method:'POST', body: JSON.stringify({ text: $('#rEdit').value, reaction: $('#rReact').value.trim() }) }); toast('Reply updated'); await refresh(); renderContactMain(); } catch(err){ toast(err.message); } };
window.sendReplyNow = async function(){ try { await api('/api/contacts/'+sel+'/reply/send-now', { method:'POST' }); toast('Reply sent'); await refresh(); renderContactMain(); } catch(err){ toast(err.message); } };
window.saveFollowup = async function(){ try { await api('/api/contacts/'+sel+'/followup/edit', { method:'POST', body: JSON.stringify({ text: $('#fEdit').value }) }); toast('Followup updated'); await refresh(); renderContactMain(); } catch(err){ toast(err.message); } };
window.sendFollowupNow = async function(){ try { await api('/api/contacts/'+sel+'/followup/send-now', { method:'POST' }); toast('Followup sent'); await refresh(); renderContactMain(); } catch(err){ toast(err.message); } };
window.saveMem = async function(){ await api('/api/contacts/'+sel+'/memory', { method:'PUT', body: JSON.stringify({ memory: $('#memText').value }) }); toast('Memory saved'); };
window.redistill = async function(btn){ btn.disabled=true; try { var r = await api('/api/contacts/'+sel+'/update-memory', { method:'POST' }); $('#memText').value=r.memory; toast('Memory re-distilled'); } catch(err){ toast(err.message); } btn.disabled=false; };
window.resetContact = async function(parts){
  var label = parts.chat&&parts.memory ? 'FULL WIPE' : (parts.memory?'clear memory':'clear chat history');
  if (!confirm('Confirm '+label+' for '+sel+'? This cannot be undone.')) return;
  try { await api('/api/contacts/'+sel+'/reset', { method:'POST', body: JSON.stringify(parts) }); toast('Done'); await refresh(); renderContactMain(); } catch(err){ toast(err.message); }
};

// ── Settings ─────────────────────────────────────────────────────────────────

async function renderSettings(root){
  if (!settings) { try { settings = await api('/api/settings'); } catch(e){} }
  if (!models.length){ try { var r = await api('/api/models'); models = r.models||[]; } catch(e){} }
  var s = settings || {};
  var b = s.behavior || {};

  function modelOptions(current){
    var opts = '<option value="">— none —</option>';
    var found = false;
    models.forEach(function(m){ if (m.id===current) found=true; opts += '<option value="'+esc(m.id)+'"'+(m.id===current?' selected':'')+'>'+esc(m.id)+'</option>'; });
    if (current && !found) opts = '<option value="'+esc(current)+'" selected>'+esc(current)+' (custom)</option>' + opts;
    return opts;
  }
  function numField(key, label, step){ return '<div><label class="fld">'+label+'</label><input type="number" step="'+(step||'1')+'" id="b_'+key+'" value="'+esc(b[key])+'"></div>'; }

  root.innerHTML = '<div class="scroll"><div class="pane">'
    + '<div class="card"><h3>Allowed contacts</h3>'
    + '<div class="switch"><input type="checkbox" id="allowAll" style="width:auto"'+(s.allowAll?' checked':'')+'><label for="allowAll">Allow <b>everyone</b> who messages (ignore the list below)</label></div>'
    + '<label class="fld">Allowed Telegram user IDs</label>'
    + '<div class="row"><input id="newId" placeholder="e.g. 11111111" style="flex:1"><button class="sm" onclick="addId()">Add</button></div>'
    + '<div class="chips" id="idChips"></div></div>'

    + '<div class="card"><h3>Models</h3>'
    + '<label class="fld">Main model (replies, memory)</label><select id="modelSel">'+modelOptions(s.model)+'</select>'
    + '<label class="fld">Or type a custom model slug</label><input id="modelCustom" placeholder="provider/model" value="">'
    + '<label class="fld">Media model (vision + audio for photos / voice)</label><select id="mediaSel">'+modelOptions(s.mediaModel)+'</select>'
    + '<label class="fld">Or type a custom media model slug</label><input id="mediaCustom" placeholder="provider/model" value="">'
    + '<div class="hint" style="margin-top:8px">'+models.length+' models available from OpenRouter.</div></div>'

    + '<div class="card"><h3>Behaviour & humanisation</h3>'
    + '<div class="switch" style="margin-bottom:8px"><input type="checkbox" id="paused" style="width:auto"'+(b.paused?' checked':'')+'><label for="paused">Pause auto-replies & followups (global kill-switch)</label></div>'
    + '<div class="grid2">'
    + numField('typoProbability','Typo probability (0–1)','0.01')
    + numField('replyTemperature','Reply temperature','0.05')
    + numField('typingCharsPerSecMin','Typing speed min (chars/s)','0.5')
    + numField('typingCharsPerSecMax','Typing speed max (chars/s)','0.5')
    + numField('typingMaxSeconds','Max typing seconds','1')
    + numField('typingPauseChance','Pause-while-typing chance (0–1)','0.05')
    + numField('burstGapMinMs','Burst gap min (ms)','100')
    + numField('burstGapMaxMs','Burst gap max (ms)','100')
    + numField('onlineLingerMinMs','Online linger min (ms)','500')
    + numField('onlineLingerMaxMs','Online linger max (ms)','500')
    + numField('answerDelayJitter','Answer delay jitter (±frac)','0.01')
    + numField('minAnswerDelaySeconds','Min answer delay (s)','1')
    + numField('maxAnswerDelaySeconds','Max answer delay (s)','60')
    + '</div></div>'

    + '<div class="row"><button onclick="saveSettings()">Save settings</button><button class="ghost" onclick="settings=null;renderView()">Reload</button></div>'
    + '</div></div>';
  renderIdChips();
}

function renderIdChips(){
  var el = $('#idChips'); if (!el) return;
  var ids = (settings.allowedUserIds||[]);
  el.innerHTML = ids.length ? ids.map(function(id){ return '<span class="chip">'+esc(id)+'<button onclick="removeId(\\''+esc(id)+'\\')">×</button></span>'; }).join('') : '<span class="hint">none</span>';
}
window.addId = function(){ var v = $('#newId').value.trim(); if(!v) return; settings.allowedUserIds = settings.allowedUserIds||[]; if (settings.allowedUserIds.indexOf(v)<0) settings.allowedUserIds.push(v); $('#newId').value=''; renderIdChips(); };
window.removeId = function(id){ settings.allowedUserIds = (settings.allowedUserIds||[]).filter(function(x){ return x!==id; }); renderIdChips(); };

window.saveSettings = async function(){
  var b = {};
  ['typoProbability','replyTemperature','typingCharsPerSecMin','typingCharsPerSecMax','typingMaxSeconds','typingPauseChance','burstGapMinMs','burstGapMaxMs','onlineLingerMinMs','onlineLingerMaxMs','answerDelayJitter','minAnswerDelaySeconds','maxAnswerDelaySeconds'].forEach(function(k){ b[k] = Number($('#b_'+k).value); });
  b.paused = $('#paused').checked;
  var model = $('#modelCustom').value.trim() || $('#modelSel').value;
  var mediaModel = $('#mediaCustom').value.trim() || $('#mediaSel').value;
  var body = { allowAll: $('#allowAll').checked, allowedUserIds: settings.allowedUserIds||[], model: model, mediaModel: mediaModel, behavior: b };
  try { settings = await api('/api/settings', { method:'PUT', body: JSON.stringify(body) }); toast('Settings saved'); await refresh(); renderView(); }
  catch(err){ toast(err.message); }
};

// ── Connection ────────────────────────────────────────────────────────────────

async function renderConnection(root){
  var conn = {};
  try { conn = await api('/api/connection'); } catch(e){}
  var statusHtml;
  if (conn.authorized){
    var me = conn.me||{};
    statusHtml = '<span class="badge on">Authorised</span> as <b>'+esc([me.firstName,me.lastName].filter(Boolean).join(' ')||me.username||me.id)+'</b>'
      + (me.username?' (@'+esc(me.username)+')':'') + (me.phone?' · '+esc(me.phone):'') + ' · id '+esc(me.id);
  } else if (conn.hasSession){
    statusHtml = '<span class="badge warn">Session present but not authorised</span> '+(conn.error?esc(conn.error):'')+' — try restart, or log in again.';
  } else {
    statusHtml = '<span class="badge off">No session</span> — log in below to authorise the persona account.';
  }

  var loginHtml = '';
  if (!login.stage || login.stage==='phone'){
    loginHtml = '<label class="fld">Phone number (international, e.g. +85291234567)</label>'
      + '<div class="row"><input id="lPhone" placeholder="+8529..." style="flex:1"><button class="sm" onclick="loginStart()">Send code</button></div>';
  } else if (login.stage==='code'){
    loginHtml = '<p class="hint">Code sent to '+esc(login.phone)+'. Enter it below.</p>'
      + '<label class="fld">Login code</label><div class="row"><input id="lCode" placeholder="12345" style="flex:1"><button class="sm" onclick="loginCode()">Verify</button><button class="sm ghost" onclick="loginReset()">Cancel</button></div>';
  } else if (login.stage==='password'){
    loginHtml = '<p class="hint">This account has 2FA enabled. Enter the cloud password.</p>'
      + '<label class="fld">2FA password</label><div class="row"><input id="lPass" type="password" style="flex:1"><button class="sm" onclick="loginPass()">Submit</button><button class="sm ghost" onclick="loginReset()">Cancel</button></div>';
  }

  root.innerHTML = '<div class="scroll"><div class="pane">'
    + '<div class="card"><h3>Userbot status</h3><div>'+statusHtml+'</div>'
    + '<div class="row"><button class="sm ghost" onclick="connRestart()">Restart connection</button>'
    + (conn.hasSession?'<button class="sm danger" onclick="connLogout()">Log out / clear session</button>':'')+'</div></div>'
    + '<div class="card"><h3>Log in this account</h3>'
    + '<p class="hint">Authorises a real Telegram user account for the persona — phone, the code Telegram sends, then a 2FA password if set. The session is stored in settings.json (S3); no env var or redeploy needed.</p>'
    + loginHtml + '</div>'
    + '<div class="hint">Tip: use a dedicated number the persona owns. The session is full account access — keep this dashboard password strong.</div>'
    + '</div></div>';
}

window.loginStart = async function(){
  var phone = $('#lPhone').value.trim(); if(!phone) return toast('Enter a phone number');
  toast('Sending code…');
  try { var r = await api('/api/connection/login/start', { method:'POST', body: JSON.stringify({ phone }) }); login = { id:r.loginId, stage:'code', phone:phone }; renderView(); }
  catch(err){ toast(err.message); }
};
window.loginCode = async function(){
  var code = $('#lCode').value.trim(); if(!code) return;
  toast('Verifying…');
  try {
    var r = await api('/api/connection/login/code', { method:'POST', body: JSON.stringify({ loginId: login.id, code }) });
    if (r.status==='password_needed'){ login.stage='password'; renderView(); return; }
    login = { id:null, stage:null }; toast('Logged in'); await refresh(); renderView();
  } catch(err){ toast(err.message); }
};
window.loginPass = async function(){
  var password = $('#lPass').value; if(!password) return;
  toast('Submitting…');
  try { await api('/api/connection/login/password', { method:'POST', body: JSON.stringify({ loginId: login.id, password }) }); login={ id:null, stage:null }; toast('Logged in'); await refresh(); renderView(); }
  catch(err){ toast(err.message); }
};
window.loginReset = function(){ login = { id:null, stage:null }; renderView(); };
window.connRestart = async function(){ toast('Restarting…'); try { await api('/api/connection/restart', { method:'POST' }); toast('Restarted'); await refresh(); renderView(); } catch(err){ toast(err.message); } };
window.connLogout = async function(){ if(!confirm('Clear the Telegram session? The persona goes offline until you log in again.')) return; try { await api('/api/connection/logout', { method:'POST' }); toast('Logged out'); await refresh(); renderView(); } catch(err){ toast(err.message); } };

// boot
renderView();
if (token) enter();
</script>
</body>
</html>`;
