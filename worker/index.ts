import {configuredBaseReads} from '../server/read-rpc-policy.ts';
import {createYieldService,yieldPosition} from '../server/yield-engine.ts';
import {yieldBootstrap} from '../server/yield-bootstrap.ts';
import policy from '../config/protocol-yield.json' with {type:'json'};
import {indexLegacy} from '../server/legacy-indexer.ts';
import {historyHealth} from './health.ts';
import {D1YieldStore,type YieldDB} from './d1-store.ts';
type Env={YIELD_DB:YieldDB;YIELD_RPC_SOURCES?:string;COLLECTOR_ENABLED?:string};
const json=(data:unknown,status=200,extra:Record<string,string>={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'public, max-age=30','access-control-allow-origin':'*','x-content-type-options':'nosniff',...extra}});
const rowCursor=(value:string|null)=>{if(value===null)return 0;if(!/^\d{1,15}$/.test(value))throw Error('invalid_cursor');return Number(value);};
export function parseRpcSources(raw:string){const data=JSON.parse(raw) as Record<string,string[]>;for(const chain of policy.chains){const urls=data[chain.chainId]??[];if(!Array.isArray(urls)||urls.length>2||!urls.every(u=>{try{return typeof u==='string'&&new URL(u).protocol==='https:';}catch{return false;}}))throw Error('yield_rpc_configuration');if(urls.length>1&&new URL(urls[0]).hostname===new URL(urls[1]).hostname)throw Error('yield_providers_not_independent');}try{configuredBaseReads(JSON.stringify(data[8453]??[]));}catch{throw Error('yield_base_providers_required');}return data;}
export async function collectScheduled(env:Env){
 if(env.COLLECTOR_ENABLED!=='true')return {status:'disabled'};
 const store=new D1YieldStore(env.YIELD_DB,yieldPosition,crypto.randomUUID());if(!await store.acquire())return {status:'already_running'};
 try{const sources=parseRpcSources(env.YIELD_RPC_SOURCES??'{}'),service=createYieldService(store,{automaticCatchup:false,sources:()=>policy.chains.map(source=>({source,urls:sources[source.chainId]??[]})),saveReport:report=>store.saveReport(report)});await service.syncProtocolYield(sources[8453],()=>yieldBootstrap(sources[8453]));try{const old=await env.YIELD_DB.prepare('SELECT data FROM legacy_indexes WHERE position=?').bind(yieldPosition).first<{data:string}>(),index=await indexLegacy(sources[8453],old?JSON.parse(old.data):undefined);await env.YIELD_DB.batch([env.YIELD_DB.prepare('INSERT INTO yield_commit_guard VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM yield_leases WHERE position=? AND owner=? AND expiresAt>?) THEN 1 ELSE 0 END)').bind(yieldPosition,yieldPosition,store.owner,Date.now()),env.YIELD_DB.prepare('INSERT INTO legacy_indexes VALUES(?,?,?) ON CONFLICT(position) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt WHERE excluded.updatedAt>=legacy_indexes.updatedAt').bind(yieldPosition,JSON.stringify(index),index.readAtMs),env.YIELD_DB.prepare('DELETE FROM yield_commit_guard WHERE position=?').bind(yieldPosition)]);}catch(error){console.error(error instanceof Error&&/^legacy_[a-z_]+$/.test(error.message)?error.message:'legacy_census_unavailable');/* Protocol income remains usable if legacy census needs another run. */}return {status:'recorded'};}finally{await store.release();}
}
export default {
 async fetch(request:Request,env:Env){
  const url=new URL(request.url);if(request.method!=='GET'&&request.method!=='HEAD')return json({error:'Read-only protocol API.'},405,{'allow':'GET, HEAD'});
  if(!['/api/protocol-yield','/api/protocol-yield/history','/api/protocol-yield/health','/api/legacy-history'].includes(url.pathname))return json({error:'Not found.'},404);
  try{
   if(url.pathname==='/api/legacy-history'){const row=await env.YIELD_DB.prepare('SELECT data FROM legacy_indexes WHERE position=?').bind(yieldPosition).first<{data:string}>();return row?json(JSON.parse(row.data)):json({status:'INDEXING',complete:false},503);}
   if(url.pathname.endsWith('/history')){
    const limitText=url.searchParams.get('limit')??'200';if(!/^\d{1,3}$/.test(limitText))return json({error:'Invalid history page.'},400);const limit=Number(limitText);if(limit<1||limit>250)return json({error:'Invalid history page.'},400);
    const after={claims:rowCursor(url.searchParams.get('claimsAfter')),snapshots:rowCursor(url.searchParams.get('snapshotsAfter')),valuations:rowCursor(url.searchParams.get('valuationsAfter')),assessments:rowCursor(url.searchParams.get('assessmentsAfter'))};
    const pageLimit=(key:string)=>key==='snapshots'?Math.min(limit,25):limit;
    const tables={claims:'yield_claims',snapshots:'yield_snapshots',valuations:'yield_valuations',assessments:'yield_assessments'} as const,keys=Object.keys(tables) as (keyof typeof tables)[];
    const supplied=keys.map(k=>url.searchParams.get(k+'Through'));if(supplied.some(v=>v!==null)&&supplied.some(v=>v===null))return json({error:'Incomplete export boundary.'},400);
    const frozen=await env.YIELD_DB.batch([...keys.map(k=>env.YIELD_DB.prepare('SELECT COALESCE(max(rowid),0) n FROM '+tables[k]+' WHERE position=?').bind(yieldPosition)),env.YIELD_DB.prepare('SELECT cursors FROM yield_meta WHERE position=?').bind(yieldPosition)]),through=Object.fromEntries(keys.map((k,i)=>[k,supplied[i]===null?Number(frozen[i].results[0].n):rowCursor(supplied[i])]));
    if(keys.some(k=>after[k]>through[k]))return json({error:'Invalid export boundary.'},400);
    const rows=await env.YIELD_DB.batch(keys.map(key=>env.YIELD_DB.prepare('SELECT rowid,data FROM '+tables[key]+' WHERE position=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?').bind(yieldPosition,after[key],through[key],pageLimit(key)+1))),body:any={version:1,position:yieldPosition,paginated:true,through,next:{},complete:true};
    rows.forEach((r,i)=>{const key=keys[i],page=r.results.slice(0,pageLimit(key));body[key]=page.map(v=>JSON.parse(v.data));body.next[key]=page.at(-1)?.rowid??after[key];if(r.results.length>pageLimit(key))body.complete=false;});
    body.cursors=frozen[keys.length].results[0]?JSON.parse(frozen[keys.length].results[0].cursors):{};return json(body);
   }
   const row=await env.YIELD_DB.prepare('SELECT data,updatedAt FROM yield_reports WHERE position=?').bind(yieldPosition).first<{data:string;updatedAt:number}>();
   if(url.pathname.endsWith('/health')){const legacy=await env.YIELD_DB.prepare('SELECT data FROM legacy_indexes WHERE position=?').bind(yieldPosition).first<{data:string}>(),health=historyHealth(row?JSON.parse(row.data):null,legacy?JSON.parse(legacy.data):null,env.COLLECTOR_ENABLED==='true');return json(health,health.healthy?200:503,{'cache-control':'no-store'});}
   // Public requests never cause an RPC scan or mutate stored history.
   if(!row)return json({error:'The shared recorder has no completed observation yet.',status:'UNAVAILABLE'},503,{'cache-control':'no-store'});
   return json({...JSON.parse(row.data),sharedHistory:true,syncing:false,syncUnavailable:Date.now()-row.updatedAt>900000});
  }catch{return json({error:'Shared protocol history is temporarily unavailable. Saved facts are retained.'},503,{'cache-control':'no-store'});}
 },
 scheduled(_event:unknown,env:Env,ctx:{waitUntil:(p:Promise<unknown>)=>void}){ctx.waitUntil(collectScheduled(env).catch(()=>{console.error('Scheduled protocol observation failed; retained history is unchanged.');}));}
};
