import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const healthy = read('healthy.json'), recovered = read('recovered.json');
assert(healthy.peak > 0 && healthy.rebuilds === 0);
assert(recovered.peak > 0 && recovered.rebuilds === 1 && recovered.position > read('frozen.json').position);
const frozen = read('terminal-frozen-pair.json'), terminal = read('terminal-pair.json');
assert.equal(frozen.a.position, frozen.b.position);
assert.equal(frozen.a.bar, frozen.b.bar);
assert.equal(terminal.maxRebuilds, 2);
for (const sample of [terminal.a, terminal.b]) {
  assert.equal(sample.phase, 'dead'); assert.equal(sample.playing, false);
  assert.equal(sample.rebuilds, 2); assert.equal(sample.sources, 0);
  assert.equal(sample.peak, 0); assert.equal(sample.red, true);
  assert.equal(sample.status, 'audio dead — click ⟳');
}
assert.equal(terminal.a.position, terminal.b.position);
assert.equal(terminal.a.bar, terminal.b.bar);
const call = read('call-recovered.json');
assert(call.playing && call.rebuilds === 1 && call.peak > 0);
assert(call.position > read('call-frozen.json').position);
assert.deepEqual(read('browser-console.json').errors, []);
console.log('PASS: compiled manual recovery + frozen progress + bounded terminal + shared call recovery; browser errors=0');
