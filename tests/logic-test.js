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

  // ---- 4b. position-hold verdicts ----
  const holdReq = { sessionType: 'hold', minDurationSec: 60, steps: ['a'], rules: { requireAllSteps: true } };
  const holdBase = [{ type: 'step_ack' }, { type: 'position_locked', t: 5000 }, { type: 'session_complete' }];
  check('hold verdict: full hold valid', computeVerdict(holdBase, holdReq, 66000).valid === true);
  check('hold verdict: never locked invalid', computeVerdict([{ type: 'step_ack' }], holdReq, 120000).valid === false);
  check('hold verdict: hold counted from lock, not start',
    computeVerdict(holdBase, holdReq, 64000).valid === false); // 64s total but only 59s after lock
  check('hold verdict: excessive movement invalid',
    computeVerdict([...holdBase, { type: 'violation', detail: { code: 'excessive_movement' } }], holdReq, 66000).valid === false);
  check('hold verdict: left position invalid',
    computeVerdict([...holdBase, { type: 'violation', detail: { code: 'left_position' } }], holdReq, 66000).valid === false);

  // ---- 4b1. no-narration verdict ----
  const narrReq = { minDurationSec: 60, steps: [], rules: { requireAllSteps: false, requireAudibleAudio: true } };
  const nv = computeVerdict([{ type: 'violation', detail: { code: 'no_narration', audibleMs: 0 } }, { type: 'session_complete' }], narrReq, 61000);
  check('no-narration verdict: silent session invalid, reason mentions narration',
    nv.valid === false && nv.reasons.some(r => /narration|audible/i.test(r)));

  // ---- 4b2. pose verdicts ----
  const poseReq = { sessionType: 'hold', minDurationSec: 60, steps: [], rules: { requireAllSteps: false, poseChecks: ['standing', 'facing_away'] } };
  const poseBase = [{ type: 'position_locked', t: 1000 }, { type: 'session_complete' }];
  check('pose verdict: clean hold valid', computeVerdict(poseBase, poseReq, 62000).valid === true);
  const pv = computeVerdict([...poseBase, { type: 'violation', detail: { code: 'pose_violation', rule: 'facing_away' } }], poseReq, 62000);
  check('pose verdict: pose violation invalid, reason names the pose',
    pv.valid === false && pv.reasons.some(r => r.includes('Facing away from camera')));
  const pv2 = computeVerdict([...poseBase,
    { type: 'violation', detail: { code: 'pose_violation', rule: 'standing' } },
    { type: 'violation', detail: { code: 'pose_violation', rule: 'facing_away' } }], poseReq, 62000);
  check('pose verdict: distinct rules produce distinct reasons', pv2.reasons.length === 2);
  check('pose verdict: engine unavailable invalid',
    computeVerdict([...poseBase, { type: 'violation', detail: { code: 'pose_unavailable' } }], poseReq, 62000).valid === false);

  // ---- 4c2. pose geometry (evalPoseRules, COCO-17, y grows downward) ----
  // synthetic standing person, torso ~100px: head 50, shoulders 100, hips 200, knees 300, ankles 400
  const KP = (over) => {
    const base = [
      [100, 55], [95, 52], [105, 52], [88, 55], [112, 55],  // nose, eyes, ears
      [80, 100], [120, 100], [70, 150], [130, 150],          // shoulders, elbows
      [65, 200], [135, 200],                                  // wrists
      [90, 200], [110, 200], [92, 300], [108, 300], [93, 400], [107, 400] // hips, knees, ankles
    ].map(([x, y]) => ({ x, y, score: 0.9 }));
    return Object.assign(base, over || {});
  };
  const rStand = evalPoseRules(KP(), 0.3);
  check('pose geometry: standing detected', rStand.detected && rStand.standing === true);
  check('pose geometry: standing person is not kneeling', rStand.kneeling === false);
  check('pose geometry: hands at hips are not on head', rStand.hands_on_head === false);
  check('pose geometry: visible face is not facing away', rStand.facing_away === false);

  const rHands = evalPoseRules(KP({ 9: { x: 85, y: 40, score: 0.9 }, 10: { x: 115, y: 40, score: 0.9 } }), 0.3);
  check('pose geometry: wrists above head = hands on head', rHands.hands_on_head === true);

  const rAway = evalPoseRules(KP({
    0: { x: 100, y: 55, score: 0.1 }, 1: { x: 95, y: 52, score: 0.1 }, 2: { x: 105, y: 52, score: 0.1 }
  }), 0.3);
  check('pose geometry: hidden face + visible shoulders = facing away', rAway.facing_away === true);

  // kneeling: hips 250, knees 350, ankles at knee height (shin flat on ground)
  const rKneel = evalPoseRules(KP({
    11: { x: 90, y: 250, score: 0.9 }, 12: { x: 110, y: 250, score: 0.9 },
    13: { x: 92, y: 350, score: 0.9 }, 14: { x: 108, y: 350, score: 0.9 },
    15: { x: 70, y: 360, score: 0.9 }, 16: { x: 130, y: 360, score: 0.9 }
  }), 0.3);
  check('pose geometry: kneeling detected', rKneel.kneeling === true);
  check('pose geometry: kneeling person is not standing', rKneel.standing === false);

  const rNone = evalPoseRules([], 0.3);
  check('pose geometry: empty keypoints = nothing detected', rNone.detected === false && !rNone.standing && !rNone.facing_away);

  // ---- 4c. motion math: mean-centered frame diff ----
  const mk = (arr) => { const data = Float32Array.from(arr); const mean = arr.reduce((a, b) => a + b, 0) / arr.length; return { data, mean }; };
  const fA = mk([10, 20, 30, 40]);
  check('frameDiff: identical frames = 0', frameDiff(fA, mk([10, 20, 30, 40])) === 0);
  check('frameDiff: global brightness shift ignored (exposure drift)', frameDiff(fA, mk([30, 40, 50, 60])) === 0);
  check('frameDiff: structural change detected', frameDiff(fA, mk([40, 30, 20, 10])) > 10);

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
