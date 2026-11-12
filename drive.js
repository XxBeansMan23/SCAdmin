'use strict';
/* Google Drive storage for SCAdmin. Zero dependencies.
 * - Sign-in uses Google's OAuth *device flow* (no redirect URL needed, works on a headless server).
 * - Scope is drive.file: SCAdmin can only see files it created itself, never the rest of your Drive.
 * - Uploads are streamed through the server to Drive (resumable upload API), downloads support HTTP Range so video seeking works.
 * Credentials live in <dataDir>/drive.json (mode 0600, git-ignored). */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function create(dataDir, env = process.env) {
  const API = (env.DRIVE_API_BASE || 'https://www.googleapis.com').replace(/\/$/, '');
  const OAUTH = (env.DRIVE_OAUTH_BASE || 'https://oauth2.googleapis.com').replace(/\/$/, '');
  const FILE = path.join(dataDir, 'drive.json');
  const FOLDER_NAME = 'SCAdmin Files';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* not configured yet */ }
  const save = () => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(cfg), { mode: 0o600 }); fs.renameSync(FILE + '.tmp', FILE); };
  let token = null, tokenExp = 0, pending = null, lastError = '';

  const lib = u => (u.protocol === 'https:' ? https : http);
  function request(urlStr, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const r = lib(u).request(u, { method, headers }, res => {
        const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch) }));
      });
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
  }
  const parse = b => { try { return JSON.parse(b.toString() || '{}'); } catch { return {}; } };
  const form = o => new URLSearchParams(o).toString();

  async function accessToken(force) {
    if (!force && token && Date.now() < tokenExp - 60000) return token;
    if (!cfg.refreshToken) throw Object.assign(new Error('Google Drive is not connected'), { beforeBody: true });
    const r = await request(OAUTH + '/token', { method: 'POST', headers: FORM,
      body: form({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token' }) });
    const j = parse(r.body);
    if (r.status !== 200 || !j.access_token) {
      lastError = j.error_description || j.error || 'token refresh failed';
      throw Object.assign(new Error('Google sign-in failed: ' + lastError), { beforeBody: true });
    }
    token = j.access_token; tokenExp = Date.now() + (j.expires_in || 3600) * 1000; lastError = '';
    return token;
  }

  async function gjson(method, pathAndQuery, bodyObj) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await accessToken(attempt > 0);
      const payload = bodyObj ? JSON.stringify(bodyObj) : undefined;
      const r = await request(API + pathAndQuery, { method, body: payload,
        headers: { Authorization: 'Bearer ' + t, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } });
      if (r.status === 401 && attempt === 0) continue;
      const j = parse(r.body);
      if (r.status >= 400) throw Object.assign(new Error((j.error && (j.error.message || j.error)) || 'Drive error ' + r.status), { status: r.status });
      return j;
    }
  }

  async function ensureFolder() {
    if (cfg.folderId) return cfg.folderId;
    const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`);
    const l = await gjson('GET', `/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`);
    let id = l.files && l.files[0] && l.files[0].id;
    if (!id) id = (await gjson('POST', '/drive/v3/files?fields=id', { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })).id;
    cfg.folderId = id; save();
    return id;
  }

  // ---------------------------------------------------------------- setup / connect
  function setCredentials(clientId, clientSecret) {
    if (!clientId || !clientSecret) throw new Error('Client ID and client secret are both required');
    cfg = { clientId, clientSecret, enabled: true };          // new credentials = start over
    token = null; pending = null; lastError = '';
    save();
  }
  function disconnect() { delete cfg.refreshToken; delete cfg.folderId; token = null; pending = null; save(); }
  function setEnabled(v) { cfg.enabled = !!v; save(); }

  async function startConnect() {
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('Save the client ID and secret first');
    const r = await request(OAUTH + '/device/code', { method: 'POST', headers: FORM, body: form({ client_id: cfg.clientId, scope: SCOPE }) });
    const j = parse(r.body);
    if (r.status !== 200 || !j.device_code) {
      if (j.error === 'invalid_client') throw new Error('Google rejected the client ID/secret. Re-copy them from Google Cloud Console (Credentials), with no spaces.');
      if (j.error === 'unauthorized_client' || j.error === 'invalid_request') throw new Error('Google says this OAuth client cannot use the device sign-in. Create a NEW OAuth client of type "TVs and Limited Input devices" (not Web or Desktop) and save its ID/secret here.');
      if (j.error === 'access_denied') throw new Error('Google denied access. In OAuth consent screen, set Publishing status to "In production" (or add your account as a test user).');
      throw new Error(j.error_description || j.error || 'Google would not start the sign-in (HTTP ' + r.status + ').');
    }
    const p = { userCode: j.user_code, verificationUrl: j.verification_url || j.verification_uri || 'https://www.google.com/device', expiresAt: Date.now() + (j.expires_in || 1800) * 1000, state: 'waiting', error: '' };
    pending = p;
    let interval = j.interval || 5;
    const poll = async () => {
      if (pending !== p || p.state !== 'waiting') return;
      if (Date.now() > p.expiresAt) { p.state = 'expired'; return; }
      try {
        const t = await request(OAUTH + '/token', { method: 'POST', headers: FORM,
          body: form({ client_id: cfg.clientId, client_secret: cfg.clientSecret, device_code: j.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
        const tj = parse(t.body);
        if (t.status === 200 && tj.refresh_token) {
          cfg.refreshToken = tj.refresh_token; token = tj.access_token; tokenExp = Date.now() + (tj.expires_in || 3600) * 1000; delete cfg.folderId; save();
          try { await ensureFolder(); p.state = 'connected'; } catch (e) { p.state = 'error'; p.error = 'Signed in, but could not create the Drive folder: ' + e.message; }
          return;
        }
        if (tj.error === 'slow_down') interval += 5;
        else if (tj.error === 'access_denied') { p.state = 'error'; p.error = 'You clicked Cancel, or Google blocked this account. If the consent screen is in "Testing", add your account as a test user or set Publishing status to "In production", then Connect again.'; return; }
        else if (tj.error === 'expired_token') { p.state = 'expired'; return; }
        else if (tj.error && tj.error !== 'authorization_pending') { p.state = 'error'; p.error = tj.error_description || tj.error; return; }
      } catch (e) { p.error = e.message; }
      setTimeout(poll, interval * 1000).unref();
    };
    setTimeout(poll, interval * 1000).unref();
    return { userCode: p.userCode, verificationUrl: p.verificationUrl, expiresInSec: Math.round((p.expiresAt - Date.now()) / 1000) };
  }

  async function status() {
    const s = { configured: !!(cfg.clientId && cfg.clientSecret), clientIdHint: cfg.clientId ? cfg.clientId.slice(0, 14) + '…' : '', connected: !!cfg.refreshToken,
      enabled: cfg.enabled !== false, folder: cfg.folderId ? FOLDER_NAME : '', connect: pending ? { state: pending.state, userCode: pending.userCode, verificationUrl: pending.verificationUrl, error: pending.error } : null, error: lastError };
    if (s.connected) {
      try {
        const a = await gjson('GET', '/drive/v3/about?fields=storageQuota,user');
        s.quota = a.storageQuota || null; s.account = (a.user && a.user.emailAddress) || '';
      } catch (e) { s.error = e.message; }
    }
    return s;
  }
  const active = () => !!cfg.refreshToken && cfg.enabled !== false;

  // ---------------------------------------------------------------- files
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const CHUNK = 8 * 1024 * 1024;   // Drive wants chunk sizes that are multiples of 256 KiB; 8 MiB = 32 x 256 KiB
  /** Stream `stream` (any Readable: an incoming request or a file) into Drive using a resumable, chunked upload.
   *  The total size does NOT need to be known up front (so it works however the proxy in front of us frames the request),
   *  memory use is about one chunk, and each chunk is retried on network/5xx errors.
   *  `size` is optional (0 = unknown). Resolves with { id, size }.
   *  Errors thrown before any bytes are consumed carry beforeBody=true, so the caller can fall back to local storage. */
  async function upload(stream, name, size = 0) {
    const folder = await ensureFolder().catch(e => { throw Object.assign(e, { beforeBody: true }); });
    const meta = JSON.stringify({ name, parents: [folder] });
    let init;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await accessToken(attempt > 0);
      init = await request(API + '/upload/drive/v3/files?uploadType=resumable&fields=id', { method: 'POST', body: meta,
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(meta),
          'X-Upload-Content-Type': 'application/octet-stream', ...(size > 0 ? { 'X-Upload-Content-Length': String(size) } : {}) } });
      if (init.status !== 401) break;
    }
    if (init.status !== 200 || !init.headers.location) {
      const j = parse(init.body);
      throw Object.assign(new Error('Google Drive refused the upload (' + init.status + (j.error && j.error.message ? ': ' + j.error.message : '') + ')'), { beforeBody: true });
    }
    const sessionUrl = init.headers.location;
    let offset = 0, bufs = [], bufLen = 0;
    const take = n => {   // remove and return exactly n buffered bytes
      const out = Buffer.allocUnsafe(n); let w = 0;
      while (w < n) {
        const b = bufs[0], need = n - w;
        if (b.length <= need) { b.copy(out, w); w += b.length; bufs.shift(); }
        else { b.copy(out, w, 0, need); bufs[0] = b.subarray(need); w += need; }
      }
      bufLen -= n; return out;
    };
    const putChunk = async (data, final) => {
      const total = final ? String(offset + data.length) : (size > 0 ? String(size) : '*');
      const range = data.length ? `bytes ${offset}-${offset + data.length - 1}/${total}` : `bytes */${total}`;
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const t = await accessToken();
          const r = await request(sessionUrl, { method: 'PUT', body: data,
            headers: { 'Content-Length': data.length, 'Content-Range': range, 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + t } });
          if (final && (r.status === 200 || r.status === 201)) { const j = parse(r.body); if (j.id) return j.id; throw Object.assign(new Error('Google Drive did not return a file id'), { fatal: true }); }
          if (!final && r.status === 308) return null;
          if (r.status === 401) { token = null; throw new Error('token expired'); }
          if (r.status >= 500 || r.status === 429 || r.status === 408) throw new Error('Google Drive error ' + r.status);
          const j = parse(r.body);
          throw Object.assign(new Error('Google Drive upload failed (' + r.status + (j.error && j.error.message ? ': ' + j.error.message : '') + ')'), { fatal: true });
        } catch (e) { lastErr = e; if (e.fatal) break; await sleep(400 * 2 ** attempt); }
      }
      throw lastErr;
    };
    try {
      for await (const piece of stream) {
        bufs.push(piece); bufLen += piece.length;
        while (bufLen > CHUNK) { const data = take(CHUNK); await putChunk(data, false); offset += data.length; }   // awaiting here also applies backpressure to the sender
      }
    } catch (e) {
      if (!e.code && /aborted|ECONNRESET|premature/i.test(e.message || '')) throw Object.assign(new Error('Upload cancelled'), { code: 400 });
      throw e;
    }
    if (offset + bufLen === 0) throw Object.assign(new Error('Empty file'), { code: 400 });
    const last = take(bufLen);
    const id = await putChunk(last, true);
    return { id, size: offset + last.length };
  }

  /** Open a download stream (optionally a Range) from Drive. Resolves with the upstream IncomingMessage. */
  async function open(id, range) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await accessToken(attempt > 0);
      const u = new URL(API + '/drive/v3/files/' + encodeURIComponent(id) + '?alt=media');
      const res = await new Promise((resolve, reject) => {
        const r = lib(u).request(u, { method: 'GET', headers: { Authorization: 'Bearer ' + t, ...(range ? { Range: range } : {}) } }, resolve);
        r.on('error', reject); r.end();
      });
      if (res.statusCode === 401 && attempt === 0) { res.resume(); continue; }
      return res;
    }
  }

  async function remove(id) { try { await gjson('DELETE', '/drive/v3/files/' + encodeURIComponent(id)); } catch (e) { if (e.status !== 404) throw e; } }

  return { active, status, setCredentials, startConnect, disconnect, setEnabled, upload, open, remove };
}
module.exports = { create };
