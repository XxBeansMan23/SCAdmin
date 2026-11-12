'use strict';
// SCAdmin - a private member-admin + team chat panel for a small group of devs, testers and friends.
// Independent hobby project: not affiliated with Rockstar Games.
// Zero dependencies. Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SAVES = path.join(DATA, 'saves');
const PUBLIC = path.join(__dirname, 'docs');
const DB_FILE = path.join(DATA, 'db.json');
const MAX_UPLOAD = 25 * 1024 * 1024;
fs.mkdirSync(SAVES, { recursive: true });

// ---------------------------------------------------------------- database
let db = { users: [], logs: [], saves: [] };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
db.crews ||= []; db.flags ||= [];
db.settings ||= {};
if (!db.settings.inviteCode) { db.settings.inviteCode = crypto.randomBytes(5).toString('hex'); persist(); }

// Games / stat schema used by StatMaster (edit freely to add titles or fields)
const f = (key, label, min, max, def) => ({ key, label, min, max, def });
const INT = 2147483647;
const GAMES = [
  { key: 'gtav', name: 'Grand Theft Auto V', fields: [
    f('rank', 'Rank', 1, 8000, 1), f('cash', 'Cash ($)', 0, INT, 0), f('bank', 'Bank ($)', 0, INT, 0),
    f('kills', 'Kills', 0, INT, 0), f('deaths', 'Deaths', 0, INT, 0), f('missions', 'Missions completed', 0, 100000, 0), f('races', 'Races won', 0, 100000, 0)] },
  { key: 'rdr2', name: 'Red Dead Redemption 2', fields: [
    f('rank', 'Rank', 1, 999, 1), f('cash', 'Cash ($)', 0, INT, 0), f('gold', 'Gold bars', 0, 100000, 0),
    f('honor', 'Honor', -1000, 1000, 0), f('kills', 'Kills', 0, INT, 0), f('deaths', 'Deaths', 0, INT, 0), f('bounties', 'Bounties collected', 0, 100000, 0)] },
];
const CREW_RANKS = ['Leader', 'Commissioner', 'Lieutenant', 'Representative', 'Muscle'];
function persist() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const uid = () => crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- passwords / sessions
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + h.toString('hex');
}
function checkPw(pw, stored) {
  const [s, h] = String(stored || '').split(':');
  if (!s || !h) return false;
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(a, Buffer.from(h, 'hex'));
}
const sessions = new Map(); // token -> {uid, exp}
const SESSION_MS = 7 * 24 * 3600 * 1000;
function newSession(userId) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, { uid: userId, exp: Date.now() + SESSION_MS });
  return t;
}
function dropSessions(userId) {
  for (const [t, s] of sessions) if (s.uid === userId) sessions.delete(t);
}
function parseCookies(req) {
  const o = {};
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return o;
}
function authUser(req) {
  const t = parseCookies(req).sid;
  const s = t && sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
  const u = db.users.find(x => x.id === s.uid);
  if (!u || !liftExpired(u)) return null;
  return u;
}
const fails = new Map(); // ip -> [timestamps]
function tooManyFails(ip) {
  const a = (fails.get(ip) || []).filter(t => Date.now() - t < 60000);
  fails.set(ip, a);
  return a.length >= 6;
}

// ---------------------------------------------------------------- helpers
const isAdmin = u => u && (u.role === 'owner' || u.role === 'admin');
// Fine-grained permissions: the owner always has them; everyone else only if the owner granted them.
const PERMS = ['createChannels', 'deleteMessages', 'viewEmails'];
const can = (u, perm) => !!u && (u.role === 'owner' || !!(u.perms && u.perms[perm]));
// Emails are private: you see your own; others' only if you are the owner or were granted "viewEmails".
const canSeeEmail = (viewer, targetId) => viewer.id === targetId || can(viewer, 'viewEmails');
const viewUser = (viewer, u) => { const c = clean(u); return canSeeEmail(viewer, u.id) ? c : { ...c, email: '', emailHidden: true, emailHistory: [] }; };
const viewLog = (viewer, l) => (l.category === 'email' && !canSeeEmail(viewer, l.userId) ? { ...l, detail: '(hidden)' } : l);
const crewsOf = id => db.crews.filter(c => c.members.some(m => m.userId === id))
  .map(c => ({ id: c.id, name: c.name, tag: c.tag, rank: c.members.find(m => m.userId === id).rank }));
const clean = u => {
  const { passHash, ...rest } = u;
  return { ...rest, crews: crewsOf(u.id) };
};
function liftExpired(u) {
  if (u.status !== 'active' && u.ban && u.ban.until && Date.parse(u.ban.until) < Date.now()) {
    log(u.id, 'moderation', u.status === 'banned' ? 'Ban expired' : 'Suspension expired', '', 'system');
    u.status = 'active'; u.ban = null; persist();
  }
  return u.status === 'active';
}
function log(userId, category, action, detail, by) {
  db.logs.push({ id: uid(), userId, category, action, detail: detail || '', by: by || 'system', at: now() });
}
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const colorFor = n => 'hsl(' + (parseInt(crypto.createHash('md5').update(n).digest('hex').slice(0, 4), 16) % 360) + ',55%,45%)';

function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 1024 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw Object.assign(new Error('Bad JSON'), { code: 400 }); }
}
function hdrName(req, dflt) {
  let n = String(req.headers['x-file-name'] || dflt);
  try { n = decodeURIComponent(n); } catch { /* keep raw */ }
  n = path.basename(n.replace(/\\/g, '/')).trim().slice(0, 120).replace(/[^\w.\- ()]/g, '_');
  return n.replace(/^\.+/, '') || dflt;
}
const fail = (code, msg) => Object.assign(new Error(msg), { code });

