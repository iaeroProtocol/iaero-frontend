import {readRpcFetch} from './read-rpc-fetch.ts';
import {createPublicClient,decodeEventLog,encodeEventTopics,http,isAddress,parseAbi,toHex,type Address} from 'viem';
import policy from '../config/protocol-yield.json' with {type:'json'};
import registry from '../config/base.registry.json' with {type:'json'};
import {addClaim,addSnapshot,addValuation,claimValue,effectiveClaim,yieldChainTotals,receivedYieldDays,summariseYield,invalidateAnnualised,WEEK,type YieldAsset,type YieldClaim,type YieldLedger} from '../src/protocol-data/yield-model.ts';
import {historicalClaimPrice} from './yield-prices.ts';
import {reservePrice} from './protocol-metrics.ts';
import {createCurrentYieldPricer} from './yield-current-prices.ts';
import {freshYieldPrice} from '../src/protocol-data/yield-price.ts';
const zero='0x0000000000000000000000000000000000000000';
const canonical=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
const same=(a:unknown,b:unknown)=>String(a).toLowerCase()===String(b).toLowerCase();
const POSITION=registry.chainId+':'+registry.aero.votingEscrow.toLowerCase()+':'+policy.positionId;
export const yieldPosition=POSITION;
const pricerConfig={usdc:registry.legacy.USDC,weth:registry.legacy.WETH,swapper:registry.sweep.swapper,quoteEndpoint:registry.sweep.quoteEndpoint,aliases:policy.displayPriceAliases,pricing:policy.pricing,market:policy.currentMarketReference};
export type YieldStore={prepare?:(boundary:number,chainIds?:number[])=>void;load:()=>Promise<YieldLedger>;update:<T>(change:(state:YieldLedger)=>Promise<T>)=>Promise<T>};
export function sharedYieldWindowStart(createdAt:number,end:number,historyStarts:number[]){
 if(![createdAt,end,...historyStarts].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('yield_window_time_invalid');
 const origin=Math.max(createdAt,...historyStarts);return {origin,start:Math.max(end-WEEK,origin)};
}
const claimEvents=parseAbi([
 'event ClaimFees(uint256 indexed _tokenId,address indexed _recipient,address indexed _token,uint256 _amount)',
 'event ClaimIncentives(uint256 indexed _tokenId,address indexed _recipient,uint256 indexed _programId,uint256 _amount)',
 'struct GaugeAllocation {address gauge;uint128 allocated;bytes data;}',
 'event GaugesAllocated(uint256 indexed _tokenId,GaugeAllocation[] _allocations,uint256 _emissionsPerVP)'
]);
type Source={key:string;name:string;chainId:number;historyFromBlock:string;seedGauges:string[];logChunkBlocks:number;usdc:string|null;explorer:string;approvedRecipients:string[]};
type Rpc=ReturnType<typeof createPublicClient>;
type Context={source:Source;clients:Rpc[];block:bigint;timestamp:number;hash:string;factory:string;read:(a:string,s:string,args?:readonly unknown[],at?:bigint)=>Promise<any>;header:(at:bigint)=>Promise<any>};
export function yieldReadSources(baseUrls:string[]){
  return policy.chains.map(source=>{
    if(source.key==='base')return {source,urls:baseUrls};
    const url=new URL(baseUrls[0]);if(url.hostname!=='base-mainnet.g.alchemy.com')return {source,urls:[]};
    url.hostname=source.key==='ethereum'?'eth-mainnet.g.alchemy.com':'robinhood-mainnet.g.alchemy.com';
    if(source.key==='ethereum'){
      const independent=new URL(baseUrls[1]);if(independent.hostname!=='base-mainnet.infura.io')return {source,urls:[url.href]};
      independent.hostname='mainnet.infura.io';return {source,urls:[url.href,independent.href]};
    }
    return {source,urls:[url.href]}; // Robinhood remains explicitly single-provider.

  });
}
async function context(source:Source,urls:string[]):Promise<Context>{
  if(!urls.length)throw Error('yield_chain_connection_unavailable');
  const clients=urls.map(url=>createPublicClient({transport:http(url,{retryCount:0,timeout:20000,fetchFn:readRpcFetch}),ccipRead:false}));
  const ids=await Promise.all(clients.map(c=>c.getChainId()));if(ids.some(id=>id!==source.chainId))throw Error('yield_wrong_chain');
  const heads=await Promise.all(clients.map(c=>c.getBlock({blockTag:'finalized'}))),block=heads.reduce((n,h)=>h.number<n?h.number:n,heads[0].number);
  const header=async(at:bigint)=>{const rows=await Promise.all(clients.map(c=>c.getBlock({blockNumber:at})));if(rows.some(h=>h.hash!==rows[0].hash||h.timestamp!==rows[0].timestamp))throw Error('yield_header_disagreement');return rows[0];};
  const head=await header(block);if(Date.now()/1000-Number(head.timestamp)>3600)throw Error('yield_finalized_head_stale');
  const read=async(a:string,s:string,args:readonly unknown[]=[],at=block)=>{const abi=parseAbi([s]),functionName=s.match(/^function (\w+)/)![1];const values=await Promise.all(clients.map(c=>c.readContract({address:a as Address,abi,functionName,args,blockNumber:at} as any)));if(values.some(v=>canonical(v)!==canonical(values[0])))throw Error('yield_read_disagreement');return values[0];};
  const factory=await read(policy.leafVoter,'function FACTORY_REGISTRY() view returns(address)');if(typeof factory!=='string'||!isAddress(factory)||same(factory,zero))throw Error('yield_factory_invalid');
  return {source,clients,block,timestamp:Number(head.timestamp),hash:head.hash!,factory,read,header};
}
const receiptShape=(r:any)=>({hash:r.transactionHash,block:r.blockNumber,blockHash:r.blockHash,status:r.status,logs:r.logs.map((l:any)=>({address:l.address.toLowerCase(),data:l.data,topics:l.topics,index:l.logIndex}))});
export async function verifyYieldReceipt(ctx:Pick<Context,'clients'|'header'>,hash:`0x${string}`,at:bigint){
  const rows=await Promise.all(ctx.clients.map(c=>c.getTransactionReceipt({hash})));if(rows.some(r=>canonical(receiptShape(r))!==canonical(receiptShape(rows[0]))))throw Error('yield_receipt_disagreement');
  const receipt=rows[0],header=await ctx.header(at);if(!same(receipt.transactionHash,hash)||receipt.status!=='success'||receipt.blockNumber!==at||receipt.blockHash!==header.hash)throw Error('yield_receipt_not_canonical');return {receipt,timestamp:Number(header.timestamp)};
}
async function tokenInfo(ctx:Context,token:string,at=ctx.block){
  if(same(token,zero))return {decimals:18,symbol:'ETH'};
  let decimals:number|null=null,symbol=token.slice(0,6)+'…'+token.slice(-4);
  try{const d=Number(await ctx.read(token,'function decimals() view returns(uint8)',[],at));if(!Number.isInteger(d)||d<0||d>36)throw Error();decimals=d;}catch{}
  try{const s=String(await ctx.read(token,'function symbol() view returns(string)',[],at));if(s.length&&s.length<=32&&!/[\x00-\x1f]/.test(s))symbol=s;}catch{}
  return {decimals,symbol};
}
async function verifiedManager(ctx:Context,vrm:string,at=ctx.block){
  const gauge=await ctx.read(ctx.factory,'function rewardsToGauge(address) view returns(address)',[vrm],at);
  if(same(gauge,zero)||!same(await ctx.read(ctx.factory,'function gaugeToRewards(address) view returns(address)',[gauge],at),vrm))throw Error('yield_unregistered_manager');return gauge as string;
}
const topics=claimEvents.filter(e=>e.type==='event').map(event=>encodeEventTopics({abi:[event],eventName:event.name} as any)[0]);
async function logs(ctx:Context,from:bigint,to:bigint):Promise<any[]>{
  const filter={fromBlock:toHex(from),toBlock:toHex(to),topics:[topics,toHex(BigInt(policy.positionId),{size:32})]};
  let results:any[];
  try{results=await Promise.all(ctx.clients.map(c=>c.request({method:'eth_getLogs',params:[filter]} as any)));}
  catch(error){const text=String((error as any)?.shortMessage??'')+' '+String((error as any)?.details??'');if(to>from&&/block range|range.*large|limited.*blocks|maximum.*range|query.*more|too many results|exceeds.*range/i.test(text)){const mid=(from+to)/2n;return [...await logs(ctx,from,mid),...await logs(ctx,mid+1n,to)];}throw Error('yield_log_read_failed');}
  const shape=(rows:any[])=>rows.map(l=>({address:l.address.toLowerCase(),data:l.data,topics:l.topics,blockNumber:l.blockNumber,blockHash:l.blockHash,transactionHash:l.transactionHash,logIndex:l.logIndex})).sort((a,b)=>Number(BigInt(a.blockNumber)-BigInt(b.blockNumber))||Number(BigInt(a.logIndex)-BigInt(b.logIndex)));
  if(results.some(r=>canonical(shape(r))!==canonical(shape(results[0]))))throw Error('yield_log_disagreement');return results[0];
}
export async function scanYieldHistory(ctx:Context,state:YieldLedger){
  const id=String(ctx.source.chainId),previous=state.cursors[id];
  if(previous){if(BigInt(previous.block)>ctx.block||(await ctx.header(BigInt(previous.block))).hash!==previous.hash)throw Error('yield_history_checkpoint_changed');}
  if(previous&&BigInt(previous.block)<ctx.block)previous.complete=false;
  const upgrading=!!previous&&ctx.clients.length>previous.providers;
  let from=upgrading?previous.auditBlock?BigInt(previous.auditBlock)+1n:BigInt(ctx.source.historyFromBlock):previous?BigInt(previous.block)+1n:BigInt(ctx.source.historyFromBlock),last=previous,iterations=0;
  const gauges=new Set([...(previous?.gauges??[]),...ctx.source.seedGauges].map(s=>s.toLowerCase()));
  while(from<=ctx.block&&iterations++<policy.maxLogChunksPerRun){
    const to=from+BigInt(ctx.source.logChunkBlocks)-1n<ctx.block?from+BigInt(ctx.source.logChunkBlocks)-1n:ctx.block,events=await logs(ctx,from,to);
    const receipts=new Map<string,Awaited<ReturnType<typeof verifyYieldReceipt>>>();
    for(const log of events){if(log.removed)throw Error('yield_removed_log');const event=decodeEventLog({abi:claimEvents,data:log.data,topics:log.topics}) as any;
      if(event.args._tokenId!==BigInt(policy.positionId))throw Error('yield_wrong_position');
      if(event.eventName==='GaugesAllocated'){if(same(log.address,policy.leafVoter))for(const a of event.args._allocations)gauges.add(a.gauge.toLowerCase());continue;}
      // An arbitrary contract can emit these topics. Registration at the claim block is mandatory.
      const at=BigInt(log.blockNumber);if(at<from||at>to||at>ctx.block)throw Error('yield_log_outside_finalized_range');let gauge:string;try{gauge=await verifiedManager(ctx,log.address,at);}catch(e){if((e as Error).message==='yield_unregistered_manager')continue;throw e;}gauges.add(gauge.toLowerCase());
      let checked=receipts.get(log.transactionHash);if(!checked){checked=await verifyYieldReceipt(ctx,log.transactionHash,at);receipts.set(log.transactionHash,checked);}
      const receiptLog=checked.receipt.logs.find(l=>l.logIndex===Number(BigInt(log.logIndex)));if(!receiptLog||!same(receiptLog.address,log.address)||receiptLog.data!==log.data||canonical(receiptLog.topics)!==canonical(log.topics))throw Error('yield_log_receipt_mismatch');
      let token:string,programId:string|null=null;
      if(event.eventName==='ClaimFees')token=event.args._token;
      else {programId=String(event.args._programId);const program=await ctx.read(log.address,'function incentive(uint256) view returns((address token,uint256 amount,uint256 rate,uint48 start,uint48 end,address creator))',[BigInt(programId)],at);token=program.token;}
      if(!isAddress(token))throw Error('yield_reward_token_invalid');
      const amount=BigInt(event.args._amount);if(amount===0n)continue;
      const recipientRecognised=ctx.source.approvedRecipients.some(address=>same(address,event.args._recipient));
      const info=await tokenInfo(ctx,token,at),usdc=ctx.source.usdc&&same(token,ctx.source.usdc);
      const claim:YieldClaim={id:id+':'+log.transactionHash.toLowerCase()+':'+Number(BigInt(log.logIndex)),chainId:ctx.source.chainId,block:at.toString(),blockHash:checked.receipt.blockHash,timestamp:checked.timestamp,transactionHash:log.transactionHash,logIndex:Number(BigInt(log.logIndex)),manager:log.address,recipient:event.args._recipient,token,amount:amount.toString(),...info,kind:event.eventName==='ClaimFees'?'fees':'incentive',programId,recipientRecognised,valueUsdcWad:recipientRecognised&&usdc&&info.decimals===6?(amount*10n**12n).toString():null,valuation:recipientRecognised&&usdc&&info.decimals===6?'exact-usdc':'unpriced',providers:ctx.clients.length};
      addClaim(state,claim);
    }
    const header=await ctx.header(to);last={block:to.toString(),hash:header.hash!,timestamp:Number(header.timestamp),fromBlock:ctx.source.historyFromBlock,providers:ctx.clients.length,complete:to===ctx.block,gauges:[...gauges].sort()};if(upgrading&&previous&&to<BigInt(previous.block)){last={...previous,complete:false,auditBlock:to.toString(),gauges:[...gauges].sort()};}state.cursors[id]=last;from=to+1n;
  }
  if(last&&!last.auditBlock&&BigInt(last.block)===ctx.block)last.complete=true;
}
export async function refreshClaimMetadata(ctx:Context,state:YieldLedger){
 const candidates=state.claims.map(c=>effectiveClaim(state,c)).filter(c=>c.chainId===ctx.source.chainId&&(c.decimals===null||c.symbol.startsWith('0x')||c.recipientRecognised===false&&ctx.source.approvedRecipients.some(a=>same(a,c.recipient)))).slice(0,50);
 for(const c of candidates){if((await ctx.header(BigInt(c.block))).hash!==c.blockHash)throw Error('yield_claim_header_changed');const info=await tokenInfo(ctx,c.token,BigInt(c.block)),recognised=c.recipientRecognised!==false||ctx.source.approvedRecipients.some(a=>same(a,c.recipient)),exact=recognised&&ctx.source.usdc&&same(c.token,ctx.source.usdc)&&(info.decimals??c.decimals)===6;
  addClaim(state,{...c,decimals:info.decimals??c.decimals,symbol:info.decimals!==null?info.symbol:c.symbol,recipientRecognised:recognised,providers:Math.min(c.providers,ctx.clients.length),valueUsdcWad:exact?(BigInt(c.amount)*10n**12n).toString():c.valueUsdcWad,valuation:exact?'exact-usdc':c.valuation});
 }
}
async function pending(ctx:Context,state:YieldLedger,at=ctx.block){
  const current=await ctx.read(policy.leafVoter,'function allocatedGauges(uint256) view returns(address[])',[BigInt(policy.positionId)],at);
  const gauges=[...new Set([...current,...(state.cursors[ctx.source.chainId]?.gauges??[]),...ctx.source.seedGauges].map((s:string)=>s.toLowerCase()))],amounts=new Map<string,bigint>(),errors:string[]=[];
  const add=(token:string,amount:bigint)=>{if(amount>0n)amounts.set(token.toLowerCase(),(amounts.get(token.toLowerCase())??0n)+amount);};
  for(const gauge of gauges){try{
    const vrm=await ctx.read(ctx.factory,'function gaugeToRewards(address) view returns(address)',[gauge],at);if(same(vrm,zero))continue;await verifiedManager(ctx,vrm,at);
    const [t0,t1,fees,count,checkpoints]=await Promise.all([
      ctx.read(vrm,'function token0() view returns(address)',[],at),ctx.read(vrm,'function token1() view returns(address)',[],at),
      ctx.read(vrm,'function earnedFees(uint256,uint256) view returns(uint256,uint256)',[BigInt(policy.positionId),BigInt(policy.maxCheckpoints)],at),
      ctx.read(vrm,'function incentiveCount() view returns(uint256)',[],at),ctx.read(vrm,'function userRewardCheckpointIndex(uint256) view returns(uint256)',[BigInt(policy.positionId)],at)
    ]);
    if(BigInt(checkpoints)>=BigInt(policy.maxCheckpoints))errors.push('Some checkpoint history exceeds the pending-read bound.');
    add(t0,BigInt(fees[0]));add(t1,BigInt(fees[1]));
    const limit=Number(BigInt(count)>BigInt(policy.maxProgramsPerManager)?BigInt(policy.maxProgramsPerManager):BigInt(count));if(BigInt(count)>BigInt(limit))errors.push('Some incentive programs remain unread.');
    for(let start=1;start<=limit;start+=6)await Promise.all(Array.from({length:Math.min(6,limit-start+1)},async(_,offset)=>{const i=start+offset;const [program,earned]=await Promise.all([ctx.read(vrm,'function incentive(uint256) view returns((address token,uint256 amount,uint256 rate,uint48 start,uint48 end,address creator))',[BigInt(i)],at),ctx.read(vrm,'function earnedIncentives(uint256,uint256,uint256) view returns(uint256)',[BigInt(policy.positionId),BigInt(i),BigInt(policy.maxCheckpoints)],at)]);add(program.token,BigInt(earned));}));
  }catch{errors.push('A gauge reward read could not be verified.');}}
  const assets:YieldAsset[]=[];
  for(const [token,amount] of amounts){const info=await tokenInfo(ctx,token,at);assets.push({chainId:ctx.source.chainId,token,amount:amount.toString(),...info,valueUsdcWad:ctx.source.usdc&&same(token,ctx.source.usdc)&&info.decimals===6?(amount*10n**12n).toString():null});}
  return {assets,errors:[...new Set(errors)]};
}
export function approvedIncomeRecipients(source:Source,boot:any){
 // Only reviewed income routes are eligible; a token, wrapper or router address is not an income policy.
 const routeKeys=['svault','revenueConverter','rewardForwarder'];
 const verified=source.key==='base'&&boot.newStack?.ready?routeKeys.map(k=>boot.newStack.addresses?.[k]).filter((a):a is string=>typeof a==='string'&&isAddress(a)&&!same(a,zero)):[];
 return [...new Set([...source.approvedRecipients,...verified].map(a=>a.toLowerCase()))];
}
export function yieldPriceUniverse(state:YieldLedger,assets:YieldAsset[],timestamp:number){
 const all=[...assets,...state.snapshots.filter(s=>s.timestamp>=timestamp-WEEK&&s.timestamp<=timestamp).flatMap(s=>s.assets),...state.claims.filter(c=>c.timestamp>timestamp-WEEK&&c.timestamp<=timestamp).map(c=>effectiveClaim(state,c))],tokens=new Map<string,YieldAsset>();
 for(const a of all)if(a.decimals!==null&&a.decimals>=0&&a.decimals<=36){const canonical=policy.chains.find(c=>c.chainId===a.chainId)?.usdc;tokens.set(a.chainId+':'+a.token.toLowerCase(),{chainId:a.chainId,token:a.token,decimals:a.decimals,symbol:a.symbol,amount:(10n**BigInt(a.decimals)).toString(),valueUsdcWad:canonical&&same(canonical,a.token)&&a.decimals===6?(10n**18n).toString():null});}
 return [...tokens.values()];
}
async function historicalBoundary(ctx:Context,timestamp:number){
  let lo=BigInt(ctx.source.historyFromBlock),hi=ctx.block;
  if(Number((await ctx.header(lo)).timestamp)>timestamp)throw Error('yield_boundary_precedes_chain_history');
  while(lo<hi){const mid=(lo+hi+1n)/2n;if(Number((await ctx.header(mid)).timestamp)<=timestamp)lo=mid;else hi=mid-1n;}return lo;
}
export async function recordBoundary(state:YieldLedger,contexts:Context[],timestamp:number,options:{id?:string;priceAssets?:boolean;allowSingleProvider?:boolean;pricer?:(assets:YieldAsset[])=>Promise<unknown>}={}){
  if(timestamp<Date.parse(policy.positionCreatedAt)/1000||contexts.length!==policy.chains.length||contexts.some(c=>c.clients.length<(options.allowSingleProvider?1:2)||timestamp>c.timestamp))return;
  const baseId=options.id??'boundary:'+timestamp;
  const family=state.snapshots.filter(s=>s.id===baseId||s.id.startsWith(baseId+':retry:'));
  if(family.some(s=>s.timestamp!==timestamp))throw Error('yield_boundary_identity_changed');
  const existing=family.filter(s=>(s.observedComplete??s.pendingComplete)&&contexts.every(c=>s.chains.includes(c.source.chainId)&&(s.observationProviders?.[c.source.chainId]??(s.pendingComplete?2:0))>=c.clients.length)&&(!options.priceAssets||s.prices!==undefined&&![...s.assets,...s.prices].some(a=>BigInt(a.amount)>0n&&(a.valueUsdcWad===null||!freshYieldPrice(a.price?.observedAt??Math.floor(s.recordedAt/1000),policy.pricing.maxAgeSeconds,policy.pricing.maxFutureSeconds))))).at(-1);
  if(existing)return existing;
  // An incomplete attempt is retained; recovery appends a new observation.
  const id=family.length?baseId+':retry:'+crypto.randomUUID():baseId;
  // Baselines are read at historical block state. A nearby stored sample is not
  // silently substituted for the requested seven-day boundary.
  const assets:YieldAsset[]=[],errors:string[]=[];let backing:bigint|undefined,tvl:bigint|null=null;
  for(const ctx of contexts){const at=await historicalBoundary(ctx,timestamp),p=await pending(ctx,state,at);assets.push(...p.assets);errors.push(...p.errors);
    if(ctx.source.key==='base'){
      const [stake,t0,t1,reserves,ad,ud]=await Promise.all([
        ctx.read(registry.aero.votingEscrow,'function staked(uint256) view returns((uint128 amount,uint48 end,bool isPermanent))',[BigInt(policy.positionId)],at),
        ctx.read(registry.sweep.aeroUsdcPool,'function token0() view returns(address)',[],at),ctx.read(registry.sweep.aeroUsdcPool,'function token1() view returns(address)',[],at),
        ctx.read(registry.sweep.aeroUsdcPool,'function getReserves() view returns(uint256,uint256,uint256)',[],at),ctx.read(registry.aero.token,'function decimals() view returns(uint8)',[],at),ctx.read(registry.legacy.USDC,'function decimals() view returns(uint8)',[],at)]);
      backing=BigInt(stake.amount);let price:bigint|null=null;
      if(same(t0,registry.aero.token)&&same(t1,registry.legacy.USDC))price=reservePrice(BigInt(reserves[0]),BigInt(reserves[1]),Number(ad),Number(ud));
      else if(same(t1,registry.aero.token)&&same(t0,registry.legacy.USDC))price=reservePrice(BigInt(reserves[1]),BigInt(reserves[0]),Number(ad),Number(ud));
      if(price!==null)tvl=backing*price/10n**BigInt(ad);
    }
  }
  if(backing===undefined)return;
  const prices=options.priceAssets?yieldPriceUniverse(state,assets,timestamp):undefined;
  if(options.priceAssets){const price=options.pricer??createCurrentYieldPricer(state,pricerConfig);await price(assets);await price(prices!);}
  const point={id,timestamp,recordedAt:Date.now(),backingAero:backing.toString(),tvlUsdcWad:tvl?.toString()??null,assets,...(prices?{prices}:{}),pendingComplete:errors.length===0&&contexts.every(c=>c.clients.length>=2),observedComplete:errors.length===0,observationProviders:Object.fromEntries(contexts.map(c=>[c.source.chainId,c.clients.length])),chains:contexts.map(c=>c.source.chainId),errors};addSnapshot(state,point);return point;
}
export function createYieldService(store:YieldStore,options:{automaticCatchup?:boolean;saveReport?:(value:any)=>Promise<void>;sources?:typeof yieldReadSources}={}){
let output:any,active:Promise<any>|undefined,lastRun=0;
async function collect(baseUrls:string[],boot:any){
  const errors:string[]=[],chains:any[]=[],contexts:Context[]=[],assets:YieldAsset[]=[];let scopeChains=policy.chains.map(c=>c.chainId),coverageVerified=false;
  for(const {source,urls} of (options.sources??yieldReadSources)(baseUrls)){const observed={...source,approvedRecipients:approvedIncomeRecipients(source,boot)};try{contexts.push(await context(observed,urls));}catch{errors.push(source.name+': finalized read connection unavailable.');chains.push({...source,status:'unavailable',providers:0});}}
  const root=contexts.find(c=>c.source.key==='base');
  if(root){try{const ids=await root.read(registry.aero.voter,'function allocationChainIds(uint256) view returns(uint256[])',[BigInt(policy.positionId)]);coverageVerified=true;scopeChains=[...new Set([...scopeChains,...ids.map((id:bigint)=>Number(id)).filter((id:number)=>id>0)])];for(const id of scopeChains.filter(id=>!policy.chains.some(c=>c.chainId===id))){errors.push('An allocated chain is not configured for yield observation.');chains.push({name:'Chain '+id,chainId:id,status:'unavailable',providers:0});}}catch{errors.push('Root allocation coverage could not be verified.');}}
  const windowEnd=Math.min(boot.snapshot.timestamp,...contexts.map(c=>c.timestamp));
  let windowOrigin=Date.parse(policy.positionCreatedAt)/1000,historyStartKnown=true;
  try{windowOrigin=sharedYieldWindowStart(windowOrigin,windowEnd,await Promise.all(contexts.map(async ctx=>Number((await ctx.header(BigInt(ctx.source.historyFromBlock))).timestamp)))).origin;}
  catch{historyStartKnown=false;errors.push('The common chain-history starting time is unavailable.');}
  const windowStart=Math.max(windowEnd-WEEK,windowOrigin);
  store.prepare?.(windowStart,scopeChains);
  let candidate:any;
  await store.update(async state=>{
    const price=createCurrentYieldPricer(state,pricerConfig);
    for(const source of policy.chains)if(!contexts.some(c=>c.source.chainId===source.chainId)&&state.cursors[source.chainId])state.cursors[source.chainId].complete=false;
    for(const ctx of contexts){let chainErrors:string[]=[];try{await scanYieldHistory(ctx,state);}catch{if(state.cursors[ctx.source.chainId])state.cursors[ctx.source.chainId].complete=false;chainErrors.push('Claim-history synchronization failed; previous receipts are preserved.');}
      try{await refreshClaimMetadata(ctx,state);}catch{chainErrors.push('Some saved reward metadata could not be refreshed.');}
      try{const p=await pending(ctx,state);assets.push(...p.assets);chainErrors.push(...p.errors);}catch{chainErrors.push('Pending rewards unavailable.');}
      const cursor=state.cursors[ctx.source.chainId];chains.push({key:ctx.source.key,name:ctx.source.name,chainId:ctx.source.chainId,explorer:ctx.source.explorer,providers:ctx.clients.length,block:ctx.block.toString(),timestamp:ctx.timestamp,indexedThrough:cursor?.block??null,historyComplete:!!cursor?.complete,status:chainErrors.length?'partial':!cursor?.complete?'indexing':ctx.clients.length>1?'verified':'single-provider',errors:chainErrors});errors.push(...chainErrors.map(s=>ctx.source.name+': '+s));
    }
    const priceProofs=await price(assets);
    for(const c of state.claims.map(c=>effectiveClaim(state,c)).filter(c=>c.valueUsdcWad===null&&claimValue(state,c)===null&&c.recipientRecognised!==false).slice(0,50)){const quote=await historicalClaimPrice(c,policy.pricing);if(quote)addValuation(state,{id:c.id+':historical',claimId:c.id,valueUsdcWad:quote.valueUsdcWad,recordedAt:Date.now(),proof:quote.proof});}
    let aligned=false;
    if(historyStartKnown&&coverageVerified&&contexts.length===policy.chains.length&&contexts.every(c=>c.clients.length>=1)&&chains.every(c=>c.historyComplete)){
      // A provisional estimate may use one provider, but it never overwrites an
      // independently verified boundary or fills the strict weekly APY fields.
      const observed=contexts.some(c=>c.clients.length<2),prefix=observed?'observed-':'';
      try{await recordBoundary(state,contexts,windowStart,{id:prefix+'boundary:'+windowStart,allowSingleProvider:observed});aligned=!!await recordBoundary(state,contexts,windowEnd,{id:prefix+'aligned:'+windowEnd,priceAssets:true,allowSingleProvider:observed,pricer:price});}catch{errors.push('The aligned finalized observation window is unavailable.');}
    }
    const capitalKnown=typeof boot.metrics.backingAero==='string'&&/^\d+$/.test(boot.metrics.backingAero);if(!capitalKnown)errors.push('The current capital basis could not be verified.');
    if(!aligned&&capitalKnown)addSnapshot(state,{id:'observation:'+contexts.map(c=>c.source.chainId+':'+c.block+':'+c.clients.length).join(':'),timestamp:windowEnd,recordedAt:Date.now(),backingAero:boot.metrics.backingAero,tvlUsdcWad:boot.metrics.market?.tvlUsdcWad??null,assets,pendingComplete:false,chains:contexts.map(c=>c.source.chainId),errors:[...new Set(errors)]});
    const summary=summariseYield(state,windowEnd,scopeChains,policy.economicAssetAliases,{startedAt:windowOrigin});
    if(!historyStartKnown)invalidateAnnualised(summary.annualised,'The common chain-history starting time is unavailable.');
    if(!capitalKnown){summary.receivedApy7d=null;summary.earnedApy7d=null;summary.apyUnavailableReason='The current capital basis is unavailable.';summary.receivedApyUnavailableReason=summary.apyUnavailableReason;invalidateAnnualised(summary.annualised,summary.apyUnavailableReason);}
    if(!coverageVerified){summary.historyComplete=false;summary.receivedValueUsdcWad=null;summary.receivedApy7d=null;summary.earnedApy7d=null;summary.apyUnavailableReason='Root allocation coverage is unavailable.';summary.receivedApyUnavailableReason=summary.apyUnavailableReason;invalidateAnnualised(summary.annualised,summary.apyUnavailableReason);}
    summary.pendingValueUsdcWad=assets.reduce((n,a)=>n+BigInt(a.valueUsdcWad??'0'),0n).toString();summary.pendingPartial=errors.length>0||chains.some(c=>!c.historyComplete)||assets.some(a=>a.valueUsdcWad===null);if(!assets.length&&errors.length)summary.pendingValueUsdcWad=null;
    const chainTotals=yieldChainTotals(state,assets,chains,windowEnd);
    candidate={status:'OBSERVED; LOCAL_AUTHOR_VERIFICATION',asOfTimestamp:windowEnd,positionId:policy.positionId,createdAt:policy.positionCreatedAt,readAtMs:Date.now(),summary,chains,chainTotals,priceProofs:Object.fromEntries(priceProofs),receivedHistory:receivedYieldDays(coverageVerified?state:{...state,cursors:{}},windowEnd,Date.parse(policy.positionCreatedAt)/1000,scopeChains),assets,errors:[...new Set(errors)],claims:state.claims.slice().sort((a,b)=>b.timestamp-a.timestamp||b.logIndex-a.logIndex).slice(0,200).map(c=>({...effectiveClaim(state,c),historicalValueUsdcWad:claimValue(state,c)})),storedClaims:state.claims.length,storedObservations:state.snapshots.length,storage:'Shared-store-compatible immutable protocol history; local SQLite is the development adapter.',method:'Pending quotes are estimates. Received values use exact canonical USDC or frozen validated historical valuations; unknown prices stay unavailable. No pending amount is counted as received. Short or single-provider returns are labelled provisional; independently verified weekly APYs remain separate.',productionAcceptance:false};
  });output=candidate;lastRun=Date.now();await options.saveReport?.(output);return output;
}
let lastError=false;
async function syncProtocolYield(baseUrls:string[],bootstrap:()=>Promise<any>){
  active??=bootstrap().then(boot=>collect(baseUrls,boot)).then(data=>{
    lastError=false;
    if(options.automaticCatchup!==false&&data.chains.some((c:any)=>c.indexedThrough&&!c.historyComplete&&!c.errors?.some((s:string)=>s.includes('history synchronization failed')))){
      const catchup=setTimeout(()=>{void syncProtocolYield(baseUrls,bootstrap).catch(()=>{});},15000);(catchup as any).unref?.();
    }
    return data;
  }).catch(()=>{lastError=true;lastRun=Date.now();throw Error('yield_sync_unavailable');}).finally(()=>{active=undefined;});return active;
}
async function protocolYield(baseUrls:string[],bootstrap:()=>Promise<any>){
  if(!active&&Date.now()-lastRun>=300000)void syncProtocolYield(baseUrls,bootstrap).catch(()=>{});
  if(output)return {...output,syncing:!!active,syncUnavailable:lastError};
  const state=await yieldHistory();const archived=summariseYield(state,Math.floor(Date.now()/1000),policy.chains.map(c=>c.chainId));archived.receivedValueUsdcWad=null;archived.pendingValueUsdcWad=null;archived.historyComplete=false;return {status:lastError?'UNAVAILABLE':'SYNCING',positionId:policy.positionId,createdAt:policy.positionCreatedAt,syncing:!!active,readAtMs:null,summary:archived,chains:policy.chains.map(c=>({name:c.name,chainId:c.chainId,status:'pending',providers:0,explorer:c.explorer})),assets:[],claims:state.claims.slice(-200).reverse(),storedClaims:state.claims.length,storedObservations:state.snapshots.length,errors:lastError?['Yield synchronization is temporarily unavailable. Saved receipts are preserved.']:[],storage:'Persistent local SQLite',productionAcceptance:false};
}
async function yieldHistory(){return store.load();}

return {syncProtocolYield,protocolYield,yieldHistory};
}
