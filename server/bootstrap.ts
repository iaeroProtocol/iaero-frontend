import {isAddress,keccak256,parseAbi,type Address} from 'viem';
import registry from '../config/base.registry.json' with {type:'json'};
import deployment from '../config/saero.deployment.json' with {type:'json'};
import {readProtocolMarketMetrics} from './protocol-metrics.ts';
import {verifyNewStack} from './new-stack.ts';
import type {Bootstrap} from '../src/live/types.ts';
import {readCoverage} from '../src/protocol-data/read-coverage.ts';
type Client={getChainId:()=>Promise<number>;getBlock:(request:any)=>Promise<any>;getCode:(request:any)=>Promise<`0x${string}`|undefined>;readContract:(request:any)=>Promise<any>};
type Run=<T>(job:()=>Promise<T>)=>Promise<T>;
const canonical=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
/** Domains share one finalized header; each domain keeps its own failure flag. */
export async function inspectBootstrap(clients:Client[],run:Run=job=>job()):Promise<Bootstrap>{
 if(clients.length<1||clients.length>2||(await Promise.all(clients.map(c=>c.getChainId()))).some(id=>id!==8453))throw Error('Approved Base read connections are required.');
 const final=await Promise.all(clients.map(c=>c.getBlock({blockTag:'finalized'}))),block=final.reduce((n,h)=>h.number<n?h.number:n,final[0].number);
 const headers=await Promise.all(clients.map(c=>c.getBlock({blockNumber:block}))),timestamp=Number(headers[0].timestamp);
 if(headers.some(h=>h.hash!==headers[0].hash||h.timestamp!==headers[0].timestamp)||!Number.isSafeInteger(timestamp)||timestamp>Date.now()/1000+60||Date.now()/1000-timestamp>3600)throw Error('Finalized Base snapshot is stale or disagrees.');
 const snapshot={block:block.toString(),hash:headers[0].hash,timestamp,independentProviders:clients.length},serviceErrors:Record<string,string>={};
 const optional=async<T>(domain:string,operation:()=>Promise<T>,fallback:T):Promise<T>=>{try{return await operation();}catch{serviceErrors[domain]=domain+' readback is unavailable; its actions remain disabled.';return fallback;}};
 const targets={...registry.legacy,aero:registry.aero.token,votingEscrow:registry.aero.votingEscrow,liqDistributor:registry.liqStaking.distributor,forwarder:registry.forwarder,...Object.fromEntries(Object.entries(registry.sweep).filter(([key])=>key!=='quoteEndpoint'))};
 const contracts:Bootstrap['contracts']={};
 await Promise.all(Object.entries(targets).map(async([name,address])=>{
  try{const codes=await Promise.all(clients.map(c=>run(()=>c.getCode({address:address as Address,blockNumber:block}))));if(codes.some(code=>code!==codes[0]))throw Error();contracts[name]={address:address as Address,deployed:!!codes[0]&&codes[0]!=='0x',codeHash:codes[0]&&codes[0]!=='0x'?keccak256(codes[0]):null};}
  catch{contracts[name]={address:address as Address,deployed:false,codeHash:null};serviceErrors['contract:'+name]='The '+name+' runtime readback is unavailable.';}
 }));
 const reads=new Map<string,Promise<any>>();
 const read=(address:string,signature:string,args:readonly unknown[]=[])=>{
  const key=canonical([address.toLowerCase(),signature,args]);let pending=reads.get(key);if(pending)return pending;
  pending=(async()=>{const functionName=signature.match(/^function (\w+)\(/)?.[1];if(!functionName)throw Error('Invalid contract read.');
   const values=await Promise.all(clients.map(c=>{const get=()=>c.readContract({address:address as Address,abi:parseAbi([signature]),functionName,args,blockNumber:block,batch:contracts.multicall3?.deployed===true});return contracts.multicall3?.deployed===true?get():run(get);}));
   if(values.some(v=>canonical(v)!==canonical(values[0])))throw Error('Finalized getter differs between providers.');return values[0];
  })();reads.set(key,pending);return pending;
 };
 const deployed=(...names:string[])=>names.every(n=>contracts[n]?.deployed);
 const pairMatches=async(pool:string,pair:string[])=>{const tokens=await Promise.all(['token0','token1'].map(name=>read(pool,`function ${name}() view returns(address)`)));return tokens.map(t=>String(t).toLowerCase()).sort().join()===pair.map(t=>t.toLowerCase()).sort().join();};
 // Independent domains run together. Getter promises belong only to this pinned
 // inspection; verified Multicall3 groups them without a cross-request cache.
 const legacy=optional('Previous staking',async()=>{if(!deployed('epochDistributor','iAERO','stiAERO'))return false;const [token,receipt]=await Promise.all([read(registry.legacy.epochDistributor,'function iAERO() view returns(address)'),read(registry.legacy.epochDistributor,'function receiptToken() view returns(address)')]);return same(token,registry.legacy.iAERO)&&same(receipt,registry.legacy.stiAERO);},false);
 const paused=optional<boolean|undefined>('Previous pause status',async()=>Boolean(await read(registry.legacy.epochDistributor,'function paused() view returns(bool)')),undefined);
 const auto=optional('Previous AutoVault',async()=>{if(!deployed('autoVault','USDC'))return false;const [token,usdc,dist]=await Promise.all([read(registry.legacy.autoVault,'function iAERO() view returns(address)'),read(registry.legacy.autoVault,'function USDC() view returns(address)'),read(registry.legacy.autoVault,'function epochDist() view returns(address)')]);return same(token,registry.legacy.iAERO)&&same(usdc,registry.legacy.USDC)&&same(dist,registry.legacy.epochDistributor);},false);
 const liq=optional('LIQ staking',async()=>{if(!deployed('liqDistributor','LIQ'))return false;const [token,lock]=await Promise.all([read(registry.liqStaking.distributor,'function LIQ() view returns(address)'),read(registry.liqStaking.distributor,'function LOCK_PERIOD() view returns(uint256)')]);return same(token,registry.legacy.LIQ)&&BigInt(lock)===604800n;},false);
 const liqTotals=liq.then(ready=>ready?optional<Bootstrap['metrics']['liqStaking']>('LIQ stake totals',async()=>{const [total,paused]=await Promise.all([read(registry.liqStaking.distributor,'function totalLIQStaked() view returns(uint256)'),read(registry.liqStaking.distributor,'function paused() view returns(bool)')]);if(typeof total!=='bigint'||total<0n||typeof paused!=='boolean')throw Error();return {totalStaked:total.toString(),paused};},undefined):undefined);
 const rewardRegistry=optional<Address[]>('Reward registry',async()=>{const tokens=await read(registry.sweep.tokenRegistry,'function allTokens() view returns(address[])');if(!Array.isArray(tokens)||tokens.length>5000||!tokens.every(t=>isAddress(t)))throw Error();return tokens;},[]);
 const sweep=optional('Reward sweeps',async()=>{if(!deployed('swapper','multicall3','USDC','WETH'))return false;const [weth,allowed]=await Promise.all([read(registry.sweep.swapper,'function weth() view returns(address)'),read(registry.sweep.swapper,'function allowedOutToken(address) view returns(bool)',[registry.legacy.USDC])]);return same(weth,registry.legacy.WETH)&&Boolean(allowed);},false);
 const route=optional('iAERO market',async()=>{if(!deployed('metarouter','aeroUsdcPool','aeroIaeroClPool','metaquoter','aero','iAERO','USDC'))return false;const pairs=await Promise.all([pairMatches(registry.sweep.aeroUsdcPool,[registry.legacy.USDC,registry.aero.token]),pairMatches(registry.sweep.aeroIaeroClPool,[registry.aero.token,registry.legacy.iAERO])]);return pairs.every(Boolean);},false);
 const compound=optional('AERO compounding',async()=>{if(!deployed('swapper','metarouter','aeroIaeroClPool','metaquoter','aero','iAERO'))return false;const [pair,allowed,decimals]=await Promise.all([pairMatches(registry.sweep.aeroIaeroClPool,[registry.aero.token,registry.legacy.iAERO]),read(registry.sweep.swapper,'function allowedOutToken(address) view returns(bool)',[registry.aero.token]),read(registry.aero.token,'function decimals() view returns(uint8)')]);return pair&&allowed===true&&decimals===18;},false);
 const backing=optional<any>('Protocol backing',()=>read(registry.aero.votingEscrow,'function staked(uint256) view returns((uint128 amount,uint48 end,bool isPermanent))',[BigInt(registry.aero.protocolNft)]),undefined);
 const custody=optional<Address|undefined>('NFT custody',()=>read(registry.aero.votingEscrow,'function ownerOf(uint256) view returns(address)',[BigInt(registry.aero.protocolNft)]),undefined);
 const legacyTotal=optional<string|undefined>('Previous total stake',async()=>String(await read(registry.legacy.epochDistributor,'function totalStaked() view returns(uint256)')),undefined);
 const marketRead=backing.then(stake=>readProtocolMarketMetrics(read,registry,stake?.amount===undefined?undefined:BigInt(stake.amount),snapshot).catch(()=>undefined));
 const stack=verifyNewStack(deployment,registry as any,read,async(address)=>{const codes=await Promise.all(clients.map(c=>run(()=>c.getCode({address,blockNumber:block}))));if(codes.some(code=>code!==codes[0]))throw Error('Runtime disagreement.');return codes[0];});
 const allocationRead=(async()=>{try{const ids=await read(registry.aero.voter,'function allocationChainIds(uint256) view returns(uint256[])',[BigInt(registry.aero.protocolNft)]);if(!Array.isArray(ids)||ids.length>32)throw Error();return await Promise.all([...new Set([0n,...ids])].map(async(chainId:any)=>({chainId:String(chainId),amount:String(await read(registry.aero.voter,'function allocationChainAmounts(uint256,uint256) view returns(uint128)',[BigInt(registry.aero.protocolNft),BigInt(chainId)]))})));}catch{serviceErrors.Allocations='Current chain allocations could not be verified.';return undefined;}})();
 const [legacyReady,legacyPaused,oldAutoReady,liqStakingReady,liqStaking,rewardTokenAddresses,sweepReady,marketRouteReady,aeroCompoundReady,stake,owner,totalLegacyStaked,market,newStack,allocations]=await Promise.all([legacy,paused,auto,liq,liqTotals,rewardRegistry,sweep,route,compound,backing,custody,legacyTotal,marketRead,stack,allocationRead]);
 const rewardRegistryError=serviceErrors['Reward registry']?'The reward registry could not be verified. Configured, indexed and manually added tokens remain available.':undefined,backingAero=stake?.amount!==undefined?String(stake.amount):undefined;
 return {registry:registry as unknown as Bootstrap['registry'],readCoverage:readCoverage(clients.length),liqStakingReady,newStack,rewardTokenAddresses,rewardRegistryError,sweepReady,marketRouteReady,aeroCompoundReady,verifiedAt:new Date().toISOString(),snapshot,contracts,serviceErrors,legacyReady,legacyPaused,oldAutoReady,newStackReady:newStack.ready,newStackReason:newStack.reason,metrics:{market,liqStaking,allocations,backingAero,permanent:stake?.isPermanent,protocolNftOwner:owner,legacyTotalStaked:totalLegacyStaked}};
}