let setupCode = null;
if (!db.users.length) {
  // On a hosted deployment set SETUP_CODE so you do not need console access
  setupCode = process.env.SETUP_CODE || crypto.randomBytes(4).toString('hex');
  console.log('\n  FIRST RUN: open the site and create the owner account.');
  console.log(process.env.SETUP_CODE ? '  Setup code: (the SETUP_CODE environment variable)\n' : '  Setup code: ' + setupCode + '\n');
}

// ---------------------------------------------------------------- API
async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  const ip = req.socket.remoteAddress;
  let r;

  // CSRF guard: state-changing calls must come with the JSON or custom header (blocks plain cross-site forms)
  if (m !== 'GET' && !req.headers['x-requested-with']) throw fail(403, 'Missing X-Requested-With');

  if (m === 'GET' && p === '/api/status') return send(res, 200, { needsSetup: !db.users.length });

  if (m === 'POST' && p === '/api/setup') {
    if (db.users.length) throw fail(403, 'Already set up');
    const b = await readJson(req);
    if (str(b.code) !== setupCode) throw fail(403, 'Wrong setup code (see the console window)');
    const nick = str(b.nickname, 24), email = str(b.email).toLowerCase(), pw = String(b.password || '');
    if (nick.length < 3) throw fail(400, 'Nickname must be 3+ characters');
    if (!validEmail(email)) throw fail(400, 'Invalid email');
    if (pw.length < 8) throw fail(400, 'Password must be 8+ characters');
    const u = makeUser({ nickname: nick, email, role: 'owner', passHash: hashPw(pw) });
    db.users.push(u);
    log(u.id, 'profile', 'Account created', 'Owner account', nick);
    persist();
    setupCode = null;
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/login') {
    if (tooManyFails(ip)) throw fail(429, 'Too many attempts. Wait a minute.');
    const b = await readJson(req);
    const id = str(b.login).toLowerCase();
    const u = db.users.find(x => x.nickname.toLowerCase() === id || x.email.toLowerCase() === id);
    if (!u || !checkPw(String(b.password || ''), u.passHash)) {
      fails.get(ip).push(Date.now());
      if (u) log(u.id, 'security', 'Failed sign-in', 'IP ' + ip, 'system');
      persist();
      throw fail(401, 'Wrong nickname/email or password');
    }
    if (!liftExpired(u)) throw fail(403, `This account is ${u.status}` + (u.ban && u.ban.reason ? ': ' + u.ban.reason : ''));
    u.lastLogin = now(); u.lastIp = ip; u.loginCount = (u.loginCount || 0) + 1;
    u.loginHistory = [{ at: u.lastLogin, ip, ua: str(req.headers['user-agent'], 120) }, ...(u.loginHistory || [])].slice(0, 30);
    log(u.id, 'security', 'Signed in', 'IP ' + ip, u.nickname);
    persist();
    const t = newSession(u.id);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
  }

  if (m === 'POST' && p === '/api/signup') {
    if (!db.users.length) throw fail(403, 'Use the first-time setup');
    if (db.settings.signupsOpen === false) throw fail(403, 'Sign-ups are closed right now');
    if (tooManyFails(ip)) throw fail(429, 'Too many attempts. Wait a minute.');
    const b = await readJson(req);
    const code = Buffer.from(str(b.code, 64)), want = Buffer.from(db.settings.inviteCode);
    if (code.length !== want.length || !crypto.timingSafeEqual(code, want)) { fails.get(ip).push(Date.now()); throw fail(403, 'Wrong invite code'); }
    const nick = str(b.nickname, 24), email = str(b.email).toLowerCase(), pw = String(b.password || '');
    if (nick.length < 3) throw fail(400, 'Nickname must be 3+ characters');
    if (!validEmail(email)) throw fail(400, 'Invalid email');
    if (pw.length < 8) throw fail(400, 'Password must be 8+ characters');
    if (db.users.some(u => u.nickname.toLowerCase() === nick.toLowerCase())) throw fail(409, 'Nickname taken');
    if (db.users.some(u => u.email === email)) throw fail(409, 'That email cannot be used');
    const u = makeUser({ nickname: nick, email, role: 'member', passHash: hashPw(pw) });
    u.lastLogin = now(); u.lastIp = ip; u.loginCount = 1; u.loginHistory = [{ at: u.lastLogin, ip, ua: str(req.headers['user-agent'], 120) }];
    db.users.push(u);
    log(u.id, 'profile', 'Account created', 'Self sign-up with invite code', nick);
    persist();
    return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${newSession(u.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
  }

  const me = authUser(req);
  if (!me) throw fail(401, 'Not signed in');

  if (m === 'GET' && p === '/api/announcement') return send(res, 200, { text: db.settings.announcement || '' });

  // ---- Owner tools (elevated): only the owner account
  if (p.startsWith('/api/owner/')) {
    if (me.role !== 'owner') throw fail(403, 'Owner only');
    const dirSize = d => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size; } catch { /* ignore */ } return n; };
    if (m === 'GET' && p === '/api/owner/overview') {
      return send(res, 200, {
        uptimeSec: Math.round(process.uptime()), node: process.version, members: db.users.length,
        admins: db.users.filter(u => u.role === 'admin' || u.role === 'owner').length, restricted: db.users.filter(u => u.status !== 'active').length,
        channels: db.channels.length, messages: db.messages.length, chatFiles: db.messages.filter(x => x.file).length, saves: db.saves.length,
        dataBytes: dirSize(DATA), signupsOpen: db.settings.signupsOpen !== false, inviteCode: db.settings.inviteCode, announcement: db.settings.announcement || '',
        sessions: sessions.size,
      });
    }
    if (m === 'POST' && p === '/api/owner/settings') {
      const b = await readJson(req);
      if ('signupsOpen' in b) { db.settings.signupsOpen = !!b.signupsOpen; log(me.id, 'security', db.settings.signupsOpen ? 'Sign-ups opened' : 'Sign-ups closed', '', me.nickname); }
      if ('announcement' in b) { db.settings.announcement = str(b.announcement, 300); log(me.id, 'profile', 'Announcement ' + (db.settings.announcement ? 'set' : 'cleared'), db.settings.announcement, me.nickname); }
      persist();
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/owner/perms') {
      const b = await readJson(req);
      const t = db.users.find(u => u.id === b.userId);
      if (!t) throw fail(404, 'No such member');
      if (!PERMS.includes(b.perm)) throw fail(400, 'Unknown permission');
      t.perms = { createChannels: false, deleteMessages: false, viewEmails: false, ...(t.perms || {}) };
      t.perms[b.perm] = !!b.value;
      const label = { createChannels: 'create/delete channels', deleteMessages: 'delete messages', viewEmails: 'see other accounts\' emails' }[b.perm];
      log(t.id, 'security', `Permission ${b.value ? 'granted' : 'revoked'}`, label, me.nickname);
      persist();
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/owner/signout-all') {
      let n = 0;
      for (const [t, s] of sessions) if (s.uid !== me.id) { sessions.delete(t); n++; }
      log(me.id, 'security', 'Signed out all other sessions', `${n} sessions`, me.nickname); persist();
      return send(res, 200, { ok: true, sessions: n });
    }
    if (m === 'GET' && p === '/api/owner/backup') {
      const out = JSON.stringify({ exportedAt: now(), note: 'Password hashes and uploaded file contents are not included.',
        users: db.users.map(clean), crews: db.crews, channels: db.channels, messages: db.messages, logs: db.logs, flags: db.flags, saves: db.saves, settings: db.settings }, null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="scadmin-backup-${now().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
      return res.end(out);
    }
    throw fail(404, 'Unknown endpoint');
  }

  if (p === '/api/invite') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    if (m === 'POST') { db.settings.inviteCode = crypto.randomBytes(5).toString('hex'); persist(); }
    return send(res, 200, { code: db.settings.inviteCode });
  }

  if (m === 'POST' && p === '/api/logout') {
    const t = parseCookies(req).sid; sessions.delete(t);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (m === 'GET' && p === '/api/me') return send(res, 200, clean(me));

  if (m === 'GET' && p === '/api/users') {
    const q = str(url.searchParams.get('q')).toLowerCase();
    let list = isAdmin(me) ? db.users : [me];
    if (q) list = list.filter(u => [u.nickname, canSeeEmail(me, u.id) ? u.email : '', u.id, ...(u.linked || []).map(l => l.name), ...crewsOf(u.id).map(c => c.name)].join(' ').toLowerCase().includes(q));
    return send(res, 200, list.map(u => ({ id: u.id, nickname: u.nickname, email: canSeeEmail(me, u.id) ? u.email : '', emailHidden: !canSeeEmail(me, u.id), role: u.role, status: u.status, color: u.color, lastLogin: u.lastLogin, memberSince: u.memberSince, perms: u.perms || {} })));
  }
  if (m === 'GET' && p === '/api/overview') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    const hours = db.users.reduce((s, u) => s + (u.games || []).reduce((a, g) => a + (+g.hours || 0), 0), 0);
    return send(res, 200, {
      members: db.users.length, restricted: db.users.filter(u => u.status !== 'active').length,
      hours, saves: db.saves.length, crews: db.crews.length, openFlags: db.flags.filter(x => x.status === 'open').length,
      recent: db.logs.slice(-15).reverse().map(l => ({ ...viewLog(me, l), nickname: (db.users.find(u => u.id === l.userId) || {}).nickname || '?' })),
    });
  }
  if (m === 'POST' && p === '/api/users') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    const b = await readJson(req);
    const nick = str(b.nickname, 24), email = str(b.email).toLowerCase(), pw = String(b.password || '');
    if (nick.length < 3) throw fail(400, 'Nickname must be 3+ characters');
    if (!validEmail(email)) throw fail(400, 'Invalid email');
    if (pw.length < 8) throw fail(400, 'Temporary password must be 8+ characters');
    if (db.users.some(u => u.nickname.toLowerCase() === nick.toLowerCase())) throw fail(409, 'Nickname taken');
    if (db.users.some(u => u.email === email)) throw fail(409, 'That email cannot be used');
    const u = makeUser({ nickname: nick, email, role: 'member', passHash: hashPw(pw) });
    db.users.push(u);
    log(u.id, 'profile', 'Account created', 'By ' + me.nickname, me.nickname);
    persist();
    return send(res, 200, viewUser(me, u));
  }

  // ---- team chat: channels, DMs, file sharing
  if (m === 'GET' && p === '/api/directory') {
    return send(res, 200, db.users.filter(u => u.status === 'active').map(u => ({ id: u.id, nickname: u.nickname, team: u.team, color: u.color, role: u.role })));
  }
  const chanOf = id => db.channels.find(c => c.id === id);
  const canSee = (c, u) => c && ((c.kind === 'channel' && !c.private) || c.members.includes(u.id));
  const msgView = x => {
    const au = db.users.find(u => u.id === x.userId);
    return { id: x.id, channelId: x.channelId, userId: x.userId, nickname: au ? au.nickname : '(deleted)', color: au && au.color, team: au && au.team, text: x.text, at: x.at, editedAt: x.editedAt, file: x.file };
  };
  const chanView = c => {
    const readAt = (me.reads && me.reads[c.id]) || me.memberSince;
    const msgs = db.messages.filter(x => x.channelId === c.id);
    let name = c.name;
    if (c.kind === 'dm') { const o = db.users.find(u => u.id === c.members.find(x => x !== me.id)); name = o ? o.nickname : '(deleted)'; }
    return { id: c.id, name, kind: c.kind, private: c.private, topic: c.topic, members: c.kind === 'dm' ? [] : c.members.length,
      unread: msgs.filter(x => x.at > readAt && x.userId !== me.id).length, last: msgs.length ? msgs[msgs.length - 1].at : c.createdAt };
  };
  const postMsg = (c, text, file) => {
    const msg = { id: uid() + uid(), channelId: c.id, userId: me.id, text, at: now(), editedAt: null, file: file || null };
    db.messages.push(msg);
    me.reads = me.reads || {}; me.reads[c.id] = msg.at;
    persist();
    return msgView(msg);
  };
  if (m === 'GET' && p === '/api/chat/channels') {
    return send(res, 200, db.channels.filter(c => canSee(c, me)).map(chanView).sort((a, b) => (a.last < b.last ? 1 : -1)));
  }
  if (m === 'POST' && p === '/api/chat/channels') {
    if (!can(me, 'createChannels')) throw fail(403, 'You need permission from the owner to create channels');
    const b = await readJson(req);
    const name = str(b.name, 24).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    if (name.length < 2) throw fail(400, 'Channel name must be 2+ characters (letters, numbers, dashes)');
    if (db.channels.some(c => c.kind === 'channel' && c.name === name)) throw fail(409, 'Channel already exists');
    const mem = new Set([me.id]);
    for (const n of (Array.isArray(b.members) ? b.members : [])) { const t = db.users.find(u => u.nickname.toLowerCase() === str(n).toLowerCase()); if (t) mem.add(t.id); }
    const c = { id: uid(), name, topic: str(b.topic, 120), kind: 'channel', private: !!b.private, members: [...mem], createdAt: now(), createdBy: me.nickname };
    db.channels.push(c); persist();
    return send(res, 200, chanView(c));
  }
  if (m === 'POST' && p === '/api/chat/dm') {
    const b = await readJson(req);
    const t = db.users.find(u => u.id === b.userId && u.status === 'active');
    if (!t || t.id === me.id) throw fail(400, 'Pick another member');
    let c = db.channels.find(x => x.kind === 'dm' && x.members.includes(me.id) && x.members.includes(t.id));
    if (!c) { c = { id: uid(), name: '', topic: '', kind: 'dm', private: true, members: [me.id, t.id], createdAt: now(), createdBy: me.nickname }; db.channels.push(c); persist(); }
    return send(res, 200, chanView(c));
  }
  if ((r = p.match(/^\/api\/chat\/channels\/([a-f0-9]+)(\/.*)?$/))) {
    const c = chanOf(r[1]);
    if (!canSee(c, me)) throw fail(404, 'No such channel');
    const sub = r[2] || '';
    if (m === 'DELETE' && !sub) {
      if (!can(me, 'createChannels') || c.kind !== 'channel') throw fail(403, 'You need permission from the owner to delete channels');
      dropChannel(c); persist();
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && sub === '/messages') {
      const since = url.searchParams.get('since');
      let list = db.messages.filter(x => x.channelId === c.id);
      list = since ? list.filter(x => x.at > since).slice(-200) : list.slice(-150);
      const last = db.messages.filter(x => x.channelId === c.id).slice(-1)[0];
      me.reads = me.reads || {};
      if (last && (me.reads[c.id] || '') < last.at) { me.reads[c.id] = last.at; persist(); }
      return send(res, 200, list.map(msgView));
    }
    if (m === 'POST' && sub === '/messages') {
      const b = await readJson(req);
      const text = String(b.text ?? '').trim().slice(0, 4000);
      if (!text) throw fail(400, 'Empty message');
      return send(res, 200, postMsg(c, text));
    }
    if (m === 'POST' && sub === '/upload') {
      const name = hdrName(req, 'file.bin');
      let text = ''; try { text = decodeURIComponent(String(req.headers['x-text'] || '')).trim().slice(0, 4000); } catch { /* ignore bad caption */ }
      const body = await readBody(req, MAX_UPLOAD);
      if (!body.length) throw fail(400, 'Empty file');
      const file = { id: uid() + uid(), name, size: body.length };
      fs.writeFileSync(path.join(FILES, file.id), body);
      return send(res, 200, postMsg(c, text, file));
    }
  }
  if ((r = p.match(/^\/api\/chat\/messages\/([a-f0-9]+)$/))) {
    const x = db.messages.find(z => z.id === r[1]);
    const c = x && chanOf(x.channelId);
    if (!x || !canSee(c, me)) throw fail(404, 'No such message');
    if (m === 'PATCH') {
      if (x.userId !== me.id) throw fail(403, 'You can only edit your own messages');
      const b = await readJson(req);
      const text = String(b.text ?? '').trim().slice(0, 4000);
      if (!text) throw fail(400, 'Empty message');
      x.text = text; x.editedAt = now(); persist();
      return send(res, 200, msgView(x));
    }
    if (m === 'DELETE') {
      if (!can(me, 'deleteMessages')) throw fail(403, 'You need permission from the owner to delete messages');
      if (x.file) fs.rmSync(path.join(FILES, x.file.id), { force: true });
      db.messages = db.messages.filter(z => z !== x); persist();
      return send(res, 200, { ok: true });
    }
  }
  if (m === 'GET' && (r = p.match(/^\/api\/chat\/files\/([a-f0-9]+)$/))) {
    const x = db.messages.find(z => z.file && z.file.id === r[1]);
    if (!x || !canSee(chanOf(x.channelId), me)) throw fail(404, 'No such file');
    // inline only for a whitelist of image/video types; everything else is a forced download
    const MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg' };
    const inline = url.searchParams.get('inline') === '1' && MEDIA[x.file.name.split('.').pop().toLowerCase()];
    const size = x.file.size;
    let start = 0, end = size - 1, code = 200;
    const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rg && (rg[1] || rg[2])) {       // Range support so videos can seek / resume
      if (rg[1] === '') start = Math.max(0, size - +rg[2]);
      else { start = +rg[1]; if (rg[2]) end = Math.min(end, +rg[2]); }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      code = 206;
    }
    res.writeHead(code, { 'Content-Type': inline || 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(code === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}), 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${x.file.name.replace(/"/g, '')}"` });
    return fs.createReadStream(path.join(FILES, x.file.id), { start, end }).pipe(res);
  }

  // ---- game schema, global audit log, moderation queue
  if (m === 'GET' && p === '/api/games') return send(res, 200, GAMES);
  if (m === 'GET' && p === '/api/logs') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    const cat = url.searchParams.get('category'), q = str(url.searchParams.get('q')).toLowerCase();
    let l = db.logs.map(x => ({ ...viewLog(me, x), nickname: (db.users.find(u => u.id === x.userId) || {}).nickname || '(deleted)' }));
    if (cat && cat !== 'all') l = l.filter(x => x.category === cat);
    if (q) l = l.filter(x => (x.nickname + x.action + x.detail + x.by).toLowerCase().includes(q));
    return send(res, 200, l.slice(-300).reverse());
  }
  if (m === 'POST' && p === '/api/flags') {
    const b = await readJson(req);
    const t = db.users.find(u => u.id === b.userId);
    if (!t) throw fail(404, 'No such member');
    const reason = str(b.reason, 400);
    if (reason.length < 3) throw fail(400, 'Give a reason');
    db.flags.push({ id: uid(), userId: t.id, reason, by: me.nickname, at: now(), status: 'open' });
    log(t.id, 'moderation', 'Reported / flagged', reason, me.nickname);
    persist();
    return send(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/api/flags') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    const st = url.searchParams.get('status');
    return send(res, 200, db.flags.filter(x => !st || x.status === st).reverse()
      .map(x => ({ ...x, nickname: (db.users.find(u => u.id === x.userId) || {}).nickname || '(deleted)' })));
  }
  if ((r = p.match(/^\/api\/flags\/([a-f0-9]+)\/resolve$/)) && m === 'POST') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    const x = db.flags.find(z => z.id === r[1]);
    if (!x) throw fail(404, 'No such flag');
    const b = await readJson(req);
    x.status = 'resolved'; x.resolvedBy = me.nickname; x.resolvedAt = now(); x.resolution = str(b.resolution, 300);
    log(x.userId, 'moderation', 'Flag resolved', x.resolution, me.nickname);
    persist();
    return send(res, 200, { ok: true });
  }

  // ---- crews
  const crewView = c => ({
    id: c.id, name: c.name, tag: c.tag, description: c.description, createdAt: c.createdAt,
    members: c.members.map(x => ({ ...x, nickname: (db.users.find(u => u.id === x.userId) || {}).nickname || '?', color: (db.users.find(u => u.id === x.userId) || {}).color })),
  });
  const leaderId = c => (c.members.find(x => x.rank === 'Leader') || {}).userId;
  if (m === 'GET' && p === '/api/crews') {
    const list = isAdmin(me) ? db.crews : db.crews.filter(c => c.members.some(x => x.userId === me.id));
    return send(res, 200, list.map(c => ({ id: c.id, name: c.name, tag: c.tag, count: c.members.length, leader: (db.users.find(u => u.id === leaderId(c)) || {}).nickname })));
  }
  if (m === 'POST' && p === '/api/crews') {
    const b = await readJson(req);
    const name = str(b.name, 40), tag = str(b.tag, 4).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (name.length < 3) throw fail(400, 'Crew name must be 3+ characters');
    if (db.crews.some(c => c.name.toLowerCase() === name.toLowerCase())) throw fail(409, 'Crew name taken');
    const lead = isAdmin(me) && b.leaderId ? db.users.find(u => u.id === b.leaderId) : me;
    if (!lead) throw fail(404, 'No such leader');
    const c = { id: uid(), name, tag, description: str(b.description, 300), createdAt: now(), members: [{ userId: lead.id, rank: 'Leader', joinedAt: now() }] };
    db.crews.push(c);
    log(lead.id, 'profile', 'Crew created', name, me.nickname);
    persist();
    return send(res, 200, crewView(c));
  }
  if ((r = p.match(/^\/api\/crews\/([a-f0-9]+)(\/.*)?$/))) {
    const c = db.crews.find(x => x.id === r[1]);
    if (!c) throw fail(404, 'No such crew');
    const isMember = c.members.some(x => x.userId === me.id);
    if (!isAdmin(me) && !isMember) throw fail(403, 'Not allowed');
    const canManage = isAdmin(me) || leaderId(c) === me.id;
    const sub = r[2] || '';
    if (m === 'GET' && !sub) return send(res, 200, crewView(c));
    if (m !== 'GET' && !canManage && !(m === 'DELETE' && sub === '/members/' + me.id)) throw fail(403, 'Only the crew leader or an admin can do that');
    if (m === 'PATCH' && !sub) {
      const b = await readJson(req);
      if ('name' in b) {
        const n = str(b.name, 40);
        if (n.length < 3) throw fail(400, 'Crew name must be 3+ characters');
        if (db.crews.some(x => x.id !== c.id && x.name.toLowerCase() === n.toLowerCase())) throw fail(409, 'Crew name taken');
        c.name = n;
      }
      if ('tag' in b) c.tag = str(b.tag, 4).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if ('description' in b) c.description = str(b.description, 300);
      for (const x of c.members) log(x.userId, 'profile', 'Crew details updated', c.name, me.nickname);
      persist();
      return send(res, 200, crewView(c));
    }
    if (m === 'DELETE' && !sub) {
      for (const x of c.members) log(x.userId, 'profile', 'Crew disbanded', c.name, me.nickname);
      db.crews = db.crews.filter(x => x.id !== c.id);
      persist();
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && sub === '/members') {
      const b = await readJson(req);
      const nm = str(b.nickname).toLowerCase();
      const t = db.users.find(u => u.id === b.userId || (nm && u.nickname.toLowerCase() === nm));
      if (!t) throw fail(404, 'No member with that nickname');
      if (c.members.some(x => x.userId === t.id)) throw fail(409, 'Already in this crew');
      const rank = CREW_RANKS.includes(b.rank) && b.rank !== 'Leader' ? b.rank : 'Muscle';
      c.members.push({ userId: t.id, rank, joinedAt: now() });
      log(t.id, 'profile', 'Joined crew', c.name, me.nickname);
      persist();
      return send(res, 200, crewView(c));
    }
    if (m === 'POST' && sub === '/leader') {
      const b = await readJson(req);
      const nm = c.members.find(x => x.userId === b.userId);
      if (!nm) throw fail(404, 'Not a member of this crew');
      for (const x of c.members) if (x.rank === 'Leader') x.rank = 'Commissioner';
      nm.rank = 'Leader';
      log(nm.userId, 'profile', 'Became crew leader', c.name, me.nickname);
      persist();
      return send(res, 200, crewView(c));
    }
    if ((r = sub.match(/^\/members\/([a-f0-9]+)$/))) {
      const x = c.members.find(z => z.userId === r[1]);
      if (!x) throw fail(404, 'Not a member');
      if (m === 'PATCH') {
        const b = await readJson(req);
        if (!CREW_RANKS.includes(b.rank) || b.rank === 'Leader' || x.rank === 'Leader') throw fail(400, 'Use "make leader" to change the leader');
        x.rank = b.rank;
        persist();
        return send(res, 200, crewView(c));
      }
      if (m === 'DELETE') {
        if (x.rank === 'Leader' && c.members.length > 1) throw fail(400, 'Transfer leadership first');
        c.members = c.members.filter(z => z !== x);
        log(x.userId, 'profile', 'Left / removed from crew', c.name, me.nickname);
        if (!c.members.length) db.crews = db.crews.filter(z => z.id !== c.id);
        persist();
        return send(res, 200, { ok: true });
      }
    }
    throw fail(404, 'Unknown endpoint');
  }

  // ---- per-user routes
  if ((r = p.match(/^\/api\/users\/([a-f0-9]+)(\/.*)?$/))) {
    const target = db.users.find(u => u.id === r[1]);
    if (!target) throw fail(404, 'No such member');
    if (!isAdmin(me) && me.id !== target.id) throw fail(403, 'Not allowed');
    const sub = r[2] || '';
    const self = me.id === target.id;

    if (m === 'GET' && sub === '') return send(res, 200, viewUser(me, target));

    if (m === 'DELETE' && sub === '') {
      if (me.role !== 'owner') throw fail(403, 'Owner only');
      if (self) throw fail(400, 'You cannot delete yourself');
      dropSessions(target.id);
      for (const s of db.saves.filter(s => s.userId === target.id)) fs.rmSync(path.join(SAVES, s.id), { force: true });
      db.saves = db.saves.filter(s => s.userId !== target.id);
      db.logs = db.logs.filter(l => l.userId !== target.id);
      db.flags = db.flags.filter(x => x.userId !== target.id);
      for (const c of db.channels.filter(c => c.kind === 'dm' && c.members.includes(target.id))) dropChannel(c);
      for (const c of db.channels) c.members = c.members.filter(x => x !== target.id);
      for (const c of db.crews) c.members = c.members.filter(x => x.userId !== target.id);
      db.crews = db.crews.filter(c => c.members.length);
      db.users = db.users.filter(u => u.id !== target.id);
      persist();
      return send(res, 200, { ok: true });
    }

    if (m === 'PATCH' && sub === '') {
      const b = await readJson(req);
      const changes = [];
      if ('nickname' in b) {
        const v = str(b.nickname, 24);
        if (v.length < 3) throw fail(400, 'Nickname must be 3+ characters');
        if (v !== target.nickname) {
          if (db.users.some(u => u.id !== target.id && u.nickname.toLowerCase() === v.toLowerCase())) throw fail(409, 'Nickname taken');
          log(target.id, 'nickname', 'Nickname changed', `${target.nickname} -> ${v}`, me.nickname);
          target.nickname = v; target.color = colorFor(v);
        }
      }
      if ('email' in b) {
        if (!canSeeEmail(me, target.id)) throw fail(403, 'You need permission from the owner to change or see other accounts\' emails');
        const v = str(b.email).toLowerCase();
        if (!validEmail(v)) throw fail(400, 'Invalid email');
        if (v !== target.email) {
          if (db.users.some(u => u.id !== target.id && u.email === v)) throw fail(409, 'That email cannot be used');
          log(target.id, 'email', 'Email changed', `${target.email} -> ${v}`, me.nickname);
          target.emailHistory = [{ email: target.email, until: now() }, ...(target.emailHistory || [])].slice(0, 20);
          target.email = v; target.emailChanged = now();
        }
      }
      for (const k of ['dob', 'country', 'language', 'bio']) {
        if (k in b) {
          const v = str(b[k], k === 'bio' ? 500 : 60);
          if (v !== (target[k] || '')) { log(target.id, 'profile', `${k} updated`, '', me.nickname); target[k] = v; }
        }
      }
      if (isAdmin(me)) {
        if ('notes' in b) { target.notes = str(b.notes, 2000); log(target.id, 'profile', 'Admin notes updated', '', me.nickname); }
        if ('team' in b) {
          const v = str(b.team, 20);
          if (v !== (target.team || '')) { log(target.id, 'profile', 'Team changed', `${target.team || '-'} -> ${v || '-'}`, me.nickname); target.team = v; }
        }
      }
      if ('role' in b && me.role === 'owner' && ['admin', 'member'].includes(b.role) && target.role !== 'owner' && b.role !== target.role) {
        log(target.id, 'security', 'Role changed', `${target.role} -> ${b.role}`, me.nickname);
        target.role = b.role;
      }
      persist();
      return send(res, 200, viewUser(me, target));
    }

    if (m === 'POST' && sub === '/password') {
      const b = await readJson(req);
      const pw = String(b.password || '');
      if (pw.length < 8) throw fail(400, 'Password must be 8+ characters');
      if (self && !checkPw(String(b.current || ''), target.passHash)) throw fail(403, 'Current password is wrong');
      if (!self && target.role === 'owner') throw fail(403, 'Only the owner can change the owner password');
      target.passHash = hashPw(pw); target.passwordChanged = now();
      dropSessions(target.id);
      log(target.id, 'password', self ? 'Password changed' : 'Password reset by admin', '', me.nickname);
      persist();
      const out = { ok: true };
      // if you changed your own password you were just signed out; give a fresh session
      if (self) return send(res, 200, out, { 'Set-Cookie': `sid=${newSession(me.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
      return send(res, 200, out);
    }

    if (m === 'POST' && sub === '/signout') {
      dropSessions(target.id);
      log(target.id, 'security', 'All sessions signed out', '', me.nickname);
      persist();
      return send(res, 200, { ok: true });
    }

    if (m === 'PUT' && sub === '/linked') {
      const b = await readJson(req);
      if (!Array.isArray(b.linked)) throw fail(400, 'linked must be an array');
      target.linked = b.linked.slice(0, 30).map(l => ({ platform: str(l.platform, 30), name: str(l.name, 40) })).filter(l => l.platform && l.name);
      log(target.id, 'profile', 'Linked accounts updated', target.linked.map(l => l.platform).join(', '), me.nickname);
      persist();
      return send(res, 200, viewUser(me, target));
    }
    // ---- StatMaster
    const sm = sub.match(/^\/stats\/(\w+)(\/reset)?$/);
    if (sm && m !== 'GET') {
      if (!isAdmin(me)) throw fail(403, 'Admins only');
      const g = GAMES.find(x => x.key === sm[1]);
      if (!g) throw fail(404, 'Unknown game');
      const b = await readJson(req);
      const reason = str(b.reason, 200);
      if (reason.length < 3) throw fail(400, 'A reason is required for stat changes');
      target.stats ||= {};
      if (m === 'POST' && sm[2]) {
        target.stats[g.key] = {};
        log(target.id, 'stats', `${g.name}: character progress reset`, reason, me.nickname);
      } else if (m === 'PUT' && !sm[2]) {
        const cur = (target.stats[g.key] ||= {});
        for (const fd of g.fields) {
          if (!b.changes || !(fd.key in b.changes)) continue;
          let v = Math.round(+b.changes[fd.key]);
          if (!Number.isFinite(v)) throw fail(400, `${fd.label} must be a number`);
          v = Math.max(fd.min, Math.min(fd.max, v));
          const old = cur[fd.key] ?? fd.def;
          if (v !== old) { cur[fd.key] = v; log(target.id, 'stats', `${g.name}: ${fd.label} changed`, `${old} -> ${v} (${reason})`, me.nickname); }
        }
      } else throw fail(404, 'Unknown endpoint');
      persist();
      return send(res, 200, viewUser(me, target));
    }

    // ---- Moderation
    if (m === 'POST' && sub === '/moderation') {
      if (!isAdmin(me)) throw fail(403, 'Admins only');
      if (self) throw fail(400, 'You cannot moderate yourself');
      if (target.role === 'owner' || (target.role === 'admin' && me.role !== 'owner')) throw fail(403, 'Not allowed on this account');
      const b = await readJson(req);
      const act = b.action, reason = str(b.reason, 300);
      const days = Math.max(0, Math.min(3650, Math.round(+b.days || 0)));
      if (act === 'unban') {
        if (target.status === 'active') throw fail(400, 'Account is already active');
        log(target.id, 'moderation', 'Restriction lifted', reason, me.nickname);
        target.status = 'active'; target.ban = null;
      } else if (act === 'suspend' || act === 'ban') {
        if (reason.length < 3) throw fail(400, 'A reason is required');
        const d = act === 'suspend' ? (days || 7) : days;
        target.status = act === 'ban' ? 'banned' : 'suspended';
        target.ban = { reason, by: me.nickname, at: now(), until: d ? new Date(Date.now() + d * 864e5).toISOString() : null };
        dropSessions(target.id);
        log(target.id, 'moderation', act === 'ban' ? 'Account banned' : 'Account suspended', `${reason} (${d ? d + ' days' : 'permanent'})`, me.nickname);
      } else throw fail(400, 'Unknown action');
      persist();
      return send(res, 200, viewUser(me, target));
    }

    if (m === 'PUT' && sub === '/games') {
      const b = await readJson(req);
      if (!Array.isArray(b.games)) throw fail(400, 'games must be an array');
      target.games = b.games.slice(0, 40).map(g => ({
        game: str(g.game, 60), hours: Math.max(0, Math.min(100000, +g.hours || 0)),
        lastPlayed: str(g.lastPlayed, 10), note: str(g.note, 200),
      })).filter(g => g.game);
      log(target.id, 'profile', 'Games updated', target.games.length + ' titles', me.nickname);
      persist();
      return send(res, 200, viewUser(me, target));
    }

    if (m === 'GET' && sub === '/logs') {
      const cat = url.searchParams.get('category');
      let l = db.logs.filter(x => x.userId === target.id);
      if (cat && cat !== 'all') l = l.filter(x => x.category === cat);
      return send(res, 200, l.slice(-200).reverse().map(x => viewLog(me, x)));
    }

    if (m === 'GET' && sub === '/saves') return send(res, 200, db.saves.filter(s => s.userId === target.id).reverse());
    if (m === 'POST' && sub === '/saves') {
      const name = hdrName(req, 'save.bin');
      const game = str(req.headers['x-game'] || 'Unsorted', 60);
      const body = await readBody(req, MAX_UPLOAD);
      if (!body.length) throw fail(400, 'Empty file');
      const rec = { id: uid() + uid(), userId: target.id, game, name, size: body.length, uploadedAt: now(), by: me.nickname };
      fs.writeFileSync(path.join(SAVES, rec.id), body);
      db.saves.push(rec);
      log(target.id, 'profile', 'Cloud save uploaded', `${game}: ${name}`, me.nickname);
      persist();
      return send(res, 200, rec);
    }
  }

  if ((r = p.match(/^\/api\/saves\/([a-f0-9]+)$/))) {
    const s = db.saves.find(x => x.id === r[1]);
    if (!s) throw fail(404, 'No such save');
    if (!isAdmin(me) && me.id !== s.userId) throw fail(403, 'Not allowed');
    if (m === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': s.size,
        'Content-Disposition': `attachment; filename="${s.name.replace(/"/g, '')}"`, 'X-Content-Type-Options': 'nosniff',
      });
      return fs.createReadStream(path.join(SAVES, s.id)).pipe(res);
    }
    if (m === 'DELETE') {
      fs.rmSync(path.join(SAVES, s.id), { force: true });
      db.saves = db.saves.filter(x => x.id !== s.id);
      log(s.userId, 'profile', 'Cloud save deleted', `${s.game}: ${s.name}`, me.nickname);
      persist();
      return send(res, 200, { ok: true });
    }
  }
  throw fail(404, 'Unknown endpoint');
}

