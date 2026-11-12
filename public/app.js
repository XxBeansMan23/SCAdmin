'use strict';
/* CrewAdmin front-end (no build step, no dependencies) */
const $ = (s, e = document) => e.querySelector(s);
const $$ = (s, e = document) => [...e.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmt(d) {
  if (!d) return '—';
  const x = new Date(d), p = n => String(n).padStart(2, '0');
  let h = x.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${p(x.getUTCDate())}-${MON[x.getUTCMonth()]}-${x.getUTCFullYear()} ${p(h)}:${p(x.getUTCMinutes())}:${p(x.getUTCSeconds())} ${ap} UTC`;
}
const num = n => (+n || 0).toLocaleString();
const S = { me: null, games: [], view: 'members', uid: null, tab: 'details', logTab: 'all', edit: false, crewId: null, cur: null,
  mq: '', smUser: '', smGame: 'gtav', auditCat: 'all', auditQ: '', flagCount: 0 };

async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: { 'X-Requested-With': 'crewadmin', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = {}; try { j = await r.json(); } catch { /* non-json */ }
  if (!r.ok) {
    if (r.status === 401 && S.me && url !== '/api/login') { S.me = null; boot(); }
    throw new Error(j.error || 'HTTP ' + r.status);
  }
  return j;
}
let toastT;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => t.className = '', 3200);
}
const isAdmin = () => S.me && (S.me.role === 'owner' || S.me.role === 'admin');
const av = (u, cls = '') => `<span class="av ${cls}" style="background:${esc(u.color || '#888')}">${esc((u.nickname || '?')[0].toUpperCase())}</span>`;
const statusPill = u => u.status === 'banned' ? '<span class="pill bad">BANNED</span>' : u.status === 'suspended' ? '<span class="pill warn">SUSPENDED</span>' : '<span class="pill ok">Active</span>';
const rolePill = r => `<span class="pill ${r === 'owner' ? 'acc' : ''}">${esc(r)}</span>`;
const logo = '<span class="logo"><b>SC</b>Admin</span>';
let chatTimer = null;
const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>').replace(/\n/g, '<br>');
const sizeFmt = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

// ------------------------------------------------------------------ boot / auth
async function boot() {
  const app = $('#app');
  try {
    const st = await api('GET', '/api/status');
    if (st.needsSetup) return renderSetup();
    S.me = await api('GET', '/api/me');
  } catch { S.me = null; }
  if (!S.me) return renderLogin();
  S.games = await api('GET', '/api/games');
  ensureGameTabs();
  if (!isAdmin()) { S.view = 'chat'; S.uid = S.me.id; } else if (!['dashboard', 'chat', 'members', 'user', 'crews', 'crew', 'statmaster', 'moderation', 'audit'].includes(S.view)) S.view = 'dashboard';
  if (isAdmin() && S.view === 'members' && !S.uid) S.view = 'dashboard';
  app.innerHTML = '';
  render();
}
function renderLogin() {
  $('#app').innerHTML = `<div class="auth"><div class="hd">${logo}</div><div class="bd">
    <form data-form="login"><label>Nickname or email</label><input name="login" autocomplete="username" required autofocus>
    <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
    <div class="err" id="err"></div><button class="btn pri" style="width:100%;margin-top:6px">Sign in</button></form>
    <p class="muted" style="margin-bottom:0">Private panel. Ask the owner for an account.</p>
    <p class="muted" style="font-size:11px;margin:10px 0 0">Independent hobby project. Not affiliated with Rockstar Games.</p></div></div>`;
}
function renderSetup() {
  $('#app').innerHTML = `<div class="auth"><div class="hd">${logo}</div><div class="bd">
    <h1 style="color:#222;margin-top:12px">First-time setup</h1><p class="muted">Create the owner account. The setup code is printed in the server console.</p>
    <form data-form="setup"><label>Setup code</label><input name="code" required>
    <label>Nickname</label><input name="nickname" required minlength="3" maxlength="24">
    <label>Email</label><input name="email" type="email" required>
    <label>Password (8+ characters)</label><input name="password" type="password" required minlength="8" autocomplete="new-password">
    <div class="err" id="err"></div><button class="btn pri" style="width:100%;margin-top:6px">Create owner account</button></form></div></div>`;
}

// ------------------------------------------------------------------ shell
const NAV = [
  ['dashboard', '⌂', 'Dashboard', true], ['chat', '✉', 'Chat', false], ['members', '☰', 'Members', true], ['crews', '⚑', 'Crews', false],
  ['statmaster', '▤', 'StatMaster', true], ['moderation', '⚠', 'Moderation', true], ['audit', '≡', 'Audit log', true], ['mine', '☺', 'My profile', false],
];
function shell() {
  if ($('#content')) return;
  $('#app').innerHTML = `<div class="top">${logo}
    <div class="search"><span class="lbl">Members search ▾</span><input id="q" placeholder="Enter your search query" autocomplete="off"><div class="results" id="results" hidden></div></div>
    <div class="me"><span>${esc(S.me.nickname)} ${rolePill(S.me.role)}</span><button class="btn sm" data-act="logout">Sign out</button></div></div>
    <div class="shell"><nav class="side" id="nav"></nav><main class="main" id="content"></main></div>`;
  $('#q').addEventListener('input', searchBox);
  $('#q').addEventListener('focus', searchBox);
  if (!isAdmin()) $('.search').style.visibility = 'hidden';
}
async function updateNav() {
  if (isAdmin()) { try { S.flagCount = (await api('GET', '/api/flags?status=open')).length; } catch { /* ignore */ } }
  try { S.unread = (await api('GET', '/api/chat/channels')).reduce((a, c) => a + c.unread, 0); } catch { /* ignore */ }
  const cur = S.view === 'user' && S.uid === S.me.id ? 'mine' : S.view === 'crew' ? 'crews' : S.view === 'user' ? 'members' : S.view;
  const badge = n => n[0] === 'moderation' && S.flagCount ? S.flagCount : n[0] === 'chat' && S.unread ? S.unread : 0;
  $('#nav').innerHTML = NAV.filter(n => !n[3] || isAdmin()).map(n =>
    `<button class="${cur === n[0] ? 'on' : ''}" title="${n[2]}" data-act="nav" data-v="${n[0]}">${n[1]}${badge(n) ? `<span class="dot">${badge(n)}</span>` : ''}</button>`).join('');
}
setInterval(() => { if (S.me && $('#nav') && S.view !== 'chat') updateNav(); }, 20000);
function go(view, extra = {}) { Object.assign(S, { view }, extra); render(); }
async function render() {
  shell();
  clearInterval(chatTimer);
  const c = $('#content');
  try {
    const html = await views[S.view]();
    c.innerHTML = html;
    if (afterRender[S.view]) afterRender[S.view]();
  } catch (e) { c.innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
  updateNav();
}
let searchT;
function searchBox() {
  clearTimeout(searchT);
  searchT = setTimeout(async () => {
    const q = $('#q').value.trim(), box = $('#results');
    if (!q) { box.hidden = true; return; }
    const list = (await api('GET', '/api/users?q=' + encodeURIComponent(q))).slice(0, 8);
    box.innerHTML = list.length ? list.map(u => `<div class="it" data-act="openUser" data-id="${u.id}">${av(u)}<div><b>${esc(u.nickname)}</b><br><span class="muted">${esc(u.email)}</span></div><span style="margin-left:auto">${statusPill(u)}</span></div>`).join('') : '<div class="it muted">No members found</div>';
    box.hidden = false;
  }, 180);
}
document.addEventListener('click', e => { if (!e.target.closest('.search')) { const b = $('#results'); if (b) b.hidden = true; } });

// ------------------------------------------------------------------ views
const views = {
  async dashboard() {
    const o = await api('GET', '/api/overview');
    return `<h2 class="page-title">Dashboard</h2>
    <div class="stats"><div class="stat"><b>${o.members}</b>Members</div><div class="stat"><b>${o.crews}</b>Crews</div>
    <div class="stat"><b>${num(o.hours)}</b>Hours logged</div><div class="stat"><b>${o.saves}</b>Cloud saves</div>
    <div class="stat"><b>${o.restricted}</b>Restricted accounts</div><div class="stat"><b>${o.openFlags}</b>Open flags</div></div>
    <div class="card"><h3>Recent activity</h3><table><tr><th>When</th><th>Member</th><th>Action</th><th>By</th></tr>
    ${o.recent.map(l => `<tr class="click" data-act="openUser" data-id="${l.userId}"><td>${fmt(l.at)}</td><td>${esc(l.nickname)}</td><td>${esc(l.action)} <span class="muted">${esc(l.detail)}</span></td><td>${esc(l.by)}</td></tr>`).join('')}</table></div>`;
  },

  async members() {
    const list = (await api('GET', '/api/users?q=' + encodeURIComponent(S.mq)));
    return `<h2 class="page-title">Members</h2>
    <div class="card"><h3>All members (${list.length})</h3><div class="bd"><input id="mq" placeholder="Filter by nickname, email, linked account or crew" value="${esc(S.mq)}"></div>
    <table><tr><th></th><th>Nickname</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th></tr>
    ${list.map(u => `<tr class="click" data-act="openUser" data-id="${u.id}"><td>${av(u)}</td><td><b>${esc(u.nickname)}</b></td><td>${esc(u.email)}</td><td>${rolePill(u.role)}</td><td>${statusPill(u)}</td><td>${fmt(u.lastLogin)}</td></tr>`).join('')}</table></div>
    <div class="card"><h3>Add member</h3><div class="bd"><form data-form="addMember" class="grid2">
      <div><label>Nickname</label><input name="nickname" required minlength="3" maxlength="24"></div>
      <div><label>Email</label><input name="email" type="email" required></div>
      <div><label>Temporary password (8+)</label><input name="password" required minlength="8"></div>
      <div style="align-self:end"><button class="btn pri">Create account</button></div></form></div></div>`;
  },

  async user() {
    const u = await api('GET', '/api/users/' + S.uid);
    S.cur = u;
    const logs = await api('GET', `/api/users/${u.id}/logs?category=${S.logTab}`);
    const tabs = [['details', 'User Details'], ['engagement', 'Engagement Data'], ['security', 'Security'], ['saves', 'Cloud Saves'], ['games', 'Games'],
      ...S.games.map(g => [g.key, g.name]), ...(isAdmin() ? [['moderation', 'Moderation']] : [])];
    if (!tabs.some(t => t[0] === S.tab)) S.tab = 'details';
    const body = await tabBody[S.tab](u);
    const ban = u.status !== 'active' && u.ban ? `<div class="banner"><b>${u.status.toUpperCase()}</b> — ${esc(u.ban.reason)} <span class="muted">(by ${esc(u.ban.by)}, ${u.ban.until ? 'until ' + fmt(u.ban.until) : 'permanent'})</span></div>` : '';
    return `<h2 class="page-title">${esc(u.nickname)} ${statusPill(u)} ${rolePill(u.role)}</h2>${ban}
    <div class="tabs">${tabs.map(t => `<button class="${S.tab === t[0] ? 'on' : ''}" data-act="tab" data-t="${t[0]}">${esc(t[1])}</button>`).join('')}</div>
    <div class="cols"><div class="left">${body}</div><div class="right">${logsPanel(u, logs)}</div></div>`;
  },

  async crews() {
    const list = await api('GET', '/api/crews');
    const users = isAdmin() ? await api('GET', '/api/users') : [];
    return `<h2 class="page-title">Crews</h2>
    <div class="card"><h3>${isAdmin() ? 'All crews' : 'Your crews'} (${list.length})</h3>
    <table><tr><th>Tag</th><th>Name</th><th>Leader</th><th>Members</th></tr>
    ${list.map(c => `<tr class="click" data-act="openCrew" data-id="${c.id}"><td><span class="pill acc">${esc(c.tag || '—')}</span></td><td><b>${esc(c.name)}</b></td><td>${esc(c.leader)}</td><td>${c.count}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No crews yet</td></tr>'}</table></div>
    <div class="card"><h3>Create crew</h3><div class="bd"><form data-form="createCrew" class="grid2">
      <div><label>Name</label><input name="name" required minlength="3" maxlength="40"></div>
      <div><label>Tag (up to 4)</label><input name="tag" maxlength="4"></div>
      <div><label>Description</label><input name="description" maxlength="300"></div>
      ${isAdmin() ? `<div><label>Leader</label><select name="leaderId">${users.map(u => `<option value="${u.id}" ${u.id === S.me.id ? 'selected' : ''}>${esc(u.nickname)}</option>`).join('')}</select></div>` : '<div></div>'}
      <div><button class="btn pri">Create crew</button></div></form></div></div>`;
  },

  async crew() {
    const c = await api('GET', '/api/crews/' + S.crewId);
    const leader = (c.members.find(m => m.rank === 'Leader') || {}).userId;
    const manage = isAdmin() || leader === S.me.id;
    const ranks = ['Commissioner', 'Lieutenant', 'Representative', 'Muscle'];
    return `<h2 class="page-title"><span class="pill acc">${esc(c.tag || '—')}</span> ${esc(c.name)}</h2>
    <p class="muted">${esc(c.description) || 'No description.'} · Created ${fmt(c.createdAt)}</p>
    <div class="card"><h3>Members (${c.members.length})</h3><table><tr><th></th><th>Nickname</th><th>Rank</th><th>Joined</th><th></th></tr>
    ${c.members.map(m => `<tr><td>${av(m)}</td><td><b>${esc(m.nickname)}</b></td>
      <td>${manage && m.rank !== 'Leader' ? `<select data-change="crewRank" data-cid="${c.id}" data-uid="${m.userId}" style="width:auto">${ranks.map(r => `<option ${r === m.rank ? 'selected' : ''}>${r}</option>`).join('')}</select>` : esc(m.rank)}</td>
      <td>${fmt(m.joinedAt)}</td><td class="row">
      ${manage && m.rank !== 'Leader' ? `<button class="btn sm" data-act="makeLeader" data-cid="${c.id}" data-uid="${m.userId}">Make leader</button>` : ''}
      ${(manage || m.userId === S.me.id) && !(m.rank === 'Leader' && c.members.length > 1) ? `<button class="btn sm bad" data-act="removeMember" data-cid="${c.id}" data-uid="${m.userId}">${m.userId === S.me.id ? 'Leave' : 'Remove'}</button>` : ''}
      ${m.userId !== S.me.id && !isAdmin() ? `<button class="btn sm" data-act="reportMember" data-uid="${m.userId}">Report</button>` : ''}
      ${isAdmin() ? `<button class="btn sm" data-act="openUser" data-id="${m.userId}">Open</button>` : ''}</td></tr>`).join('')}</table></div>
    ${manage ? `<div class="card"><h3>Manage crew</h3><div class="bd">
      <form data-form="addCrewMember" data-cid="${c.id}" class="row"><input name="nickname" placeholder="Add member by nickname" required style="max-width:260px"><button class="btn pri">Add</button></form>
      <form data-form="saveCrew" data-cid="${c.id}" class="grid2" style="margin-top:10px">
        <div><label>Name</label><input name="name" value="${esc(c.name)}" required minlength="3"></div><div><label>Tag</label><input name="tag" value="${esc(c.tag)}" maxlength="4"></div>
        <div style="grid-column:1/-1"><label>Description</label><input name="description" value="${esc(c.description)}"></div>
        <div class="row"><button class="btn pri">Save</button><button type="button" class="btn bad" data-act="deleteCrew" data-cid="${c.id}">Disband crew</button></div></form></div></div>` : ''}
    <button class="btn" data-act="nav" data-v="crews">← All crews</button>`;
  },

  async statmaster() {
    const users = await api('GET', '/api/users');
    if (!S.smUser || !users.some(u => u.id === S.smUser)) S.smUser = users[0] && users[0].id;
    const u = S.smUser ? await api('GET', '/api/users/' + S.smUser) : null;
    const g = S.games.find(x => x.key === S.smGame) || S.games[0];
    return `<h2 class="page-title">StatMaster</h2><p class="muted">Adjust ranks, cash and stats. Every change needs a reason and is written to the audit log.</p>
    <div class="card"><h3>Select player</h3><div class="bd grid2">
      <div><label>Member</label><select data-change="smUser">${users.map(x => `<option value="${x.id}" ${x.id === S.smUser ? 'selected' : ''}>${esc(x.nickname)}</option>`).join('')}</select></div>
      <div><label>Game</label><select data-change="smGame">${S.games.map(x => `<option value="${x.key}" ${x.key === g.key ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div></div></div>
    ${u ? statEditor(u, g, true) : ''}`;
  },

  async moderation() {
    const flags = await api('GET', '/api/flags');
    const users = (await api('GET', '/api/users')).filter(u => u.status !== 'active');
    const open = flags.filter(f => f.status === 'open');
    return `<h2 class="page-title">Moderation</h2>
    <div class="card"><h3>Flag queue (${open.length} open)</h3><table><tr><th>When</th><th>Member</th><th>Reason</th><th>Reported by</th><th></th></tr>
    ${flags.slice(0, 50).map(f => `<tr><td>${fmt(f.at)}</td><td><a href="#" data-act="openUser" data-id="${f.userId}">${esc(f.nickname)}</a></td><td>${esc(f.reason)}</td><td>${esc(f.by)}</td>
      <td>${f.status === 'open' ? `<button class="btn sm" data-act="resolveFlag" data-id="${f.id}">Resolve</button>` : `<span class="pill ok">${esc(f.resolution || 'resolved')}</span>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing flagged</td></tr>'}</table></div>
    <div class="card"><h3>Suspended / banned accounts (${users.length})</h3><table><tr><th>Member</th><th>Status</th><th></th></tr>
    ${users.map(u => `<tr class="click" data-act="openUser" data-id="${u.id}"><td><b>${esc(u.nickname)}</b></td><td>${statusPill(u)}</td><td class="muted">${esc(u.email)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Everyone is in good standing</td></tr>'}</table></div>`;
  },

  async audit() {
    const l = await api('GET', `/api/logs?category=${S.auditCat}&q=${encodeURIComponent(S.auditQ)}`);
    const cats = ['all', 'profile', 'email', 'security', 'nickname', 'password', 'stats', 'moderation'];
    return `<h2 class="page-title">Audit log</h2>
    <div class="card"><h3>Latest ${l.length} events</h3><div class="bd row">
      <select data-change="auditCat" style="width:auto">${cats.map(c => `<option ${c === S.auditCat ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <input id="auditQ" class="grow" placeholder="Search member, action, detail, admin" value="${esc(S.auditQ)}"></div>
    <table><tr><th>When</th><th>Member</th><th>Category</th><th>Action</th><th>By</th></tr>
    ${l.map(x => `<tr class="click" data-act="openUser" data-id="${x.userId}"><td>${fmt(x.at)}</td><td>${esc(x.nickname)}</td><td><span class="pill">${esc(x.category)}</span></td><td>${esc(x.action)} <span class="muted">${esc(x.detail)}</span></td><td>${esc(x.by)}</td></tr>`).join('')}</table></div>`;
  },
};
// ------------------------------------------------------------------ chat
function chanListHtml() {
  const item = c => `<div class="ci ${c.id === S.chan ? 'on' : ''}" data-act="pickChan" data-id="${c.id}">${c.kind === 'dm' ? '● ' : c.private ? '🔒 ' : '# '}${esc(c.name)}${c.unread ? `<span class="dot2">${c.unread}</span>` : ''}</div>`;
  const chs = S.chans.filter(c => c.kind === 'channel'), dms = S.chans.filter(c => c.kind === 'dm');
  return `<h4>Channels ${isAdmin() ? '<a href="#" data-act="newChan" title="New channel">＋</a>' : ''}</h4>${chs.map(item).join('')}
    <h4>Direct messages</h4>${dms.map(item).join('') || '<div class="muted" style="padding:4px 12px">None yet</div>'}
    <div style="padding:10px"><select data-change="newDm"><option value="">＋ Start a DM…</option>${S.dir.filter(u => u.id !== S.me.id).map(u => `<option value="${u.id}">${esc(u.nickname)}${u.team ? ' (' + esc(u.team) + ')' : ''}</option>`).join('')}</select></div>`;
}
function fileHtml(f) {
  const url = '/api/chat/files/' + f.id;
  if (/\.(png|jpe?g|gif|webp)$/i.test(f.name)) return `<a href="${url}" target="_blank"><img class="pic" src="${url}?inline=1" alt="${esc(f.name)}"></a>`;
  return `<a class="fcard" href="${url}">📎 <b>${esc(f.name)}</b> <span class="muted">${sizeFmt(f.size)} · download</span></a>`;
}
function msgHtml(m) {
  const mine = m.userId === S.me.id;
  return `<div class="msg">${av({ nickname: m.nickname, color: m.color })}<div class="mb"><div><b>${esc(m.nickname)}</b>${m.team ? ` <span class="pill acc">${esc(m.team)}</span>` : ''}
    <span class="muted t">${fmt(m.at)}${m.editedAt ? ' · edited' : ''}</span>${mine ? ` <a href="#" class="muted t" data-act="editMsg" data-id="${m.id}">edit</a>` : ''}${mine || isAdmin() ? ` <a href="#" class="muted t" data-act="delMsg" data-id="${m.id}">delete</a>` : ''}</div>
    ${m.text ? `<div class="tx">${linkify(m.text)}</div>` : ''}${m.file ? fileHtml(m.file) : ''}</div></div>`;
}
function drawChatHead() {
  const c = S.chans.find(x => x.id === S.chan); const h = $('#chh'); if (!h) return;
  h.innerHTML = c ? `<b>${c.kind === 'dm' ? '● ' : c.private ? '🔒 ' : '# '}${esc(c.name)}</b> <span class="muted">${esc(c.topic)}</span>${isAdmin() && c.kind === 'channel' ? ' <button class="btn sm bad" style="float:right" data-act="delChan">Delete channel</button>' : ''}` : '';
}
async function loadMsgs(first) {
  if (!S.chan) return;
  const chan = S.chan;
  const list = await api('GET', `/api/chat/channels/${chan}/messages`);
  const chans = await api('GET', '/api/chat/channels');
  if (chan !== S.chan) return;
  const box = $('#msgs'); if (!box) return;
  const sig = list.map(m => m.id + (m.editedAt || '')).join();
  if (first || sig !== S.chSig) {
    const near = first || box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    S.chMsgs = list; S.chSig = sig;
    box.innerHTML = list.map(msgHtml).join('') || '<p class="muted" style="padding:14px">No messages yet. Say something!</p>';
    if (near) box.scrollTop = box.scrollHeight;
  }
  const csig = chans.map(c => c.id + c.unread + c.name).join();
  if (csig !== S.chanSig) { S.chans = chans; S.chanSig = csig; const l = $('#chl'); if (l) l.innerHTML = chanListHtml(); }
  S.unread = chans.reduce((a, c) => a + c.unread, 0);
}
views.chat = async () => {
  S.chans = await api('GET', '/api/chat/channels');
  S.dir = await api('GET', '/api/directory');
  if (!S.chan || !S.chans.some(c => c.id === S.chan)) S.chan = (S.chans.find(c => c.name === 'general') || S.chans[0] || {}).id;
  S.chSig = ''; S.chanSig = S.chans.map(c => c.id + c.unread + c.name).join();
  return `<div class="chat"><aside class="chl" id="chl">${chanListHtml()}</aside><section class="chm"><div class="chh" id="chh"></div><div class="msgs" id="msgs"></div>
    <form class="comp" data-form="sendMsg"><textarea name="text" id="ctext" rows="2" maxlength="4000" placeholder="Message… (Enter to send, Shift+Enter for a new line)"></textarea>
    <div class="row"><label class="btn sm" style="margin:0;display:inline-block;text-transform:none;font-size:12px;color:inherit;cursor:pointer">📎 Attach file (25 MB max)<input type="file" name="file" id="cfile" hidden></label><span class="muted" id="cfname"></span><span class="grow"></span><button class="btn pri">Send</button></div></form></section></div>`;
};
const chatAfter = async () => {
  drawChatHead();
  await loadMsgs(true);
  $('#ctext').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form[data-form=sendMsg]').requestSubmit(); } });
  $('#cfile').addEventListener('change', () => { $('#cfname').textContent = $('#cfile').files[0] ? $('#cfile').files[0].name : ''; });
  chatTimer = setInterval(() => loadMsgs(false).catch(() => {}), 3000);
  updateNav();
};

views.mine = () => { S.view = 'user'; S.uid = S.me.id; return views.user(); };
const afterRender = {
  chat: chatAfter,
  members() { const q = $('#mq'); q.addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(async () => { S.mq = q.value; const pos = q.selectionStart; await render(); const n = $('#mq'); n.focus(); n.setSelectionRange(pos, pos); }, 300); }); },
  audit() { const q = $('#auditQ'); q.addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(async () => { S.auditQ = q.value; const pos = q.selectionStart; await render(); const n = $('#auditQ'); n.focus(); n.setSelectionRange(pos, pos); }, 300); }); },
};

// ------------------------------------------------------------------ user tab bodies
function logsPanel(u, logs) {
  const cats = ['all', 'profile', 'email', 'security', 'nickname', 'password', 'stats', 'moderation'];
  const emailExtra = S.logTab === 'email' ? `<div class="bd" style="border-bottom:1px solid #ddd">
    <div class="muted">Original Email Address</div><b>${esc((u.emailHistory || []).slice(-1)[0]?.email || u.email)}</b>
    <div class="muted" style="margin-top:6px">Current Email Address</div><b>${esc(u.email)}</b><div class="muted">Published ${fmt(u.emailChanged)}</div>
    ${(u.emailHistory || [])[0] ? `<div class="muted" style="margin-top:6px">Previous Email Address</div><b>${esc(u.emailHistory[0].email)}</b>` : ''}</div>` : '';
  return `<div class="card"><h3>Support Logs <button class="btn sm" data-act="refresh">⟳</button></h3>
    <div class="mini-tabs">${cats.map(c => `<button class="${S.logTab === c ? 'on' : ''}" data-act="logTab" data-c="${c}">${c[0].toUpperCase() + c.slice(1)}</button>`).join('')}</div>${emailExtra}
    <div class="bd" style="max-height:520px;overflow:auto">${logs.map(l => `<div class="log"><b>${esc(l.action)}</b> ${esc(l.detail)}<small>${fmt(l.at)} · ${esc(l.by)}</small></div>`).join('') || '<span class="muted">No entries</span>'}</div></div>`;
}

function statEditor(u, g, canEdit) {
  const cur = (u.stats && u.stats[g.key]) || {};
  const rows = g.fields.map(f => {
    const v = cur[f.key] ?? f.def;
    return `<div class="statrow"><span>${esc(f.label)}</span>${canEdit ? `<input type="number" name="f_${f.key}" value="${v}" min="${f.min}" max="${f.max}">` : `<b>${num(v)}</b>`}<span class="muted">${f.min < 0 ? `${f.min} … ${num(f.max)}` : `max ${num(f.max)}`}</span></div>`;
  }).join('');
  if (!canEdit) return `<div class="card"><h3>${esc(g.name)} — stats</h3><div class="bd">${rows}</div></div>`;
  return `<div class="card"><h3>${esc(g.name)} — StatMaster · ${esc(u.nickname)}</h3><div class="bd">
    <form data-form="saveStats" data-uid="${u.id}" data-game="${g.key}">${rows}
    <label>Reason (required, goes to the audit log)</label><input name="reason" required minlength="3" maxlength="200" placeholder="e.g. Granted missing reward from ticket #12">
    <div class="row" style="margin-top:10px"><button class="btn pri">Apply changes</button>
    <button type="button" class="btn bad" data-act="resetStats" data-uid="${u.id}" data-game="${g.key}">Reset character progress</button></div></form></div></div>`;
}

const tabBody = {
  async details(u) {
    const f = (k, v) => `<dt>${k}</dt><dd>${v || '<span class="muted">—</span>'}</dd>`;
    const self = S.me.id === u.id;
    const view = `<div class="badge-av">${av(u, 'lg')}</div><dl class="kv" style="grid-template-columns:140px 1fr 140px 1fr;max-width:none">
      ${f('Online Service', 'CrewAdmin')}${f('Language', esc(u.language))}
      ${f('Account ID', esc(u.id))}${f('Country/Region', esc(u.country))}
      ${f('Date of Birth', esc(u.dob))}${f('Account Creation Path', 'Invited by admin')}
      ${f('Email', esc(u.email))}${f('Member Since', fmt(u.memberSince))}
      ${f('Password', '••••••••••')}${f('Last Portal Login', fmt(u.lastLogin))}
      ${f('Email Last Updated', fmt(u.emailChanged))}${f('Crew Associations', u.crews.map(c => `<a href="#" data-act="openCrew" data-id="${c.id}"><span class="pill acc">${esc(c.tag || c.name)}</span> ${esc(c.name)}</a>`).join('<br>'))}
      ${f('Team', u.team ? `<span class="pill acc">${esc(u.team)}</span>` : '')}${f('Bio', esc(u.bio))}
      ${f('Password Updated', fmt(u.passwordChanged))}</dl>`;
    const edit = `<form data-form="saveProfile" class="grid2">
      <div><label>Nickname</label><input name="nickname" value="${esc(u.nickname)}" required minlength="3" maxlength="24"></div>
      <div><label>Email</label><input name="email" type="email" value="${esc(u.email)}" required></div>
      <div><label>Date of birth</label><input name="dob" type="date" value="${esc(u.dob)}"></div>
      <div><label>Country / Region</label><input name="country" value="${esc(u.country)}"></div>
      <div><label>Language</label><input name="language" value="${esc(u.language)}"></div>
      <div><label>Bio</label><input name="bio" value="${esc(u.bio)}" maxlength="500"></div>
      ${isAdmin() ? `<div><label>Team (Dev, Tester, QA, Artist…)</label><input name="team" value="${esc(u.team)}" list="teams" maxlength="20"><datalist id="teams"><option>Dev<option>Tester<option>QA<option>Artist<option>Designer<option>Producer<option>Friend</datalist></div>` : ''}
      <div class="row"><button class="btn pri">Save</button><button type="button" class="btn" data-act="editToggle">Cancel</button></div></form>`;
    const linked = `<div class="card"><h3>Linked Accounts</h3><div class="bd"><div class="chips">
      ${u.linked.map((l, i) => `<span class="chip"><b>${esc(l.platform)}</b> ${esc(l.name)} <button data-act="rmLinked" data-i="${i}" title="Remove">✕</button></span>`).join('') || '<span class="muted">None linked</span>'}</div>
      <form data-form="addLinked" class="row" style="margin-top:12px"><input name="platform" placeholder="Platform (Steam, Epic, Xbox…)" required style="max-width:230px"><input name="name" placeholder="Account name" required style="max-width:230px"><button class="btn">Link account</button></form></div></div>`;
    const notes = isAdmin() ? `<div class="card"><h3>Admin notes (only admins see this)</h3><div class="bd"><form data-form="saveNotes"><textarea name="notes">${esc(u.notes)}</textarea><div style="margin-top:8px"><button class="btn">Save notes</button></div></form></div></div>` : '';
    const roleCtl = S.me.role === 'owner' && u.role !== 'owner' ? `<div class="card"><h3>Role</h3><div class="bd row"><select data-change="role" style="width:auto"><option ${u.role === 'member' ? 'selected' : ''}>member</option><option ${u.role === 'admin' ? 'selected' : ''}>admin</option></select><span class="muted">Admins can see every member and use StatMaster / Moderation.</span>
      <span class="grow"></span><button class="btn bad" data-act="deleteUser">Delete account</button></div></div>` : '';
    return `<div class="card"><h3><span>General Details</span><button class="btn sm" data-act="editToggle">Edit</button></h3><div class="bd">${S.edit ? edit : view}</div></div>${linked}${notes}${roleCtl}`;
  },

  async engagement(u) {
    const hours = u.games.reduce((a, g) => a + (+g.hours || 0), 0);
    const days = Math.max(0, Math.floor((Date.now() - Date.parse(u.memberSince)) / 864e5));
    return `<div class="stats"><div class="stat"><b>${num(hours)}</b>Hours played</div><div class="stat"><b>${u.games.length}</b>Titles</div><div class="stat"><b>${u.loginCount || 0}</b>Portal logins</div><div class="stat"><b>${days}</b>Days a member</div></div>
    <div class="card"><h3>Hours by game</h3><table><tr><th>Game</th><th>Hours</th><th>Last played</th></tr>${u.games.map(g => `<tr><td>${esc(g.game)}</td><td>${num(g.hours)}</td><td>${esc(g.lastPlayed) || '—'}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No games recorded</td></tr>'}</table></div>
    <div class="card"><h3>Recent sign-ins</h3><table><tr><th>When</th><th>IP</th><th>Device</th></tr>${(u.loginHistory || []).slice(0, 10).map(h => `<tr><td>${fmt(h.at)}</td><td>${esc(h.ip)}</td><td class="muted">${esc(h.ua)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Never signed in</td></tr>'}</table></div>`;
  },

  async security(u) {
    const self = S.me.id === u.id;
    return `<div class="card"><h3>Security</h3><div class="bd"><dl class="kv">
      <dt>Status</dt><dd>${statusPill(u)}</dd><dt>Last sign-in IP</dt><dd>${esc(u.lastIp) || '—'}</dd>
      <dt>Password last changed</dt><dd>${fmt(u.passwordChanged)}</dd><dt>Email last changed</dt><dd>${fmt(u.emailChanged)}</dd></dl>
      <div style="margin-top:12px"><button class="btn" data-act="signoutAll">Sign out all sessions</button></div></div></div>
    <div class="card"><h3>${self ? 'Change password' : 'Reset password'}</h3><div class="bd"><form data-form="changePw" class="grid2">
      ${self ? '<div><label>Current password</label><input name="current" type="password" required autocomplete="current-password"></div>' : ''}
      <div><label>New password (8+)</label><input name="password" type="password" required minlength="8" autocomplete="new-password"></div>
      <div style="align-self:end"><button class="btn pri">${self ? 'Update password' : 'Reset password'}</button></div></form></div></div>
    <div class="card"><h3>Email history</h3><table><tr><th>Email</th><th>Used until</th></tr>${(u.emailHistory || []).map(h => `<tr><td>${esc(h.email)}</td><td>${fmt(h.until)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No previous emails</td></tr>'}</table></div>`;
  },

  async saves(u) {
    const saves = await api('GET', `/api/users/${u.id}/saves`);
    return `<div class="card"><h3>Cloud Saves (${saves.length})</h3><table><tr><th>Game</th><th>File</th><th>Size</th><th>Uploaded</th><th></th></tr>
      ${saves.map(s => `<tr><td>${esc(s.game)}</td><td>${esc(s.name)}</td><td>${(s.size / 1024).toFixed(1)} KB</td><td>${fmt(s.uploadedAt)}</td>
      <td class="row"><a class="btn sm" href="/api/saves/${s.id}">Download</a><button class="btn sm bad" data-act="rmSave" data-id="${s.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No saves uploaded</td></tr>'}</table></div>
    <div class="card"><h3>Upload a save (max 25 MB)</h3><div class="bd"><form data-form="upload" class="row">
      <select name="game" style="width:auto">${S.games.map(g => `<option>${esc(g.name)}</option>`).join('')}<option>Other</option></select>
      <input type="file" name="file" required class="grow"><button class="btn pri">Upload</button></form></div></div>`;
  },

  async games(u) {
    const row = (g = {}) => `<tr><td><input name="game" value="${esc(g.game)}" list="gl"></td><td><input name="hours" type="number" min="0" value="${esc(g.hours ?? 0)}" style="width:90px"></td>
      <td><input name="lastPlayed" type="date" value="${esc(g.lastPlayed)}"></td><td><input name="note" value="${esc(g.note)}"></td><td><button type="button" class="btn sm bad" data-act="rmRow">✕</button></td></tr>`;
    gameRowHtml = row();
    return `<div class="card"><h3>Games</h3><div class="bd"><datalist id="gl">${S.games.map(g => `<option value="${esc(g.name)}">`).join('')}</datalist>
      <table id="gametbl"><tr><th>Game</th><th>Hours</th><th>Last played</th><th>Note</th><th></th></tr>${u.games.map(row).join('')}</table>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="addRow">+ Add game</button><button class="btn pri" data-act="saveGames">Save</button></div></div></div>`;
  },

  async moderation(u) {
    if (!isAdmin()) return '';
    const self = S.me.id === u.id;
    return `<div class="card"><h3>Moderation · ${esc(u.nickname)}</h3><div class="bd">
      <p>Current standing: ${statusPill(u)}</p>
      ${self || u.role === 'owner' ? '<p class="muted">This account cannot be moderated from here.</p>' : `
      <label>Reason (required to suspend or ban)</label><input id="modreason" maxlength="300" placeholder="e.g. Modded cash in public session">
      <label>Duration in days (blank = default 7 days for suspension, permanent for ban)</label><input id="moddays" type="number" min="0" max="3650" style="max-width:160px">
      <div class="row" style="margin-top:12px"><button class="btn" data-act="mod" data-a="suspend">Suspend</button>
      <button class="btn bad" data-act="mod" data-a="ban">Ban</button>
      ${u.status !== 'active' ? '<button class="btn pri" data-act="mod" data-a="unban">Lift restriction</button>' : ''}</div>`}</div></div>`;
  },
};
let gameRowHtml = '';
for (const g of ['gtav', 'rdr2']) tabBody[g] = async u => statEditor(u, S.games.find(x => x.key === g), isAdmin());
// any further games added in server.js get a generic handler
function ensureGameTabs() { for (const g of S.games) if (!tabBody[g.key]) tabBody[g.key] = async u => statEditor(u, g, isAdmin()); }

// ------------------------------------------------------------------ actions
const acts = {
  async logout() { await api('POST', '/api/logout', {}); S.me = null; location.reload(); },
  nav(el) {
    const v = el.dataset.v; S.edit = false;
    if (v === 'mine') return go('user', { uid: S.me.id, tab: 'details', logTab: 'all' });
    if (v === 'members') S.mq = '';
    go(v);
  },
  pickChan(el) { S.chan = el.dataset.id; render(); },
  async newChan() {
    const name = prompt('New channel name (letters, numbers, dashes):'); if (!name) return;
    const priv = confirm('Make it private (only people you add can see it)?');
    const members = priv ? (prompt('Member nicknames, comma separated:') || '').split(',').map(s => s.trim()).filter(Boolean) : [];
    const c = await api('POST', '/api/chat/channels', { name, private: priv, members });
    S.chan = c.id; render();
  },
  async delChan() { if (!confirm('Delete this channel and every message and file in it?')) return; await api('DELETE', '/api/chat/channels/' + S.chan); S.chan = null; render(); },
  async delMsg(el) { if (!confirm('Delete this message?')) return; await api('DELETE', '/api/chat/messages/' + el.dataset.id); await loadMsgs(false); },
  async editMsg(el) {
    const m = S.chMsgs.find(x => x.id === el.dataset.id); if (!m) return;
    const text = prompt('Edit message:', m.text); if (text === null || !text.trim()) return;
    await api('PATCH', '/api/chat/messages/' + m.id, { text }); await loadMsgs(false);
  },
  openUser(el) { const b = $('#results'); if (b) b.hidden = true; go('user', { uid: el.dataset.id, tab: 'details', logTab: 'all', edit: false }); },
  openCrew(el) { go('crew', { crewId: el.dataset.id }); },
  tab(el) { S.tab = el.dataset.t; S.edit = false; render(); },
  logTab(el) { S.logTab = el.dataset.c; render(); },
  refresh() { render(); },
  editToggle() { S.edit = !S.edit; render(); },
  async rmLinked(el) { const l = S.cur.linked.filter((_, i) => i !== +el.dataset.i); await api('PUT', `/api/users/${S.uid}/linked`, { linked: l }); toast('Removed'); render(); },
  async rmSave(el) { if (!confirm('Delete this save?')) return; await api('DELETE', '/api/saves/' + el.dataset.id); toast('Deleted'); render(); },
  addRow() { $('#gametbl').insertAdjacentHTML('beforeend', gameRowHtml); },
  rmRow(el) { el.closest('tr').remove(); },
  async saveGames() {
    const games = $$('#gametbl tr').slice(1).map(tr => Object.fromEntries($$('input', tr).map(i => [i.name, i.value])));
    await api('PUT', `/api/users/${S.uid}/games`, { games }); toast('Games saved'); render();
  },
  async signoutAll() { if (!confirm('Sign this member out everywhere?')) return; await api('POST', `/api/users/${S.uid}/signout`, {}); toast('All sessions signed out'); render(); },
  async resetStats(el) {
    const reason = prompt('Reason for resetting character progress (required):');
    if (!reason) return;
    if (!confirm('Reset ALL stats for this game back to defaults?')) return;
    await api('POST', `/api/users/${el.dataset.uid}/stats/${el.dataset.game}/reset`, { reason }); toast('Progress reset'); render();
  },
  async mod(el) {
    const a = el.dataset.a;
    await api('POST', `/api/users/${S.uid}/moderation`, { action: a, reason: $('#modreason').value, days: $('#moddays').value });
    toast(a === 'unban' ? 'Restriction lifted' : a === 'ban' ? 'Member banned' : 'Member suspended'); render();
  },
  async deleteUser() { if (!confirm('Permanently delete this account, its saves and logs?')) return; await api('DELETE', '/api/users/' + S.uid); toast('Account deleted'); go('members'); },
  async resolveFlag(el) { const resolution = prompt('Resolution note:', 'No action needed'); if (resolution === null) return; await api('POST', `/api/flags/${el.dataset.id}/resolve`, { resolution }); render(); },
  async makeLeader(el) { await api('POST', `/api/crews/${el.dataset.cid}/leader`, { userId: el.dataset.uid }); toast('Leader changed'); render(); },
  async removeMember(el) {
    if (!confirm('Remove this member from the crew?')) return;
    await api('DELETE', `/api/crews/${el.dataset.cid}/members/${el.dataset.uid}`);
    toast('Done'); const left = (await api('GET', '/api/crews')).some(c => c.id === el.dataset.cid); left ? render() : go('crews');
  },
  async deleteCrew(el) { if (!confirm('Disband this crew?')) return; await api('DELETE', '/api/crews/' + el.dataset.cid); toast('Crew disbanded'); go('crews'); },
  async reportMember(el) { const reason = prompt('Why are you reporting this member?'); if (!reason) return; await api('POST', '/api/flags', { userId: el.dataset.uid, reason }); toast('Report sent to the admins'); },
};
const changes = {
  async newDm(el) { if (!el.value) return; const c = await api('POST', '/api/chat/dm', { userId: el.value }); S.chan = c.id; render(); },
  async role(el) { await api('PATCH', '/api/users/' + S.uid, { role: el.value }); toast('Role updated'); render(); },
  async crewRank(el) { await api('PATCH', `/api/crews/${el.dataset.cid}/members/${el.dataset.uid}`, { rank: el.value }); toast('Rank updated'); },
  smUser(el) { S.smUser = el.value; render(); },
  smGame(el) { S.smGame = el.value; render(); },
  auditCat(el) { S.auditCat = el.value; render(); },
};
const forms = {
  async sendMsg(f, d) {
    const file = f.file.files[0], text = (d.text || '').trim();
    if (!file && !text) return;
    if (file) {
      if (file.size > 25 * 1024 * 1024) throw new Error('File is over 25 MB');
      const r = await fetch(`/api/chat/channels/${S.chan}/upload`, { method: 'POST', body: file, headers: { 'X-Requested-With': 'crewadmin', 'X-File-Name': encodeURIComponent(file.name), 'X-Text': encodeURIComponent(text) } });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Upload failed');
    } else await api('POST', `/api/chat/channels/${S.chan}/messages`, { text });
    f.reset(); $('#cfname').textContent = '';
    S.chSig = ''; await loadMsgs(true);
  },
  async login(f, d) {
    try { await api('POST', '/api/login', d); } catch (e) { $('#err').textContent = e.message; return; }
    boot();
  },
  async setup(f, d) {
    try { await api('POST', '/api/setup', d); toast('Owner created — sign in'); } catch (e) { $('#err').textContent = e.message; return; }
    boot();
  },
  async saveProfile(f, d) { await api('PATCH', '/api/users/' + S.uid, d); S.edit = false; toast('Profile saved'); if (S.uid === S.me.id) S.me = await api('GET', '/api/me'); render(); },
  async addLinked(f, d) { await api('PUT', `/api/users/${S.uid}/linked`, { linked: [...S.cur.linked, d] }); toast('Account linked'); render(); },
  async saveNotes(f, d) { await api('PATCH', '/api/users/' + S.uid, { notes: d.notes }); toast('Notes saved'); render(); },
  async changePw(f, d) { await api('POST', `/api/users/${S.uid}/password`, d); f.reset(); toast('Password updated'); render(); },
  async addMember(f, d) { const u = await api('POST', '/api/users', d); toast('Member created'); go('user', { uid: u.id, tab: 'details' }); },
  async upload(f) {
    const file = f.file.files[0]; if (!file) return;
    if (file.size > 25 * 1024 * 1024) throw new Error('File is over 25 MB');
    const r = await fetch(`/api/users/${S.uid}/saves`, { method: 'POST', body: file, headers: { 'X-Requested-With': 'crewadmin', 'X-File-Name': encodeURIComponent(file.name), 'X-Game': f.game.value } });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Upload failed');
    toast('Uploaded'); render();
  },
  async saveStats(f, d) {
    const changes = {};
    for (const [k, v] of Object.entries(d)) if (k.startsWith('f_')) changes[k.slice(2)] = v;
    await api('PUT', `/api/users/${f.dataset.uid}/stats/${f.dataset.game}`, { changes, reason: d.reason }); toast('Stats updated'); render();
  },
  async createCrew(f, d) { const c = await api('POST', '/api/crews', d); toast('Crew created'); go('crew', { crewId: c.id }); },
  async saveCrew(f, d) { await api('PATCH', '/api/crews/' + f.dataset.cid, d); toast('Crew saved'); render(); },
  async addCrewMember(f, d) { await api('POST', `/api/crews/${f.dataset.cid}/members`, d); f.reset(); toast('Member added'); render(); },
};

const report = e => toast(e.message || String(e), true);
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el || !acts[el.dataset.act]) return;
  if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
  Promise.resolve(acts[el.dataset.act](el, e)).catch(report);
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]'); if (el && changes[el.dataset.change]) Promise.resolve(changes[el.dataset.change](el)).catch(report);
});
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  Promise.resolve(forms[f.dataset.form](f, Object.fromEntries(new FormData(f)))).catch(report);
});

boot();
