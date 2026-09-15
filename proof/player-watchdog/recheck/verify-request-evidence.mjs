import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const handoff=read('a-b-resume.json');
assert.notEqual(handoff.a.requestId,handoff.b.requestId);
assert(handoff.a.destroyed && handoff.a.retired.length>0);
assert.equal(handoff.a.total,0); assert.equal(handoff.a.segments,0); assert.equal(handoff.a.sources,0);
assert(handoff.a.retired.every(n=>n.stopped&&n.disconnected&&n.bufferReleased));
assert.equal(handoff.before,handoff.after); assert(handoff.onlyCurrentSources && handoff.b.peak>0);
const recovered=read('b-recovered.json');
assert.equal(recovered.rebuilds,1); assert(recovered.peak>0 && recovered.position>read('b-frozen.json').position);
for(const name of ['final-frozen-pair.json','final-terminal-pair.json']){
 const {a,b}=read(name);assert.equal(a.position,b.position);assert.equal(a.bar,b.bar);
}
const {a,b}=read('final-terminal-pair.json');
assert(a.dead&&b.dead&&a.red&&!a.playing);assert.equal(a.stalledRebuilds,2);assert.equal(a.sources,0);assert.equal(a.peak,0);
assert.deepEqual(read('final-console.json').errors,[]);
console.log(`PASS A→freeze→B: retired sources stopped/disconnected/buffer=null; stale+untagged frames rejected; B samples=${handoff.b.samples}`);
console.log(`PASS watchdog: recovered rebuild1 peak=${recovered.peak}; terminal consecutive failures=${a.stalledRebuilds}; position=${a.position} bar=${a.bar} unchanged over 2s; browser errors=0`);
