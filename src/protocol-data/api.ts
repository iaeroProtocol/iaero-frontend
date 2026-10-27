import {expectedYieldPosition} from './identity';
import {validateLedger} from './yield-model';
// Public data-service origin only. RPC credentials never belong in VITE_*.
export function protocolDataUrl(path:string,origin=import.meta.env.VITE_PROTOCOL_DATA_URL as string|undefined){
 if(!origin)return path;const u=new URL(origin);if(u.protocol!=='https:'&&!((u.hostname==='127.0.0.1'||u.hostname==='localhost')&&u.protocol==='http:'))throw Error('Shared history URL must use HTTPS.');
 if(u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Use the public shared history origin only.');return new URL(path,u).href;
}
export async function exportProtocolHistory(fetcher:typeof fetch=fetch){
 let path='/api/protocol-yield/history',combined:any,next:any,through:any;const seen={claims:new Set<string>(),snapshots:new Set<string>(),valuations:new Set<string>(),assessments:new Set<string>()};
 for(let page=0;page<10000;page++){
  const r=await fetcher(protocolDataUrl(path),{cache:'no-store'});if(!r.ok)throw Error('Saved history could not be downloaded. Please retry.');const data=await r.json();
  if(data.position!==expectedYieldPosition)throw Error('History position does not match the protocol NFT.');
  if(!data.paginated){validateLedger(data,expectedYieldPosition);return data;}
  if(!data.through||!['claims','snapshots','valuations','assessments'].every(k=>Number.isSafeInteger(data.through[k])&&data.through[k]>=0))throw Error('History export boundary is unavailable.');
  if(through&&JSON.stringify(through)!==JSON.stringify(data.through))throw Error('History export boundary changed.');through??=data.through;
  combined??={version:1,position:data.position,claims:[],snapshots:[],valuations:[],assessments:[],cursors:data.cursors};if(data.position!==combined.position)throw Error('History identity changed during export.');
  for(const key of ['claims','snapshots','valuations','assessments'] as const){if(key==='assessments'&&data[key]===undefined)continue;if(!Array.isArray(data[key]))throw Error('Incomplete history page.');for(const fact of data[key])if(!seen[key].has(fact.id)){seen[key].add(fact.id);combined[key].push(fact);}}
  if(data.complete){validateLedger(combined,expectedYieldPosition);return combined;}
  if(!data.next||JSON.stringify(data.next)===JSON.stringify(next))throw Error('History pagination did not advance.');next=data.next;
  path='/api/protocol-yield/history?'+new URLSearchParams({claimsAfter:String(next.claims),snapshotsAfter:String(next.snapshots),valuationsAfter:String(next.valuations),assessmentsAfter:String(next.assessments??0),claimsThrough:String(through.claims),snapshotsThrough:String(through.snapshots),valuationsThrough:String(through.valuations),assessmentsThrough:String(through.assessments)});
 }throw Error('History export is too large for the browser. Use the archival data export.');
}
