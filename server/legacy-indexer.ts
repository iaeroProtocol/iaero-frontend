import {readRpcFetch} from './read-rpc-fetch.ts';
import {createPublicClient,http,parseAbi,decodeEventLog,encodeEventTopics,toHex,keccak256,isAddress} from 'viem';
import config from '../config/legacy-history.json' with {type:'json'};
const events=parseAbi(['event RewardFunded(address indexed token,uint256 indexed epochId,uint256 amount)','event Harvested(uint256 indexed epoch,uint256 usdcGained,bool finalized)']);
type Cursor={block:string;hash:string;pairs:{token:string;epoch:string}[];epochs:string[];span:number};
type IndexClient={getChainId:()=>Promise<number>;getBlock:(request:any)=>Promise<{number:bigint;hash:string|null;timestamp:bigint}>;getCode:(request:any)=>Promise<`0x${string}`|undefined>;request:(request:any)=>Promise<any>};
export type LegacyIndex={version:1;chainId:8453;targets:Record<string,Cursor>;head:string;readAtMs:number;complete:boolean;providers:2;errors:string[]};
const canonical=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x),shape=(rows:any[])=>rows.map(l=>({address:l.address.toLowerCase(),block:l.blockNumber,hash:l.blockHash,transaction:l.transactionHash,index:l.logIndex,topics:l.topics,data:l.data})).sort((a,b)=>Number(BigInt(a.block)-BigInt(b.block))||Number(BigInt(a.index)-BigInt(b.index)));
export async function indexLegacy(urls:string[],previous?:LegacyIndex,maxRequests=120,options:{clients?:IndexClient[]}={}):Promise<LegacyIndex>{
 if(urls.length!==2||new URL(urls[0]).hostname===new URL(urls[1]).hostname)throw Error('legacy_independent_providers_required');
 const clients:IndexClient[]=options.clients??urls.map(u=>createPublicClient({transport:http(u,{timeout:20000,retryCount:0,fetchFn:readRpcFetch}),ccipRead:false}));
 if((await Promise.all(clients.map(c=>c.getChainId()))).some(id=>id!==8453))throw Error('legacy_wrong_chain');
 const heads=await Promise.all(clients.map(c=>c.getBlock({blockTag:'finalized'}))),head=heads.reduce((n,h)=>h.number<n?h.number:n,heads[0].number);
 const header=async(at:bigint)=>{const h=await Promise.all(clients.map(c=>c.getBlock({blockNumber:at})));if(h.some(v=>v.hash!==h[0].hash||v.timestamp!==h[0].timestamp))throw Error('legacy_header_disagreement');return h[0];};
 const final=await header(head);if(Date.now()/1000-Number(final.timestamp)>3600)throw Error('legacy_stale_finality');
 if(previous&&(previous.version!==1||previous.chainId!==8453||!previous.targets))throw Error('legacy_index_invalid');
 const state:LegacyIndex=previous?structuredClone(previous):{version:1,chainId:8453,targets:{},head:head.toString(),readAtMs:Date.now(),complete:false,providers:2,errors:[]};state.errors=[];state.head=head.toString();state.readAtMs=Date.now();let used=0;
 for(const target of config.targets){
  const at=BigInt(target.firstBlock);let cursor=state.targets[target.key];
  if(cursor){if(BigInt(cursor.block)>head||(await header(BigInt(cursor.block))).hash!==cursor.hash)throw Error('legacy_checkpoint_changed');}
  else{const h=await header(at),codes=await Promise.all(clients.map(c=>c.getCode({address:target.address as `0x${string}`,blockNumber:at})));if(h.hash!==target.firstBlockHash||codes.some(code=>!code||keccak256(code)!==target.codeHash))throw Error('legacy_creation_anchor_changed');const before=await header(at-1n);cursor={block:(at-1n).toString(),hash:before.hash!,pairs:[],epochs:[],span:1000000};state.targets[target.key]=cursor;}
  const event=events[target.key==='staking'?0:1],topic=encodeEventTopics({abi:[event],eventName:event.name} as any)[0],seen=new Set(cursor.pairs.map(p=>p.token.toLowerCase()+':'+p.epoch)),epochs=new Set(cursor.epochs);
  const startedAt=cursor.block;
  let stop=false;
  while(BigInt(cursor.block)<head&&used+4<=maxRequests&&!stop){
   const first=BigInt(cursor.block)+1n,width=cursor.span>10000?1:Math.min(6,Math.floor((maxRequests-used-2)/2)),ranges=Array.from({length:width},(_,i)=>{const from=first+BigInt(i*cursor.span),to=from+BigInt(cursor.span)-1n<head?from+BigInt(cursor.span)-1n:head;return {from,to};}).filter(r=>r.from<=head);
   used+=ranges.length*2;
   const batch=await Promise.all(ranges.map(({from,to})=>Promise.allSettled(clients.map(c=>c.request({method:'eth_getLogs',params:[{address:target.address,fromBlock:toHex(from),toBlock:toHex(to),topics:[topic]}]} as any)))));
   for(let i=0;i<ranges.length;i++){
    const {from,to}=ranges[i],results=batch[i],failed=results.filter(r=>r.status==='rejected');
    if(failed.length){const range=failed.every(r=>/range|too many results|query.*more|limit.*block|maximum.*block/i.test(String((r as PromiseRejectedResult).reason?.details??(r as PromiseRejectedResult).reason?.shortMessage??'')));if(range&&cursor.span>1)cursor.span=Math.max(1,Math.floor(cursor.span/2));else{state.errors.push(target.key+': funding scan temporarily unavailable.');stop=true;}break;}
    const rows=(results[0] as PromiseFulfilledResult<any[]>).value,other=(results[1] as PromiseFulfilledResult<any[]>).value;if(!Array.isArray(rows)||!Array.isArray(other)||canonical(shape(rows))!==canonical(shape(other)))throw Error('legacy_log_disagreement');
    for(const log of rows){if(log.removed||log.address.toLowerCase()!==target.address.toLowerCase()||BigInt(log.blockNumber)<from||BigInt(log.blockNumber)>to)throw Error('legacy_log_invalid');const decoded=decodeEventLog({abi:events,data:log.data,topics:log.topics}) as any,epoch=BigInt(decoded.args.epochId??decoded.args.epoch);if(epoch<0n||epoch%604800n!==0n)throw Error('legacy_epoch_invalid');if(target.key==='staking'){const token=decoded.args.token;if(!isAddress(token))throw Error('legacy_token_invalid');const key=token.toLowerCase()+':'+epoch;if(!seen.has(key)){seen.add(key);cursor.pairs.push({token,epoch:epoch.toString()});}}else epochs.add(epoch.toString());}
    // Commit only the consecutive successful prefix. Later answers in a batch
    // cannot skip a failed range. The final prefix hash is verified below.
    cursor.block=to.toString();cursor.epochs=[...epochs].sort();
   }
  }
  if(cursor.block!==startedAt){used+=2;cursor.hash=(await header(BigInt(cursor.block))).hash!;}

 }
 state.complete=config.targets.every(t=>state.targets[t.key]?.block===state.head)&&state.errors.length===0;return state;
}
