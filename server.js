#!/usr/bin/env node
/*
 * Recording Assistant — hosted server.
 * Zero dependencies: run with `node server.js` (Node 18+).
 *
 * Adds to the client app:
 *  - pairings: a partner creates one and gives the participant a pairing code
 *  - server-witnessed seal registration: the seal is timestamped by the server
 *    the moment a session completes, closing the client-only forgery window
 *  - automatic delivery: completed packets upload straight to the partner inbox
 *  - optional webhook notification per pairing (Slack/Discord/Zapier style)
 *
 * Env: PORT (default 8787), DATA_DIR (default ./data)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 8787;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PACKETS_DIR = path.join(DATA, 'packets');
const MAX_PACKET_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;

fs.mkdirSync(PACKETS_DIR, { recursive: true });

const SECRET_FILE = path.join(DATA, 'secret.key');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

const STATE_FILE = path.join(DATA, 'state.json');
let state = { pairings: {}, seals: {}, packets: {} };
if (fs.existsSync(STATE_FILE)) {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { console.error('Could not parse state.json, starting fresh:', e.message); }
}
function save() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

const token = n => crypto.randomBytes(n || 16).toString('hex');
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{4,63}$/;
const sanitizeFilename = n => String(n || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'packet.zip';

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const err = (res, status, message) => send(res, status, { error: message });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error('invalid JSON'); }
}

function parseParticipantCode(code) {
  const m = /^([a-f0-9]{12,32})\.([a-f0-9]{16,64})$/.exec(String(code || ''));
  if (!m) return null;
  const pair = state.pairings[m[1]];
  if (!pair || !safeEqual(pair.participantKey, m[2])) return null;
  return { pairId: m[1], pair };
}

function validRequirement(r) {
  return r && typeof r === 'object' && typeof r.title === 'string' && r.title.length <= 200 &&
    (r.media === 'video' || r.media === 'audio') &&
    typeof r.minDurationSec === 'number' &&
    Array.isArray(r.steps) && r.steps.length <= 50 && r.steps.every(s => typeof s === 'string' && s.length <= 500) &&
    r.rules && typeof r.rules === 'object';
}

async function notifyWebhook(pair, payload) {
  if (!pair.webhookUrl) return;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    await fetch(pair.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal
    });
    clearTimeout(t);
  } catch (e) {
    console.error(`[webhook] ${pair.webhookUrl} failed: ${e.message}`);
  }
}

function inboxFor(pairId) {
  const items = {};
  for (const [sid, s] of Object.entries(state.seals)) {
    if (s.pairId !== pairId) continue;
    items[sid] = {
      sessionId: sid,
      sealCode: s.sealCode,
      valid: s.valid,
      reasons: s.reasons || [],
      registeredAt: s.registeredAt,
      status: 'seal-registered'
    };
  }
  for (const [sid, p] of Object.entries(state.packets)) {
    if (p.pairId !== pairId) continue;
    items[sid] = Object.assign(items[sid] || { sessionId: sid, sealCode: p.sealCode }, {
      status: 'delivered',
      filename: p.filename,
      size: p.size,
      packetSha256: p.sha256,
      uploadedAt: p.uploadedAt,
      countersig: p.countersig
    });
  }
  return Object.values(items).sort((a, b) =>
    String(b.registeredAt || b.uploadedAt || '').localeCompare(String(a.registeredAt || a.uploadedAt || '')));
}

const INDEX_FILE = path.join(__dirname, 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    // static app
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      res.end(html);
      return;
    }
    // vendored pose model + TF.js (so pose verification works fully offline)
    if (req.method === 'GET' && parts[0] === 'vendor') {
      const base = path.join(__dirname, 'vendor');
      const file = path.normalize(path.join(base, ...parts.slice(1)));
      if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        err(res, 404, 'not found');
        return;
      }
      const types = { '.js': 'application/javascript', '.json': 'application/json', '.bin': 'application/octet-stream' };
      res.writeHead(200, {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Content-Length': fs.statSync(file).size,
        'Cache-Control': 'public, max-age=86400'
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (parts[0] !== 'api') { err(res, 404, 'not found'); return; }

    // CORS — auth is capability-key based, no cookies, so wildcard is safe
    // and lets the file:// (offline) copy of the app talk to a server too.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // GET /api/ping
    if (req.method === 'GET' && parts[1] === 'ping') {
      send(res, 200, { ok: true, service: 'recording-assistant', time: new Date().toISOString() });
      return;
    }

    // POST /api/pairings  {name, requirement, webhookUrl?}
    if (req.method === 'POST' && parts[1] === 'pairings' && parts.length === 2) {
      const body = await readJson(req);
      if (!validRequirement(body.requirement)) { err(res, 400, 'invalid requirement'); return; }
      const pairId = token(8);
      const pair = {
        name: String(body.name || 'Pairing').slice(0, 120),
        requirement: body.requirement,
        webhookUrl: typeof body.webhookUrl === 'string' && /^https?:\/\//.test(body.webhookUrl) ? body.webhookUrl.slice(0, 500) : null,
        partnerKey: token(16),
        participantKey: token(16),
        createdAt: new Date().toISOString()
      };
      state.pairings[pairId] = pair;
      save();
      send(res, 201, {
        pairId,
        name: pair.name,
        partnerKey: pair.partnerKey,
        participantCode: pairId + '.' + pair.participantKey
      });
      return;
    }

    // GET /api/pairings/:id?key=partnerKey  → pairing + inbox
    if (req.method === 'GET' && parts[1] === 'pairings' && parts.length === 3) {
      const pair = state.pairings[parts[2]];
      if (!pair || !safeEqual(pair.partnerKey, url.searchParams.get('key') || '')) { err(res, 403, 'forbidden'); return; }
      send(res, 200, {
        pairId: parts[2],
        name: pair.name,
        createdAt: pair.createdAt,
        webhookUrl: pair.webhookUrl,
        requirement: pair.requirement,
        inbox: inboxFor(parts[2])
      });
      return;
    }

    // GET /api/requirement?code=participantCode
    if (req.method === 'GET' && parts[1] === 'requirement') {
      const auth = parseParticipantCode(url.searchParams.get('code'));
      if (!auth) { err(res, 403, 'invalid pairing code'); return; }
      send(res, 200, { pairId: auth.pairId, name: auth.pair.name, requirement: auth.pair.requirement });
      return;
    }

    // POST /api/seals  {code, sessionId, sealCode, seal, valid, reasons}
    // Registers the seal the moment a session completes — the server timestamp
    // is the trusted witness that this exact seal existed at this time.
    if (req.method === 'POST' && parts[1] === 'seals' && parts.length === 2) {
      const body = await readJson(req);
      const auth = parseParticipantCode(body.code);
      if (!auth) { err(res, 403, 'invalid pairing code'); return; }
      const sid = String(body.sessionId || '');
      if (!SESSION_ID_RE.test(sid)) { err(res, 400, 'invalid sessionId'); return; }
      if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(String(body.sealCode || ''))) { err(res, 400, 'invalid sealCode'); return; }
      if (!/^[a-f0-9]{64}$/.test(String(body.seal || ''))) { err(res, 400, 'invalid seal'); return; }
      const existing = state.seals[sid];
      if (existing) {
        if (existing.seal === body.seal) { // idempotent retry
          send(res, 200, { registeredAt: existing.registeredAt, receipt: existing.receipt, already: true });
        } else {
          err(res, 409, 'a different seal is already registered for this session'); // seals are immutable
        }
        return;
      }
      const registeredAt = new Date().toISOString();
      const receipt = hmac(`seal|${sid}|${body.seal}|${registeredAt}`);
      state.seals[sid] = {
        pairId: auth.pairId,
        sealCode: body.sealCode,
        seal: body.seal,
        valid: !!body.valid,
        reasons: Array.isArray(body.reasons) ? body.reasons.slice(0, 20).map(r => String(r).slice(0, 300)) : [],
        registeredAt,
        receipt
      };
      save();
      send(res, 201, { registeredAt, receipt });
      return;
    }

    // PUT /api/packets/:sessionId?code=participantCode   (body: zip bytes)
    if (req.method === 'PUT' && parts[1] === 'packets' && parts.length === 3) {
      const auth = parseParticipantCode(url.searchParams.get('code'));
      if (!auth) { err(res, 403, 'invalid pairing code'); return; }
      const sid = parts[2];
      if (!SESSION_ID_RE.test(sid)) { err(res, 400, 'invalid sessionId'); return; }
      const seal = state.seals[sid];
      if (!seal || seal.pairId !== auth.pairId) { err(res, 409, 'register the session seal before uploading its packet'); return; }
      let buf;
      try { buf = await readBody(req, MAX_PACKET_BYTES); }
      catch (e) { err(res, 413, 'packet too large'); return; }
      if (!buf.length) { err(res, 400, 'empty body'); return; }
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const existing = state.packets[sid];
      if (existing) {
        if (existing.sha256 === sha256) { send(res, 200, Object.assign({ already: true }, existing)); }
        else { err(res, 409, 'a different packet is already delivered for this session'); }
        return;
      }
      fs.writeFileSync(path.join(PACKETS_DIR, sid + '.zip'), buf);
      const uploadedAt = new Date().toISOString();
      const entry = {
        pairId: auth.pairId,
        filename: sanitizeFilename(req.headers['x-filename']),
        size: buf.length,
        sha256,
        sealCode: seal.sealCode,
        uploadedAt,
        countersig: hmac(`packet|${sid}|${seal.seal}|${sha256}|${uploadedAt}`)
      };
      state.packets[sid] = entry;
      save();
      notifyWebhook(auth.pair, {
        event: 'packet_delivered',
        pairing: auth.pair.name,
        sessionId: sid,
        sealCode: seal.sealCode,
        valid: seal.valid,
        reasons: seal.reasons,
        size: buf.length,
        sha256,
        registeredAt: seal.registeredAt,
        uploadedAt
      });
      console.log(`[deliver] ${auth.pair.name} ← ${sid} (${(buf.length / 1048576).toFixed(1)} MB, ${seal.valid ? 'VALID' : 'INVALID'})`);
      send(res, 201, entry);
      return;
    }

    // GET /api/packets/:sessionId?pairId=&key=partnerKey  → zip download
    if (req.method === 'GET' && parts[1] === 'packets' && parts.length === 3) {
      const sid = parts[2];
      if (!SESSION_ID_RE.test(sid)) { err(res, 400, 'invalid sessionId'); return; }
      const pairId = url.searchParams.get('pairId') || '';
      const pair = state.pairings[pairId];
      if (!pair || !safeEqual(pair.partnerKey, url.searchParams.get('key') || '')) { err(res, 403, 'forbidden'); return; }
      const entry = state.packets[sid];
      if (!entry || entry.pairId !== pairId) { err(res, 404, 'packet not found'); return; }
      const file = path.join(PACKETS_DIR, sid + '.zip');
      if (!fs.existsSync(file)) { err(res, 410, 'packet file missing on server'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': entry.size,
        'Content-Disposition': `attachment; filename="${entry.filename}"`
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    err(res, 404, 'not found');
  } catch (e) {
    console.error(`[error] ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) err(res, 500, e.message);
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Recording Assistant server on http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA}`);
});