function makeUser(o) {
  return {
    id: uid(), nickname: o.nickname, email: o.email, role: o.role, status: 'active', passHash: o.passHash,
    color: colorFor(o.nickname), memberSince: now(), emailChanged: now(), passwordChanged: now(),
    dob: '', country: '', language: 'English', bio: '', team: '', notes: '', lastLogin: null, lastIp: '', loginCount: 0, loginHistory: [],
    emailHistory: [], linked: [], games: [], stats: {}, ban: null, perms: { createChannels: false, deleteMessages: false, viewEmails: false },
  };
}

// ---------------------------------------------------------------- chat bootstrap
const FILES = path.join(DATA, 'files');
fs.mkdirSync(FILES, { recursive: true });
db.channels ||= []; db.messages ||= [];
function dropChannel(c) {
  for (const x of db.messages.filter(z => z.channelId === c.id && z.file)) fs.rmSync(path.join(FILES, x.file.id), { force: true });
  db.messages = db.messages.filter(z => z.channelId !== c.id);
  db.channels = db.channels.filter(z => z !== c);
}
if (!db.channels.length) {
  for (const [name, topic] of [['general', 'Everyone'], ['dev', 'Developers'], ['testers', 'Testers and QA'], ['bugs', 'Bug reports and repro steps'], ['builds', 'Builds, mods and files']]) {
    db.channels.push({ id: uid(), name, topic, kind: 'channel', private: false, members: [], createdAt: now(), createdBy: 'system' });
  }
  persist();
}

// ---------------------------------------------------------------- static files
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};
function serveStatic(req, res, url) {
  let f = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const full = path.normalize(path.join(PUBLIC, f));
  if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, SEC); return res.end('Not found');
  }
  res.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.code ? e.message : 'Server error' });
    if (!e.code) console.error(e);
  }
}).listen(PORT, HOST, () => {
  console.log(`SCAdmin running on http://localhost:${PORT}  (listening on ${HOST})`);
});
