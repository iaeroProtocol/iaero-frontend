// Read-only frozen export. Source URLs are public APIs, never RPC endpoints.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {validateLedger} from '../src/protocol-data/yield-model.ts';
import {expectedYieldPosition} from '../src/protocol-data/identity.ts';
const origin=new URL(process.env.HISTORY_EXPORT_ORIGIN??'http://127.0.0.1:4319');
if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||origin.protocol!=='https:'&&origin.origin!=='http://127.0.0.1:4319')throw Error('A public history origin is required.');
const output=resolve('artifacts/portfolio-release/history');await mkdir(output,{recursive:true});
const keys=['claims','snapshots','valuations','assessments'],ledger={version:1,position:expectedYieldPosition,claims:[],snapshots:[],valuations:[],assessments:[],cursors:{}},seen=Object.fromEntries(keys.map(k=>[k,new Set()]));
let through,next,path='/api/protocol-yield/history',complete=false,pages=0;
for(;pages<10000;pages++){
 const reply=await fetch(new URL(path,origin),{signal:AbortSignal.timeout(30000),redirect:'error'});if(!reply.ok)throw Error('History source unavailable.');const data=await reply.json();
 if(data.position!==expectedYieldPosition||data.version!==1||!data.paginated||!data.through||!keys.every(k=>Number.isSafeInteger(data.through[k])&&data.through[k]>=0))throw Error('History export identity or boundary invalid.');
 if(through&&JSON.stringify(through)!==JSON.stringify(data.through))throw Error('Frozen export boundary changed.');if(!through)ledger.cursors=data.cursors;through??=data.through;
 for(const key of keys){if(!Array.isArray(data[key]))throw Error('Incomplete history page.');for(const fact of data[key]){if(seen[key].has(fact.id))throw Error('Duplicate history fact.');seen[key].add(fact.id);ledger[key].push(fact);}}
 if(data.complete){complete=true;pages++;break;}if(!data.next||JSON.stringify(next)===JSON.stringify(data.next))throw Error('History export did not advance.');next=data.next;
 path='/api/protocol-yield/history?'+new URLSearchParams(Object.fromEntries(keys.flatMap(k=>[[k+'After',String(next[k])],[k+'Through',String(through[k])]])));
}
if(!complete)throw Error('History export did not finish.');validateLedger(ledger,expectedYieldPosition);
// Every previously sealed fact must still be identical in the new export.
const parent=JSON.parse(await readFile('artifacts/branded-dashboard/PRODUCTION_HISTORY_SEED.json','utf8'));
for(const key of keys){const rows=new Map(ledger[key].map(row=>[row.id,JSON.stringify(row)]));for(const old of parent[key]??[])if(rows.get(old.id)!==JSON.stringify(old))throw Error('Previously sealed '+key+' fact missing or changed.');}
const bytes=JSON.stringify(ledger)+'\n';await writeFile(output+'/PRODUCTION_HISTORY_SEED.json',bytes,{flag:'wx'});
const report={version:1,exportedAt:new Date().toISOString(),position:expectedYieldPosition,pages,through,counts:Object.fromEntries(keys.map(k=>[k,ledger[k].length])),sha256:createHash('sha256').update(bytes).digest('hex'),parentFactsPreserved:true,readOnly:true};await writeFile(output+'/EXPORT.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
