'use strict';
// Validates the vendored MoveNet graph model: loads it with pure-JS tfjs,
// runs inference on a 192x192 int32 input, and checks the output contract
// the app relies on: [1,1,17,3] with (y, x, score) rows, scores in [0,1].
// Requires @tensorflow/tfjs to be installed; skips cleanly if it is not.
const fs = require('fs');
const path = require('path');

let tf;
try { tf = require('@tensorflow/tfjs'); }
catch (e) {
  console.log('SKIP  pose model test (@tensorflow/tfjs not installed — `npm i @tensorflow/tfjs` to run)');
  process.exit(0);
}

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
  if (!ok) failures++;
}

(async () => {
  const dir = path.join(__dirname, '..', 'vendor', 'movenet');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'movenet-lightning.json'), 'utf8'));
  const binBuf = fs.readFileSync(path.join(dir, 'movenet-lightning.bin'));
  const weightData = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);

  const handler = {
    load: async () => ({
      modelTopology: manifest.modelTopology,
      format: manifest.format,
      generatedBy: manifest.generatedBy,
      convertedBy: manifest.convertedBy,
      weightSpecs: manifest.weightsManifest.flatMap(g => g.weights),
      weightData,
      signature: manifest.signature,
      userDefinedMetadata: manifest.userDefinedMetadata
    })
  };

  const model = await tf.loadGraphModel(handler);
  check('vendored MoveNet graph model loads', true, manifest.generatedBy);

  const input = tf.zeros([1, 192, 192, 3], 'int32');
  const out = model.execute(input);
  check('output shape is [1,1,17,3]', JSON.stringify(out.shape) === '[1,1,17,3]', JSON.stringify(out.shape));

  const arr = (await out.array())[0][0];
  const coordsOk = arr.every(kp => kp.length === 3 && kp.every(Number.isFinite));
  check('17 finite (y, x, score) keypoints', arr.length === 17 && coordsOk);
  const scoresOk = arr.every(kp => kp[2] >= 0 && kp[2] <= 1);
  check('scores within [0,1]', scoresOk);

  // a second run with a different input must produce different output (model is live, not constant)
  const out2 = model.execute(tf.randomUniform([1, 192, 192, 3], 0, 255).toInt());
  const arr2 = (await out2.array())[0][0];
  const differs = arr.some((kp, i) => Math.abs(kp[0] - arr2[i][0]) > 1e-6 || Math.abs(kp[2] - arr2[i][2]) > 1e-6);
  check('inference responds to input content', differs);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nPOSE MODEL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { check('model test completed', false, e.message); process.exit(1); });
