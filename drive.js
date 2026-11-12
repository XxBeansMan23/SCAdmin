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
    if (r.status !== 200 || !j.device_code) throw new Error(j.error_description || j.error || 'Google would not start the sign-in. Check the client ID/secret and that the OAuth client type is "TVs and Limited Input devices".');
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
  /** Stream `stream` (an incoming request) of known byte length `size` into Drive. Resolves with the Drive file id.
   *  Errors thrown before any bytes are consumed carry beforeBody=true, so the caller can fall back to local storage. */
  async function upload(stream, name, size) {
    const folder = await ensureFolder().catch(e => { throw Object.assign(e, { beforeBody: true }); });
    const meta = JSON.stringify({ name, parents: [folder] });
    let init;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await accessToken(attempt > 0);
      init = await request(API + '/upload/drive/v3/files?uploadType=resumable&fields=id', { method: 'POST', body: meta,
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(meta),
          'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(size) } });
      if (init.status !== 401) break;
    }
    if (init.status !== 200 || !init.headers.location) throw Object.assign(new Error('Google Drive refused the upload (' + init.status + ')'), { beforeBody: true });
    const putToken = await accessToken().catch(() => token);
    return new Promise((resolve, reject) => {
      const u = new URL(init.headers.location);
      const r = lib(u).request(u, { method: 'PUT', headers: { 'Content-Length': String(size), 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + putToken } }, res => {
        const ch = []; res.on('data', c => ch.push(c));
        res.on('end', () => {
          const j = parse(Buffer.concat(ch));
          if ((res.statusCode === 200 || res.statusCode === 201) && j.id) resolve(j.id);
          else reject(new Error('Google Drive upload failed (' + res.statusCode + ')'));
        });
      });
      r.on('error', reject);
      stream.on('error', e => r.destroy(e));
      stream.on('aborted', () => r.destroy(Object.assign(new Error('Upload cancelled'), { code: 400 })));
      stream.pipe(r);
    });
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
