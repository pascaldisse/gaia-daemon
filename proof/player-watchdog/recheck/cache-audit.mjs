import {readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {speakableText} from '../../../src/services/read-aloud.ts';
const base = process.argv[2];
if (!base) throw Error('private candidate data path required');
const events=readFileSync(`${base}/workspace/.gaia/rooms/player-proof/transcript.jsonl`,'utf8').trim().split('\n').map(JSON.parse);
const dir=`${base}/home/cache/tts`;
const entries=readdirSync(dir).filter(n=>n.endsWith('.json')).map(name=>{
 const meta=JSON.parse(readFileSync(`${dir}/${name}`,'utf8'));
 const matched=events.filter(e=>createHash('sha256').update(speakableText(e.text??'')).digest('hex')===meta.identity.textHash);
 return {file:name,identity:meta.identity,audioMtime:statSync(`${dir}/${name.replace('.json','.audio')}`).mtime.toISOString(),events:matched.map(e=>({id:e.id,author:e.author,excerpt:e.text.slice(0,150)}))};
});
console.log(JSON.stringify({clientReplayStore:'none in readaloud.js; per-request transport segments only',serverKey:'tts-v2 + engine + voice + model + SHA256(speakable text); full identity metadata checked',backendAccountIdentity:'not in key; same named voice/text/model can reuse old render across backend account changes',entries},null,2));
