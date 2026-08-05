'use strict';
const fs = require('fs');
const vm = require('vm');
const nodeCrypto = require('crypto');

// ---- minimal DOM stubs so the app script loads ----
function fakeEl() {
  return new Proxy(function () {}, {
    get(t, p) {
      if (p === 'classList') return { toggle() {}, add() {}, remove() {}, contains: () => false };
      if (p === 'files') return [];
      if (p === 'dataset') return {};
      if (p === 'style') return {};
      if (p === Symbol.toPrimitive) return () => '';
      return fakeEl();
    },
    apply() { return fakeEl(); },
    set() { return true; }
  });
}
global.document = {
  getElementById: () => fakeEl(),
  querySelectorAll: () => [],
  createElement: () => fakeEl(),
  addEventListener() {}, removeEventListener() {}
};
global.window = global;
global.addEventListener = () => {};
Object.defineProperty(global, 'navigator', { value: {}, configurable: true });
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.indexedDB = { open: () => ({}) }; // init() hangs harmlessly

const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
const src = html.split('<script>')[1].split('</script>')[0];
vm.runInThisContext(src);

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
  if (!ok) failures++;
}

(async () => {
  // ---- 1. sha256Fallback vs Node crypto across padding boundaries ----
  for (const len of [0, 1, 3, 55, 56, 57, 63, 64, 65, 1000, 100000]) {
    const data = nodeCrypto.randomBytes(len);
    const ours = Buffer.from(sha256Fallback(new Uint8Array(data))).toString('hex');
    const ref = nodeCrypto.createHash('sha256').update(data).digest('hex');
    check(`sha256Fallback len=${len}`, ours === ref);
  }
  // subtle path agrees with fallback
  const d = nodeCrypto.randomBytes(500);
  check('sha256 (subtle) == fallback', hex(await sha256(new Uint8Array(d))) === Buffer.from(sha256Fallback(new Uint8Array(d))).toString('hex'));

  // ---- 2. zip write -> our reader roundtrip ----
  const filesIn = [
    { name: 'manifest.json', data: new TextEncoder().encode('{"a":1}') },
    { name: 'recording.webm', data: new Uint8Array(nodeCrypto.randomBytes(300000)) },
    { name: 'snapshots/snap_0001.jpg', data: new Uint8Array(nodeCrypto.randomBytes(5000)) }
  ];
  const zipBlob = buildZip(filesIn);
  const zipBuf = await zipBlob.arrayBuffer();
  const out = parseZip(zipBuf);
  check('zip roundtrip: file count', Object.keys(out).length === 3);
  for (const f of filesIn) {
    check(`zip roundtrip: ${f.name} bytes identical`,
      out[f.name] && Buffer.compare(Buffer.from(out[f.name]), Buffer.from(f.data)) === 0);
  }
  fs.writeFileSync(require('path').join(__dirname, 'test-out.zip'), Buffer.from(zipBuf));

  // ---- 3. stableStringify key-order independence ----
  check('stableStringify order-independent',
    stableStringify({ b: 1, a: { d: [1, 2], c: 'x' } }) === stableStringify({ a: { c: 'x', d: [1, 2] }, b: 1 }));

  // ---- 4. verdict engine ----
  const req = { minDurationSec: 60, steps: ['a', 'b'], rules: { requireAllSteps: true } };
  const okEvents = [{ type: 'step_ack' }, { type: 'step_ack' }, { type: 'session_complete' }];
  check('verdict: clean session valid', computeVerdict(okEvents, req, 61000).valid === true);
  check('verdict: too short invalid', computeVerdict(okEvents, req, 30000).valid === false);
  check('verdict: violation invalid',
    computeVerdict([...okEvents, { type: 'violation', detail: { code: 'camera_obscured' } }], req, 61000).valid === false);
  check('verdict: missing step invalid', computeVerdict([{ type: 'step_ack' }], req, 61000).valid === false);
  check('verdict: aborted invalid', computeVerdict([...okEvents, { type: 'session_aborted' }], req, 61000).valid === false);

  // ---- 5. chain reproduction (simulates verify path) ----
  const sessionId = 'test-session';
  const chunks = [nodeCrypto.randomBytes(1000), nodeCrypto.randomBytes(2000), nodeCrypto.randomBytes(500)].map(b => new Uint8Array(b));
  let chain = await sha256(utf8(sessionId));
  for (const c of chunks) chain = await sha256(concatU8([chain, c]));
  const media = concatU8(chunks);
  const sizes = chunks.map(c => c.length);
  let chain2 = await sha256(utf8(sessionId));
  let off = 0;
  for (const sz of sizes) { chain2 = await sha256(concatU8([chain2, media.subarray(off, off + sz)])); off += sz; }
  check('hash chain reproduces from concatenated media', hex(chain) === hex(chain2));
  // tamper: flip one byte
  media[1500] ^= 0xff;
  let chain3 = await sha256(utf8(sessionId));
  off = 0;
  for (const sz of sizes) { chain3 = await sha256(concatU8([chain3, media.subarray(off, off + sz)])); off += sz; }
  check('hash chain detects 1-byte tamper', hex(chain) !== hex(chain3));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
