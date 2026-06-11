/**
 * Admin dashboard. Password-only login (DASHBOARD_PASSWORD env); successful
 * login returns a bearer token kept in memory (restart = re-login).
 *
 * Functionality: per-contact conversation view, memory view/edit, pending
 * reply/followup inspection + cancel, manual send as the persona,
 * followup regeneration, forced memory update.
 */
import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { getChat, getMemory, setMemory } from './store.js';
import {
  statusSnapshot,
  cancelPending,
  sendManual,
  regenerateFollowup,
  forceMemoryUpdate,
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

function knownUser(req, res, next) {
  if (config.telegram.allowedUserIds.includes(req.params.id)) return next();
  res.status(404).json({ error: 'unknown contact' });
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
  :root { --bg:#0f1216; --panel:#171c22; --line:#262d36; --text:#dde3ea; --dim:#8b96a5; --accent:#4f9cf9; --me:#1d4e89; --them:#222a33; --danger:#d9534f; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.45 system-ui,sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }
  header { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
  header h1 { font-size:15px; margin:0; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:6px 12px; cursor:pointer; font:inherit; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--dim); }
  button.danger { background:var(--danger); }
  button:disabled { opacity:.5; cursor:default; }
  input, textarea { background:var(--panel); border:1px solid var(--line); border-radius:6px; color:var(--text); padding:8px 10px; font:inherit; width:100%; }
  #login { margin:auto; width:300px; display:flex; flex-direction:column; gap:10px; }
  #app { display:none; flex:1; min-height:0; }
  #app.on { display:flex; }
  aside { width:260px; border-right:1px solid var(--line); overflow-y:auto; }
  .contact { padding:12px 14px; border-bottom:1px solid var(--line); cursor:pointer; }
  .contact:hover, .contact.sel { background:var(--panel); }
  .contact .id { font-weight:600; }
  .contact .sub { color:var(--dim); font-size:12px; margin-top:2px; }
  main { flex:1; display:flex; flex-direction:column; min-width:0; }
  nav { display:flex; gap:4px; padding:8px 12px; border-bottom:1px solid var(--line); }
  nav button { background:transparent; color:var(--dim); }
  nav button.sel { background:var(--panel); color:var(--text); }
  #view { flex:1; overflow-y:auto; padding:14px; }
  .msg { max-width:62%; padding:7px 11px; border-radius:12px; margin:3px 0; white-space:pre-wrap; word-break:break-word; }
  .msg.me { background:var(--me); margin-left:auto; }
  .msg.them { background:var(--them); }
  .msg .ts { display:block; font-size:10px; color:var(--dim); margin-top:3px; }
  .pending { border:1px dashed var(--line); border-radius:10px; padding:10px 12px; margin-bottom:10px; }
  .pending b { color:var(--accent); }
  .pending .due { color:var(--dim); font-size:12px; }
  .row { display:flex; gap:8px; margin-top:8px; }
  #composer { display:flex; gap:8px; padding:10px 12px; border-top:1px solid var(--line); }
  #memText { height:60vh; font-family:ui-monospace,monospace; }
  .hint { color:var(--dim); font-size:12px; }
  #toast { position:fixed; bottom:16px; right:16px; background:var(--panel); border:1px solid var(--line); padding:10px 14px; border-radius:8px; display:none; }
</style>
</head>
<body>
<header><h1>Socrates — Persona Dashboard</h1><button id="logout" class="ghost" style="display:none">Logout</button></header>

<form id="login">
  <h2 style="margin:0;font-size:16px">Login</h2>
  <input id="pw" type="password" placeholder="Dashboard password" autofocus>
  <button>Enter</button>
  <div class="hint" id="loginErr"></div>
</form>

<div id="app">
  <aside id="contacts"></aside>
  <main>
    <nav>
      <button data-tab="chat" class="sel">Chat</button>
      <button data-tab="pending">Pending</button>
      <button data-tab="memory">Memory</button>
    </nav>
    <div id="view"><div class="hint">Select a contact.</div></div>
    <div id="composer" style="display:none">
      <input id="manualText" placeholder="Send a message as the persona (typed human-like)…">
      <button id="manualSend">Send</button>
    </div>
  </main>
</div>
<div id="toast"></div>

<script>
let token = sessionStorage.getItem('t') || null;
let contacts = {}, sel = null, tab = 'chat';

const $ = (s) => document.querySelector(s);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(m){ const t=$('#toast'); t.textContent=m; t.style.display='block'; setTimeout(()=>t.style.display='none',2500); }

async function api(path, opts={}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type':'application/json', Authorization:'Bearer '+token, ...(opts.headers||{}) } });
  if (res.status === 401) { logout(); throw new Error('session expired'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

function logout(){ token=null; sessionStorage.removeItem('t'); $('#app').classList.remove('on'); $('#login').style.display='flex'; $('#logout').style.display='none'; }

$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: $('#pw').value }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    token = data.token; sessionStorage.setItem('t', token);
    enter();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').addEventListener('click', logout);

async function enter() {
  $('#login').style.display='none'; $('#app').classList.add('on'); $('#logout').style.display='block';
  await refreshContacts();
  setInterval(refreshContacts, 15000);
}

async function refreshContacts() {
  try { contacts = await api('/api/contacts'); } catch { return; }
  const el = $('#contacts'); el.innerHTML='';
  for (const [id, c] of Object.entries(contacts)) {
    const div = document.createElement('div');
    div.className = 'contact' + (id===sel?' sel':'');
    const badges = [c.pendingReply?'⏳ reply':null, c.pendingFollowup?'📌 followup':null].filter(Boolean).join(' · ');
    div.innerHTML = '<div class="id">'+esc(id)+'</div><div class="sub">'+ (c.messagesInLog||0) +' msgs · last: '+(c.lastMessageAt? new Date(c.lastMessageAt).toLocaleString():'never') + (badges? '<br>'+badges:'') +'</div>';
    div.onclick = () => { sel=id; render(); refreshContacts(); };
    el.appendChild(div);
  }
}

document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('sel', x===b));
  render();
});

async function render() {
  const view = $('#view');
  $('#composer').style.display = sel && tab==='chat' ? 'flex' : 'none';
  if (!sel) { view.innerHTML='<div class="hint">Select a contact.</div>'; return; }

  if (tab === 'chat') {
    const chat = await api('/api/contacts/'+sel+'/chat');
    view.innerHTML = chat.map(m =>
      '<div class="msg '+(m.from==='me'?'me':'them')+'">'+esc(m.text)+'<span class="ts">'+new Date(m.ts).toLocaleString()+'</span></div>'
    ).join('') || '<div class="hint">No messages yet.</div>';
    view.scrollTop = view.scrollHeight;
  }

  if (tab === 'pending') {
    const c = contacts[sel] || {};
    let html = '';
    html += '<div class="pending"><b>Pending reply</b><br>' + (c.pendingReply
      ? esc(c.pendingReply.text || '(reaction only: '+(c.pendingReply.reaction||'')+')') + '<div class="due">due '+new Date(c.pendingReply.dueAt).toLocaleString()+'</div><div class="row"><button class="danger" onclick="cancelP(\\'reply\\')">Cancel reply</button></div>'
      : '<span class="hint">none</span>') + '</div>';
    html += '<div class="pending"><b>Pending followup</b><br>' + (c.pendingFollowup
      ? esc(c.pendingFollowup.text) + '<div class="due">due '+new Date(c.pendingFollowup.dueAt).toLocaleString()+'</div><div class="row"><button class="danger" onclick="cancelP(\\'followup\\')">Cancel followup</button><button onclick="regen()">Regenerate</button></div>'
      : '<span class="hint">none</span><div class="row"><button onclick="regen()">Plan a followup now</button></div>') + '</div>';
    view.innerHTML = html;
  }

  if (tab === 'memory') {
    const { memory } = await api('/api/contacts/'+sel+'/memory');
    view.innerHTML = '<textarea id="memText"></textarea><div class="row"><button id="memSave">Save memory</button><button class="ghost" id="memRegen">Re-distill from chat now</button></div>';
    $('#memText').value = memory;
    $('#memSave').onclick = async () => { await api('/api/contacts/'+sel+'/memory', { method:'PUT', body: JSON.stringify({ memory: $('#memText').value }) }); toast('Memory saved'); };
    $('#memRegen').onclick = async (e) => { e.target.disabled=true; try { const r = await api('/api/contacts/'+sel+'/update-memory', { method:'POST' }); $('#memText').value=r.memory; toast('Memory re-distilled'); } catch(err){ toast(err.message);} e.target.disabled=false; };
  }
}

window.cancelP = async (kind) => { await api('/api/contacts/'+sel+'/cancel', { method:'POST', body: JSON.stringify({ kind }) }); toast('Cancelled '+kind); await refreshContacts(); render(); };
window.regen = async () => { toast('Planning followup…'); try { await api('/api/contacts/'+sel+'/regenerate-followup', { method:'POST' }); toast('Followup planned'); } catch(err){ toast(err.message); } await refreshContacts(); render(); };

$('#manualSend').onclick = async () => {
  const text = $('#manualText').value.trim();
  if (!text) return;
  $('#manualSend').disabled = true; toast('Sending (human-like, may take a moment)…');
  try { await api('/api/contacts/'+sel+'/send', { method:'POST', body: JSON.stringify({ text }) }); $('#manualText').value=''; toast('Sent'); render(); }
  catch (err) { toast(err.message); }
  $('#manualSend').disabled = false;
};
$('#manualText').addEventListener('keydown', e => { if (e.key==='Enter') $('#manualSend').click(); });

if (token) enter();
</script>
</body>
</html>`;
