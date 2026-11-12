/* SCAdmin -> Supabase adapter.
 * app.js talks to a tiny REST-style API (api('GET','/api/users')). On GitHub Pages there is no server,
 * so this file implements the same endpoints on top of Supabase (Auth + Postgres RLS/RPC + Storage).
 * Works in browsers and in Node (for tests): SCAApi.create(supabaseClient). */
(function (root) {
  'use strict';
  const GAMES = [
    { key: 'gtav', name: 'Grand Theft Auto V', fields: [
      { key: 'rank', label: 'Rank', min: 1, max: 8000, def: 1 }, { key: 'cash', label: 'Cash ($)', min: 0, max: 2147483647, def: 0 },
      { key: 'bank', label: 'Bank ($)', min: 0, max: 2147483647, def: 0 }, { key: 'kills', label: 'Kills', min: 0, max: 2147483647, def: 0 },
      { key: 'deaths', label: 'Deaths', min: 0, max: 2147483647, def: 0 }, { key: 'missions', label: 'Missions completed', min: 0, max: 100000, def: 0 },
      { key: 'races', label: 'Races won', min: 0, max: 100000, def: 0 }] },
    { key: 'rdr2', name: 'Red Dead Redemption 2', fields: [
      { key: 'rank', label: 'Rank', min: 1, max: 999, def: 1 }, { key: 'cash', label: 'Cash ($)', min: 0, max: 2147483647, def: 0 },
      { key: 'gold', label: 'Gold bars', min: 0, max: 100000, def: 0 }, { key: 'honor', label: 'Honor', min: -1000, max: 1000, def: 0 },
      { key: 'kills', label: 'Kills', min: 0, max: 2147483647, def: 0 }, { key: 'deaths', label: 'Deaths', min: 0, max: 2147483647, def: 0 },
      { key: 'bounties', label: 'Bounties collected', min: 0, max: 100000, def: 0 }] },
  ];
  const MAX_UPLOAD = 25 * 1024 * 1024;
  const UUID = '[0-9a-f-]{36}';
  const AUTH_DOMAIN = '@scadmin.app'; // synthetic login addresses; nobody receives mail here

  function create(sb) {
    const err = (m, status) => Object.assign(new Error(m), { status: status || 400 });
    const friendly = e => {
      const m = e.message || String(e), d = (e.details || '') + m;
      if (e.code === '23505') return /nick/i.test(d) ? 'Nickname taken' : /crew/i.test(d) ? 'Crew name taken' : 'Already exists';
      if (e.code === '42501' || /row-level security/i.test(m)) return 'Not allowed';
      return m;
    };
    const ok = r => {
      if (r.error) {
        const e = r.error;
        const st = e.code === 'PGRST301' || e.status === 401 || /JWT (expired|invalid)/i.test(e.message || '') ? 401 : (e.status && e.status < 600 ? e.status : 400);
        throw err(friendly(e), st);
      }
      return r.data;
    };

    let dirCache = null, dirAt = 0;
    const urlCache = new Map();
    const readMark = new Map();
    const isImg = n => /\.(png|jpe?g|gif|webp)$/i.test(n || '');

    async function sessionUser() {
      const { data } = await sb.auth.getSession();
      if (!data || !data.session) throw err('Not signed in', 401);
      return data.session.user;
    }
    async function dir(force) {
      if (force || !dirCache || Date.now() - dirAt > 20000) {
        dirCache = new Map(ok(await sb.from('directory').select('*')).map(r => [r.id, r]));
        dirAt = Date.now();
      }
      return dirCache;
    }
    async function signed(path, download) {
      const key = path + '|' + (download || '');
      const c = urlCache.get(key);
      if (c && c.exp > Date.now()) return c.url;
      const { data, error } = await sb.storage.from('files').createSignedUrl(path, 3600, download ? { download } : undefined);
      if (error || !data) return '';
      urlCache.set(key, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
      return data.signedUrl;
    }

    const toUser = (p, crews, notes) => ({
      id: p.id, nickname: p.nickname, email: p.email, role: p.role, status: p.status, ban: p.ban, team: p.team, dob: p.dob, country: p.country,
      language: p.language, bio: p.bio, color: p.color, memberSince: p.member_since, emailChanged: p.email_changed, passwordChanged: p.password_changed,
      lastLogin: p.last_login, lastIp: '', loginCount: p.login_count, loginHistory: p.login_history || [], emailHistory: p.email_history || [],
      linked: p.linked || [], games: p.games || [], stats: p.stats || {}, notes: notes || '', crews: crews || [],
    });
    async function getUser(id) {
      const p = ok(await sb.from('profiles').select('*').eq('id', id).maybeSingle());
      if (!p) throw err('No such member', 404);
      const cm = ok(await sb.from('crew_members').select('rank, crews(id,name,tag)').eq('user_id', id));
      const crews = cm.filter(x => x.crews).map(x => ({ id: x.crews.id, name: x.crews.name, tag: x.crews.tag, rank: x.rank }));
      const n = ok(await sb.from('admin_notes').select('notes').eq('user_id', id).maybeSingle());
      return toUser(p, crews, n && n.notes);
    }
    const logView = l => ({ id: l.id, userId: l.user_id, category: l.category, action: l.action, detail: l.detail, by: l.by_name, at: l.at });
    const flagView = (f, d) => ({ id: f.id, userId: f.user_id, reason: f.reason, by: f.by_name, at: f.at, status: f.status, resolvedBy: f.resolved_by,
      resolvedAt: f.resolved_at, resolution: f.resolution, nickname: (d.get(f.user_id) || {}).nickname || '(deleted)' });
    async function msgView(m, d) {
      const au = d.get(m.user_id);
      let file = null;
      if (m.file && m.file.path) file = { id: m.file.path, name: m.file.name, size: m.file.size, url: await signed(m.file.path, isImg(m.file.name) ? undefined : m.file.name) };
      return { id: m.id, channelId: m.channel_id, userId: m.user_id, nickname: au ? au.nickname : '(deleted)', color: au && au.color, team: au && au.team,
        text: m.text, at: m.at, editedAt: m.edited_at, file };
    }
    async function channelView(id) {
      const list = ok(await sb.rpc('chat_channels'));
      return list.find(c => c.id === id);
    }
    async function crewView(id) {
      const c = ok(await sb.from('crews').select('*, crew_members(user_id, rank, joined_at)').eq('id', id).maybeSingle());
      if (!c) throw err('No such crew', 404);
      const d = await dir();
      return { id: c.id, name: c.name, tag: c.tag, description: c.description, createdAt: c.created_at,
        members: c.crew_members.map(m => ({ userId: m.user_id, rank: m.rank, joinedAt: m.joined_at, nickname: (d.get(m.user_id) || {}).nickname || '?', color: (d.get(m.user_id) || {}).color })) };
    }
    const safeName = n => String(n || 'file.bin').replace(/\\/g, '/').split('/').pop().replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file.bin';
    const rid = () => (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : require('crypto').randomUUID());

    // ---------------------------------------------------------------- auth
    async function login(b) {
      const nick = String(b.login || '').trim();
      const em = ok(await sb.rpc('login_email', { nick }));
      if (!em) throw err('Wrong nickname or password', 401);
      const r = await sb.auth.signInWithPassword({ email: em, password: String(b.password || '') });
      if (r.error) throw err('Wrong nickname or password', 401);
      await sb.rpc('lift_expired');
      const p = ok(await sb.from('profiles').select('status, ban').eq('id', r.data.user.id).maybeSingle());
      if (!p) { await sb.auth.signOut(); throw err('No profile for this account', 403); }
      if (p.status !== 'active') {
        await sb.auth.signOut();
        throw err(`This account is ${p.status}` + (p.ban && p.ban.reason ? ': ' + p.ban.reason : ''), 403);
      }
      await sb.rpc('record_login', { p_ua: typeof navigator !== 'undefined' ? String(navigator.userAgent || '').slice(0, 120) : '' });
      return { ok: true };
    }
    async function signup(b) {
      const nick = String(b.nickname || '').trim(), code = String(b.code || '').trim(), pw = String(b.password || ''), real = String(b.email || '').trim().toLowerCase();
      if (pw.length < 8) throw err('Password must be 8+ characters');
      if (real && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(real)) throw err('Invalid email');
      const msg = ok(await sb.rpc('check_signup', { nick, code }));
      if (msg) throw err(msg);
      const r = await sb.auth.signUp({ email: nick.toLowerCase() + AUTH_DOMAIN, password: pw, options: { data: { nickname: nick, code, email: real } } });
      if (r.error) throw err(r.error.message);
      if (!r.data.session) throw err("Account created, but Supabase wants email confirmation. In Supabase: Authentication > Providers > Email > turn OFF 'Confirm email', then sign in.");
      await sb.rpc('record_login', { p_ua: typeof navigator !== 'undefined' ? String(navigator.userAgent || '').slice(0, 120) : '' });
      return { ok: true };
    }

    // ---------------------------------------------------------------- router
    async function api(method, url, body) {
      const u = new URL(url, 'http://x'), p = u.pathname, q = u.searchParams, b = body || {};
      let r;
      if (method === 'GET' && p === '/api/status') return { needsSetup: ok(await sb.rpc('needs_setup')) };
      if (method === 'POST' && p === '/api/setup') return signup(b);
      if (method === 'POST' && p === '/api/login') return login(b);
      if (method === 'POST' && p === '/api/logout') { await sb.auth.signOut(); return { ok: true }; }

      const au = await sessionUser();
      if (method === 'GET' && p === '/api/me') {
        await sb.rpc('lift_expired');
        const mine = ok(await sb.from('profiles').select('id').eq('id', au.id).maybeSingle());
        if (!mine) { await sb.auth.signOut(); throw err('Not signed in', 401); }
        return getUser(au.id);
      }
      if (method === 'GET' && p === '/api/games') return GAMES;
      if (method === 'GET' && p === '/api/directory') return [...(await dir(true)).values()].filter(x => x.status === 'active');
      if (method === 'GET' && p === '/api/overview') return ok(await sb.rpc('admin_overview'));
      if (p === '/api/invite') {
        if (method === 'GET') return { code: ok(await sb.rpc('get_invite_code')) };
        if (method === 'POST') return { code: ok(await sb.rpc('rotate_invite_code')) };
      }

      if (method === 'GET' && p === '/api/users') {
        const needle = (q.get('q') || '').trim().toLowerCase();
        let rows = ok(await sb.from('profiles').select('*'));
        if (needle) {
          const cm = ok(await sb.from('crew_members').select('user_id, crews(name)'));
          const crewNames = id => cm.filter(x => x.user_id === id && x.crews).map(x => x.crews.name);
          rows = rows.filter(x => [x.nickname, x.email, x.id, ...(x.linked || []).map(l => l.name), ...crewNames(x.id)].join(' ').toLowerCase().includes(needle));
        }
        return rows.map(x => ({ id: x.id, nickname: x.nickname, email: x.email, role: x.role, status: x.status, color: x.color, lastLogin: x.last_login, memberSince: x.member_since }));
      }

      if ((r = p.match(new RegExp(`^/api/users/(${UUID})(/.*)?$`)))) {
        const id = r[1], sub = r[2] || '';
        if (method === 'GET' && sub === '') return getUser(id);
        if (method === 'DELETE' && sub === '') {
          const saves = ok(await sb.from('saves').select('path').eq('user_id', id));
          if (saves.length) await sb.storage.from('files').remove(saves.map(s => s.path));
          ok(await sb.rpc('admin_delete_user', { p_user: id }));
          return { ok: true };
        }
        if (method === 'PATCH' && sub === '') {
          const upd = {};
          if ('nickname' in b) {
            const v = String(b.nickname).trim();
            if (!/^[A-Za-z0-9_.-]{3,24}$/.test(v)) throw err('Nickname must be 3-24 characters (letters, numbers, _ . -)');
            upd.nickname = v;
          }
          if ('email' in b) {
            const v = String(b.email).trim().toLowerCase();
            if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw err('Invalid email');
            upd.email = v;
          }
          for (const k of ['dob', 'country', 'language', 'bio']) if (k in b) upd[k] = String(b[k]).trim().slice(0, k === 'bio' ? 500 : 60);
          if ('team' in b) upd.team = String(b.team).trim().slice(0, 20);
          if (Object.keys(upd).length) {
            const rows = ok(await sb.from('profiles').update(upd).eq('id', id).select('id'));
            if (!rows.length) throw err('Not allowed', 403);
          }
          if ('notes' in b) {
            ok(await sb.from('admin_notes').upsert({ user_id: id, notes: String(b.notes).slice(0, 2000) }));
            ok(await sb.rpc('log_event', { p_user: id, p_cat: 'profile', p_action: 'Admin notes updated', p_detail: '' }));
          }
          if ('role' in b) ok(await sb.rpc('admin_set_role', { p_user: id, p_role: b.role }));
          return getUser(id);
        }
        if (method === 'POST' && sub === '/password') {
          const pw = String(b.password || '');
          if (pw.length < 8) throw err('Password must be 8+ characters');
          if (id === au.id) {
            const me = ok(await sb.from('profiles').select('login_email').eq('id', id).maybeSingle());
            const re = await sb.auth.signInWithPassword({ email: me.login_email, password: String(b.current || '') });
            if (re.error) throw err('Current password is wrong', 403);
            const up = await sb.auth.updateUser({ password: pw });
            if (up.error) throw err(up.error.message);
            ok(await sb.from('profiles').update({ password_changed: new Date().toISOString() }).eq('id', id));
            ok(await sb.rpc('log_event', { p_user: id, p_cat: 'password', p_action: 'Password changed', p_detail: '' }));
            return { ok: true };
          }
          ok(await sb.rpc('admin_reset_password', { p_user: id, p_password: pw }));
          return { ok: true };
        }
        if (method === 'POST' && sub === '/signout') { ok(await sb.rpc('admin_signout', { p_user: id })); return { ok: true }; }
        if (method === 'PUT' && sub === '/linked') {
          if (!Array.isArray(b.linked)) throw err('linked must be an array');
          const linked = b.linked.slice(0, 30).map(l => ({ platform: String(l.platform || '').trim().slice(0, 30), name: String(l.name || '').trim().slice(0, 40) })).filter(l => l.platform && l.name);
          const rows = ok(await sb.from('profiles').update({ linked }).eq('id', id).select('id'));
          if (!rows.length) throw err('Not allowed', 403);
          return getUser(id);
        }
        if (method === 'PUT' && sub === '/games') {
          if (!Array.isArray(b.games)) throw err('games must be an array');
          const games = b.games.slice(0, 40).map(g => ({ game: String(g.game || '').trim().slice(0, 60), hours: Math.max(0, Math.min(100000, +g.hours || 0)),
            lastPlayed: String(g.lastPlayed || '').slice(0, 10), note: String(g.note || '').slice(0, 200) })).filter(g => g.game);
          const rows = ok(await sb.from('profiles').update({ games }).eq('id', id).select('id'));
          if (!rows.length) throw err('Not allowed', 403);
          return getUser(id);
        }
        if (method === 'GET' && sub === '/logs') {
          let qq = sb.from('logs').select('*').eq('user_id', id).order('at', { ascending: false }).order('id', { ascending: false }).limit(200);
          const cat = q.get('category'); if (cat && cat !== 'all') qq = qq.eq('category', cat);
          return ok(await qq).map(logView);
        }
        let sm;
        if ((sm = sub.match(/^\/stats\/(\w+)(\/reset)?$/))) {
          if (method === 'PUT' && !sm[2]) ok(await sb.rpc('admin_set_stats', { p_user: id, p_game: sm[1], p_changes: b.changes || {}, p_reason: b.reason || '' }));
          else if (method === 'POST' && sm[2]) ok(await sb.rpc('admin_reset_stats', { p_user: id, p_game: sm[1], p_reason: b.reason || '' }));
          else throw err('Unknown endpoint', 404);
          return getUser(id);
        }
        if (method === 'POST' && sub === '/moderation') {
          ok(await sb.rpc('admin_moderate', { p_user: id, p_action: b.action, p_reason: b.reason || '', p_days: Math.round(+b.days || 0) }));
          return getUser(id);
        }
        if (method === 'GET' && sub === '/saves') {
          const rows = ok(await sb.from('saves').select('*').eq('user_id', id).order('uploaded_at', { ascending: false }));
          return Promise.all(rows.map(async s => ({ id: s.id, userId: s.user_id, game: s.game, name: s.name, size: s.size, uploadedAt: s.uploaded_at, by: s.by_name, url: await signed(s.path, s.name) })));
        }
      }
      if (method === 'DELETE' && (r = p.match(new RegExp(`^/api/saves/(${UUID})$`)))) {
        const s = ok(await sb.from('saves').select('path').eq('id', r[1]).maybeSingle());
        if (!s) throw err('No such save', 404);
        await sb.storage.from('files').remove([s.path]);
        ok(await sb.from('saves').delete().eq('id', r[1]));
        return { ok: true };
      }

      if (method === 'GET' && p === '/api/logs') {
        let qq = sb.from('logs').select('*').order('at', { ascending: false }).order('id', { ascending: false }).limit(300);
        const cat = q.get('category'); if (cat && cat !== 'all') qq = qq.eq('category', cat);
        const d = await dir(), needle = (q.get('q') || '').trim().toLowerCase();
        let list = ok(await qq).map(l => ({ ...logView(l), nickname: (d.get(l.user_id) || {}).nickname || '(deleted)' }));
        if (needle) list = list.filter(x => (x.nickname + x.action + x.detail + x.by).toLowerCase().includes(needle));
        return list;
      }
      if (p === '/api/flags') {
        if (method === 'POST') { ok(await sb.rpc('report_member', { p_user: b.userId, p_reason: b.reason || '' })); return { ok: true }; }
        if (method === 'GET') {
          let qq = sb.from('flags').select('*').order('at', { ascending: false }).limit(100);
          const st = q.get('status'); if (st) qq = qq.eq('status', st);
          const d = await dir();
          return ok(await qq).map(f => flagView(f, d));
        }
      }
      if (method === 'POST' && (r = p.match(new RegExp(`^/api/flags/(${UUID})/resolve$`)))) {
        ok(await sb.rpc('resolve_flag', { p_flag: r[1], p_resolution: b.resolution || '' }));
        return { ok: true };
      }

      // ---- crews
      if (p === '/api/crews') {
        if (method === 'GET') {
          const d = await dir();
          return ok(await sb.from('crews').select('id,name,tag, crew_members(user_id,rank)')).map(c => ({
            id: c.id, name: c.name, tag: c.tag, count: c.crew_members.length,
            leader: ((d.get((c.crew_members.find(m => m.rank === 'Leader') || {}).user_id) || {}).nickname) }));
        }
        if (method === 'POST') {
          const id = ok(await sb.rpc('create_crew', { p_name: b.name || '', p_tag: b.tag || '', p_desc: b.description || '', p_leader: b.leaderId || null }));
          return crewView(id);
        }
      }
      if ((r = p.match(new RegExp(`^/api/crews/(${UUID})(/.*)?$`)))) {
        const id = r[1], sub = r[2] || '';
        if (method === 'GET' && !sub) return crewView(id);
        if (method === 'PATCH' && !sub) {
          const upd = {};
          if ('name' in b) { const n = String(b.name).trim(); if (n.length < 3 || n.length > 40) throw err('Crew name must be 3-40 characters'); upd.name = n; }
          if ('tag' in b) upd.tag = String(b.tag).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
          if ('description' in b) upd.description = String(b.description).slice(0, 300);
          const rows = ok(await sb.from('crews').update(upd).eq('id', id).select('id'));
          if (!rows.length) throw err('Only the crew leader or an admin can do that', 403);
          return crewView(id);
        }
        if (method === 'DELETE' && !sub) {
          const rows = ok(await sb.from('crews').delete().eq('id', id).select('id'));
          if (!rows.length) throw err('Only the crew leader or an admin can do that', 403);
          return { ok: true };
        }
        if (method === 'POST' && sub === '/members') { ok(await sb.rpc('crew_add_member', { p_crew: id, p_nick: b.nickname || '', p_rank: b.rank || 'Muscle' })); return crewView(id); }
        if (method === 'POST' && sub === '/leader') { ok(await sb.rpc('crew_set_leader', { p_crew: id, p_user: b.userId })); return crewView(id); }
        let m2;
        if ((m2 = sub.match(new RegExp(`^/members/(${UUID})$`)))) {
          if (method === 'PATCH') { ok(await sb.rpc('crew_set_rank', { p_crew: id, p_user: m2[1], p_rank: b.rank })); return crewView(id); }
          if (method === 'DELETE') { ok(await sb.rpc('crew_remove_member', { p_crew: id, p_user: m2[1] })); return { ok: true }; }
        }
      }

      // ---- chat
      if (method === 'GET' && p === '/api/chat/channels') return ok(await sb.rpc('chat_channels'));
      if (method === 'POST' && p === '/api/chat/channels') {
        const id = ok(await sb.rpc('create_channel', { p_name: b.name || '', p_private: !!b.private, p_members: Array.isArray(b.members) ? b.members : [], p_topic: b.topic || '' }));
        return channelView(id);
      }
      if (method === 'POST' && p === '/api/chat/dm') { const id = ok(await sb.rpc('get_or_create_dm', { p_user: b.userId })); return channelView(id); }
      if ((r = p.match(new RegExp(`^/api/chat/channels/(${UUID})(/.*)?$`)))) {
        const cid = r[1], sub = r[2] || '';
        if (method === 'DELETE' && !sub) {
          const files = ok(await sb.from('messages').select('file').eq('channel_id', cid).not('file', 'is', null));
          if (files.length) await sb.storage.from('files').remove(files.map(f => f.file.path));
          const rows = ok(await sb.from('channels').delete().eq('id', cid).select('id'));
          if (!rows.length) throw err('Admins only', 403);
          return { ok: true };
        }
        if (method === 'GET' && sub === '/messages') {
          const rows = ok(await sb.from('messages').select('*').eq('channel_id', cid).order('at', { ascending: false }).limit(150)).reverse();
          const d = await dir();
          if (rows.length && (readMark.get(cid) || '') < rows[rows.length - 1].at) {
            await sb.rpc('chat_mark_read', { p_channel: cid });
            readMark.set(cid, rows[rows.length - 1].at);
          }
          return Promise.all(rows.map(m => msgView(m, d)));
        }
        if (method === 'POST' && sub === '/messages') {
          const text = String(b.text ?? '').trim().slice(0, 4000);
          if (!text) throw err('Empty message');
          const row = ok(await sb.from('messages').insert({ channel_id: cid, user_id: au.id, text }).select('*').single());
          return msgView(row, await dir());
        }
      }
      if ((r = p.match(new RegExp(`^/api/chat/messages/(${UUID})$`)))) {
        const mid = r[1];
        if (method === 'PATCH') {
          const text = String(b.text ?? '').trim().slice(0, 4000);
          if (!text) throw err('Empty message');
          const rows = ok(await sb.from('messages').update({ text, edited_at: new Date().toISOString() }).eq('id', mid).select('*'));
          if (!rows.length) throw err('You can only edit your own messages', 403);
          return msgView(rows[0], await dir());
        }
        if (method === 'DELETE') {
          const m = ok(await sb.from('messages').select('file, user_id').eq('id', mid).maybeSingle());
          if (!m) throw err('No such message', 404);
          const rows = ok(await sb.from('messages').delete().eq('id', mid).select('id'));
          if (!rows.length) throw err('Not allowed', 403);
          if (m.file && m.file.path) await sb.storage.from('files').remove([m.file.path]);
          return { ok: true };
        }
      }
      throw err('Unknown endpoint', 404);
    }

    // ---------------------------------------------------------------- uploads (Storage)
    async function upload(url, file, meta) {
      meta = meta || {};
      if (file.size > MAX_UPLOAD) throw err('File is over 25 MB');
      if (!file.size) throw err('Empty file');
      const au = await sessionUser();
      const nick = ((await dir()).get(au.id) || {}).nickname || '';
      const name = safeName(file.name);
      const put = async path => {
        const up = await sb.storage.from('files').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
        if (up.error) throw err(up.error.message);
      };
      let r;
      if ((r = url.match(new RegExp(`^/api/users/(${UUID})/saves$`)))) {
        const path = `saves/${r[1]}/${rid()}-${name}`;
        await put(path);
        const ins = await sb.from('saves').insert({ user_id: r[1], game: String(meta.game || 'Other').slice(0, 60), name, size: file.size, path, by_name: nick });
        if (ins.error) { await sb.storage.from('files').remove([path]); throw err(friendly(ins.error)); }
        return { ok: true };
      }
      if ((r = url.match(new RegExp(`^/api/chat/channels/(${UUID})/upload$`)))) {
        const path = `chat/${r[1]}/${rid()}-${name}`;
        await put(path);
        const ins = await sb.from('messages').insert({ channel_id: r[1], user_id: au.id, text: String(meta.text || '').trim().slice(0, 4000), file: { path, name, size: file.size } }).select('*').single();
        if (ins.error) { await sb.storage.from('files').remove([path]); throw err(friendly(ins.error)); }
        return msgView(ins.data, await dir());
      }
      throw err('Unknown upload endpoint', 404);
    }

    return { api, upload, sb };
  }
  root.SCAApi = { create, GAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SCAApi;
})(typeof window !== 'undefined' ? window : globalThis);
