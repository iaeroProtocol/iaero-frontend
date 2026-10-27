import type {YieldDB} from './d1-store.ts';
import type {Bootstrap} from '../src/live/types.ts';
import {acceptedReadCoverage} from '../src/protocol-data/read-coverage.ts';
// [DECISION] Retain the original one-minute verification lifetime. The shared
// cache prevents each visitor/isolate repeating the same configured-provider reads.
export function bootstrapLifetime(value:Bootstrap){return Object.keys(value.serviceErrors??{}).length?5000:60000;}
// Bump the format version when verification rules change. Provider credentials,
// registry and accepted deployment are also included in the opaque identity.
export async function bootstrapCacheKey(context:unknown){const bytes=new TextEncoder().encode(JSON.stringify(['bootstrap-v3-alchemy-20261027',context]));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
function valid(value:Bootstrap,now:number){
 const verified=Date.parse(value?.verifiedAt??'');
 return value?.registry?.chainId===8453&&acceptedReadCoverage(value.snapshot?.independentProviders,value.readCoverage)&&/^\d+$/.test(value.snapshot.block)&&/^0x[\da-f]{64}$/i.test(value.snapshot.hash)&&Number.isSafeInteger(value.snapshot.timestamp)&&value.snapshot.timestamp<=now/1000+60&&now/1000-value.snapshot.timestamp<=3600&&Number.isFinite(verified)&&verified<=now+5000&&now-verified<bootstrapLifetime(value)&&['legacyReady','oldAutoReady','liqStakingReady','sweepReady','marketRouteReady','newStackReady'].every(k=>typeof (value as any)[k]==='boolean');
}
export function createBootstrapCache(db:YieldDB,options:{now?:()=>number;sleep?:(ms:number)=>Promise<void>;maxWaitMs?:number}={}){
 const now=options.now??Date.now,wait=options.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));
 return {async run(key:string,produce:()=>Promise<Bootstrap>):Promise<Bootstrap>{
  const began=now(),owner=crypto.randomUUID();
  for(;;){
   const row=await db.prepare('SELECT data,expiresAt FROM app_bootstrap_cache WHERE key=?').bind(key).first<{data:string;expiresAt:number}>();
   if(row&&row.expiresAt>now()){try{const value=JSON.parse(row.data);if(valid(value,now()))return value;}catch{/* Reverify malformed cached data. */}}
   const acquired=await db.prepare('INSERT INTO app_bootstrap_leases VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expiresAt=excluded.expiresAt WHERE app_bootstrap_leases.expiresAt<=?').bind(key,owner,now()+90000,now()).run();
   if(acquired.meta.changes===1){
    try{
     const value=await produce();if(!valid(value,now()))throw Error('Fresh contract verification is unavailable.');
     const at=Date.parse(value.verifiedAt),written=await db.batch([
      db.prepare('INSERT INTO app_bootstrap_cache SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM app_bootstrap_leases WHERE key=? AND owner=? AND expiresAt>?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt,expiresAt=excluded.expiresAt').bind(key,JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v),at,at+bootstrapLifetime(value),key,owner,now()),
      db.prepare('DELETE FROM app_bootstrap_leases WHERE key=? AND owner=?').bind(key,owner),
      db.prepare('DELETE FROM app_bootstrap_cache WHERE expiresAt<?').bind(now()-3600000),
      db.prepare('DELETE FROM app_bootstrap_leases WHERE expiresAt<=?').bind(now())
     ]);
     if((written[0] as any).meta?.changes!==1)throw Error('Contract verification lease expired.');
     return value;
    }finally{await db.prepare('DELETE FROM app_bootstrap_leases WHERE key=? AND owner=?').bind(key,owner).run();}
   }
   if(now()-began>=(options.maxWaitMs??40000))throw Error('Contract verification is in progress. Retry shortly.');
   await wait(500);
  }
 }};
}
