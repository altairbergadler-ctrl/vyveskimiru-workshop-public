'use strict';
const assert = require('node:assert/strict');
const { analyzeRaster, atHeight, measure } = require('../dist/assets/stroke.js');

function raster(draw) {
  const width = 180, height = 130;
  const data = new Uint8ClampedArray(width * height * 4);
  function fill(x, y, w, h) {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) data[(py * width + px) * 4 + 3] = 255;
    }
  }
  draw(fill);
  return { width, height, data };
}

const straight = analyzeRaster(raster(fill => {
  fill(20, 10, 10, 100);
  fill(90, 10, 10, 100);
  fill(20, 55, 80, 10);
}));
assert.equal(straight.status, 'measured');
assert.equal(straight.reference, 'Н');
assert.equal(straight.ratio, 0.1);
assert.equal(straight.sampledRows, 8);
assert.equal(atHeight(straight, 16).estimatedStrokeCm, 1.6);
assert.equal(atHeight(straight, 16).meetsMinimum, true);
assert.equal(atHeight(straight, 15.99).meetsMinimum, false);
assert.equal(atHeight(straight, 10).suggestedHeightCm, 16);

const unequal = analyzeRaster(raster(fill => {
  fill(20, 10, 8, 100);
  fill(90, 10, 12, 100);
  fill(20, 55, 82, 10);
}));
assert.equal(unequal.ratio, 0.08, 'Choose the thinner main stem');
assert.equal(atHeight(unequal, 20).meetsMinimum, true);

const slanted = analyzeRaster(raster(fill => {
  for (let y = 10; y < 110; y++) {
    const shift = Math.round((110 - y) * 0.2);
    fill(20 + shift, y, 10, 1);
    fill(90 + shift, y, 10, 1);
    if (y >= 55 && y < 65) fill(20 + shift, y, 80, 1);
  }
}));
assert.equal(slanted.status, 'unknown');
assert.equal(slanted.reason, 'slanted-stems');
assert.equal(slanted.estimatedStrokeCm, null);

const decorative = analyzeRaster(raster(fill => {
  fill(20, 10, 10, 100);
  fill(55, 10, 10, 100);
  fill(90, 10, 10, 100);
}));
assert.equal(decorative.reason, 'unsupported-shape');
assert.equal(analyzeRaster(raster(() => {})).reason, 'empty-reference');

(async () => {
  assert.equal((await measure('Example', 700, -1)).reason, 'invalid-input');
  assert.equal((await measure('Example', 700, 20)).reason, 'unsupported-browser');
  console.log('stroke.test: all checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
