'use strict';
// Integration test: full participant→partner flow against the real server.
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(__dirname, 'server-test-data');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
  if (!ok) failures++;
}

const REQ = {
  id: 'req-test', version: 1, title: 'Test requirement', description: '',
  media: 'audio', minDurationSec: 60,
  steps: ['step one', 'step two'],
  rules: { invalidateOnHide: true, maxHiddenSec: 15, invalidateOnDark: true, darkMaxSec: 10, invalidateOnSilence: false, maxSilenceSec: 60, requireAllSteps: true },
  createdAt: '2026-01-01T00:00:00.000Z'
};

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));

  // wait for ping
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/ping'); if (r.ok) { up = true; break; } } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  check('server starts and responds to ping', up);
  if (!up) { server.kill(); process.exit(1); }

  try {
    // static app served
    const idx = await fetch(BASE + '/');
    check('serves index.html', idx.ok && (await idx.text()).includes('Recording Assistant'));

    // vendored pose model files served, traversal blocked
    let r0 = await fetch(BASE + '/vendor/movenet/movenet-lightning.json');
    check('serves vendored pose model manifest', r0.ok && (await r0.json()).format === 'graph-model');
    r0 = await fetch(BASE + '/vendor/movenet/movenet-lightning.bin');
    check('serves pose model weights', r0.ok && parseInt(r0.headers.get('content-length'), 10) > 1000000);
    r0 = await fetch(BASE + '/vendor/..%2Fserver.js');
    check('vendor path traversal blocked', !r0.ok);

    // partner creates pairing
    let r = await fetch(BASE + '/api/pairings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test pairing', requirement: REQ }) });
    const pairing = await r.json();
    check('create pairing', r.status === 201 && pairing.pairId && pairing.partnerKey && pairing.participantCode);

    // reject bad requirement
    r = await fetch(BASE + '/api/pairings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', requirement: { title: 'no' } }) });
    check('rejects invalid requirement', r.status === 400);

    // participant fetches requirement
    r = await fetch(BASE + '/api/requirement?code=' + encodeURIComponent(pairing.participantCode));
    const reqData = await r.json();
    check('participant fetches requirement by code', r.ok && reqData.requirement.title === REQ.title);
    r = await fetch(BASE + '/api/requirement?code=' + pairing.pairId + '.deadbeefdeadbeefdeadbeefdeadbeef');
    check('rejects wrong participant key', r.status === 403);

    // packet upload before seal → rejected
    const sessionId = 'abc123-testsession';
    const zipBytes = crypto.randomBytes(50000);
    r = await fetch(`${BASE}/api/packets/${sessionId}?code=${encodeURIComponent(pairing.participantCode)}`, { method: 'PUT', headers: { 'Content-Type': 'application/zip' }, body: zipBytes });
    check('upload before seal registration is rejected', r.status === 409);

    // challenge code issuance
    r = await fetch(BASE + '/api/challenge?code=' + encodeURIComponent(pairing.participantCode));
    const chal = await r.json();
    check('challenge code issued', r.status === 201 && /^[A-F0-9]{8}$/.test(chal.challenge) && chal.issuedAt && /^[a-f0-9]{64}$/.test(chal.receipt));
    r = await fetch(BASE + '/api/challenge?code=' + pairing.pairId + '.deadbeefdeadbeefdeadbeefdeadbeef');
    check('challenge rejects wrong participant key', r.status === 403);

    // register seal (with attestation anchors + challenge)
    const seal = crypto.randomBytes(32).toString('hex');
    const sealCode = seal.slice(0, 12).toUpperCase().replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3');
    const mediaSha256 = crypto.randomBytes(32).toString('hex');
    const chainFinal = crypto.randomBytes(32).toString('hex');
    const sealBody = { code: pairing.participantCode, sessionId, sealCode, seal, valid: true, reasons: [], mediaSha256, chainFinal, challenge: chal.challenge };
    r = await fetch(BASE + '/api/seals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sealBody) });
    const sealResp = await r.json();
    check('seal registration', r.status === 201 && sealResp.registeredAt && /^[a-f0-9]{64}$/.test(sealResp.receipt));

    // idempotent retry OK, different seal rejected
    r = await fetch(BASE + '/api/seals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sealBody) });
    check('seal re-registration is idempotent', r.status === 200 && (await r.json()).already === true);
    r = await fetch(BASE + '/api/seals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sealBody, seal: crypto.randomBytes(32).toString('hex') }) });
    check('conflicting seal for same session is rejected (immutable)', r.status === 409);

    // challenge single-use: another session may not reuse it
    r = await fetch(BASE + '/api/seals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sealBody, sessionId: 'other0-session', seal: crypto.randomBytes(32).toString('hex'), challenge: chal.challenge }) });
    check('challenge reuse by another session is rejected', r.status === 409);
    r = await fetch(BASE + '/api/seals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sealBody, sessionId: 'other1-session', seal: crypto.randomBytes(32).toString('hex'), challenge: 'DEADBEEF' }) });
    check('unknown challenge code is rejected', r.status === 400);

    // upload packet
    r = await fetch(`${BASE}/api/packets/${sessionId}?code=${encodeURIComponent(pairing.participantCode)}`, { method: 'PUT', headers: { 'Content-Type': 'application/zip', 'X-Filename': 'packet_test_VALID.zip' }, body: zipBytes });
    const up1 = await r.json();
    const localSha = crypto.createHash('sha256').update(zipBytes).digest('hex');
    check('packet upload', r.status === 201 && up1.sha256 === localSha && up1.countersig);
    // idempotent same bytes, conflict on different bytes
    r = await fetch(`${BASE}/api/packets/${sessionId}?code=${encodeURIComponent(pairing.participantCode)}`, { method: 'PUT', headers: { 'Content-Type': 'application/zip' }, body: zipBytes });
    check('re-upload of identical packet is idempotent', r.status === 200);
    r = await fetch(`${BASE}/api/packets/${sessionId}?code=${encodeURIComponent(pairing.participantCode)}`, { method: 'PUT', headers: { 'Content-Type': 'application/zip' }, body: crypto.randomBytes(100) });
    check('different packet for same session is rejected (immutable)', r.status === 409);

    // partner inbox
    r = await fetch(`${BASE}/api/pairings/${pairing.pairId}?key=${pairing.partnerKey}`);
    const inbox = await r.json();
    const mainItem = inbox.inbox.find(i => i.sessionId === sessionId);
    check('partner inbox lists delivered packet', r.ok && mainItem && mainItem.status === 'delivered' && mainItem.sealCode === sealCode && mainItem.packetSha256 === localSha);
    check('inbox carries attestation anchors and challenge',
      mainItem && mainItem.mediaSha256 === mediaSha256 && mainItem.chainFinal === chainFinal && mainItem.challenge && mainItem.challenge.code === chal.challenge);
    r = await fetch(`${BASE}/api/pairings/${pairing.pairId}?key=wrongkey`);
    check('inbox rejects wrong partner key', r.status === 403);

    // partner downloads packet, bytes identical
    r = await fetch(`${BASE}/api/packets/${sessionId}?pairId=${pairing.pairId}&key=${pairing.partnerKey}`);
    const dl = Buffer.from(await r.arrayBuffer());
    check('partner downloads packet, bytes identical', r.ok && Buffer.compare(dl, zipBytes) === 0);
    r = await fetch(`${BASE}/api/packets/${sessionId}?pairId=${pairing.pairId}&key=wrongkey`);
    check('download rejects wrong partner key', r.status === 403);

    // state survives restart
    server.kill();
    await new Promise(r => setTimeout(r, 500));
    const server2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let up2 = false;
    for (let i = 0; i < 40; i++) {
      try { const rr = await fetch(BASE + '/api/ping'); if (rr.ok) { up2 = true; break; } } catch (e) {}
      await new Promise(r => setTimeout(r, 250));
    }
    check('server restarts', up2);
    r = await fetch(`${BASE}/api/pairings/${pairing.pairId}?key=${pairing.partnerKey}`);
    const inbox2 = await r.json();
    const mainItem2 = inbox2.inbox.find(i => i.sessionId === sessionId);
    check('pairings, seals and packets survive restart', r.ok && mainItem2 && mainItem2.status === 'delivered' && mainItem2.challenge.code === chal.challenge);
    server2.kill();
  } catch (e) {
    check('flow completed without exception', false, e.stack);
    server.kill();
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SERVER TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
