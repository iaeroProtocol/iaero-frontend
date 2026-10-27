import {isAddress,keccak256,parseAbi,type Address} from 'viem';
import registry from '../config/base.registry.json' with {type:'json'};
import deployment from '../config/saero.deployment.json' with {type:'json'};
import {readProtocolMarketMetrics} from './protocol-metrics.ts';
import {verifyNewStack} from './new-stack.ts';
import type {Bootstrap} from '../src/live/types.ts';
type Client={getChainId:()=>Promise<number>;getBlock:(request:any)=>Promise<any>;getCode:(request:any)=>Promise<`0x${string}`|undefined>;readContract:(request:any)=>Promise<any>};
type Run=<T>(job:()=>Promise<T>)=>Promise<T>;
const canonical=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
/** Domains share one independently verified header, not one failure flag. */
export async function inspectBootstrap(clients:Client[],run:Run=job=>job()):Promise<Bootstrap>{
 if(clients.length!==2||(await Promise.all(clients.map(c=>c.getChainId()))).some(id=>id!==8453))throw Error('Two Base read connections are required.');
 const final=await Promise.all(clients.map(c=>c.getBlock({blockTag:'finalized'}))),block=final[0].number<final[1].number?final[0].number:final[1].number;
 const headers=await Promise.all(clients.map(c=>c.getBlock({blockNumber:block}))),timestamp=Number(headers[0].timestamp);
 if(headers.some(h=>h.hash!==headers[0].hash||h.timestamp!==headers[0].timestamp)||!Number.isSafeInteger(timestamp)||timestamp>Date.now()/1000+60||Date.now()/1000-timestamp>3600)throw Error('Finalized Base snapshot is stale or disagrees.');
 const snapshot={block:block.toString(),hash:headers[0].hash,timestamp,independentProviders:2},serviceErrors:Record<string,string>={};
 const optional=async<T>(domain:string,operation:()=>Promise<T>,fallback:T):Promise<T>=>{try{return await operation();}catch{serviceErrors[domain]=domain+' readback is unavailable; its actions remain disabled.';return fallback;}};
 const targets={...registry.legacy,aero:registry.aero.token,votingEscrow:registry.aero.votingEscrow,liqDistributor:registry.liqStaking.distributor,forwarder:registry.forwarder,...Object.fromEntries(Object.entries(registry.sweep).filter(([key])=>key!=='quoteEndpoint'))};
 const contracts:Bootstrap['contracts']={};
 await Promise.all(Object.entries(targets).map(async([name,address])=>{
  try{const codes=await Promise.all(clients.map(c=>run(()=>c.getCode({address:address as Address,blockNumber:block}))));if(codes[0]!==codes[1])throw Error();contracts[name]={address:address as Address,deployed:!!codes[0]&&codes[0]!=='0x',codeHash:codes[0]&&codes[0]!=='0x'?keccak256(codes[0]):null};}
  catch{contracts[name]={address:address as Address,deployed:false,codeHash:null};serviceErrors['contract:'+name]='The '+name+' runtime readback is unavailable.';}
 }));
 const read=async(address:string,signature:string,args:readonly unknown[]=[])=>{
  const functionName=signature.match(/^function (\w+)\(/)?.[1];if(!functionName)throw Error('Invalid contract read.');
  const values=await Promise.all(clients.map(c=>run(()=>c.readContract({address:address as Address,abi:parseAbi([signature]),functionName,args,blockNumber:block}))));
  if(values.some(v=>canonical(v)!==canonical(values[0])))throw Error('Finalized getter differs between providers.');return values[0];
 };
 const deployed=(...names:string[])=>names.every(n=>contracts[n]?.deployed);
 const legacyReady=await optional('Previous staking',async()=>deployed('epochDistributor','iAERO','stiAERO')&&same(await read(registry.legacy.epochDistributor,'function iAERO() view returns(address)'),registry.legacy.iAERO)&&same(await read(registry.legacy.epochDistributor,'function receiptToken() view returns(address)'),registry.legacy.stiAERO),false);
 const legacyPaused=await optional<boolean|undefined>('Previous pause status',async()=>Boolean(await read(registry.legacy.epochDistributor,'function paused() view returns(bool)')),undefined);
 // AutoVault USDC claims need its own verified links, independently of a failed
 // legacy principal readback. Withdrawals retain the underlying staking gate.
 const oldAutoReady=await optional('Previous AutoVault',async()=>deployed('autoVault','USDC')&&same(await read(registry.legacy.autoVault,'function iAERO() view returns(address)'),registry.legacy.iAERO)&&same(await read(registry.legacy.autoVault,'function USDC() view returns(address)'),registry.legacy.USDC)&&same(await read(registry.legacy.autoVault,'function epochDist() view returns(address)'),registry.legacy.epochDistributor),false);
 const liqStakingReady=await optional('LIQ staking',async()=>deployed('liqDistributor','LIQ')&&same(await read(registry.liqStaking.distributor,'function LIQ() view returns(address)'),registry.legacy.LIQ)&&BigInt(await read(registry.liqStaking.distributor,'function LOCK_PERIOD() view returns(uint256)'))===604800n,false);
 const liqStaking=liqStakingReady?await optional<Bootstrap['metrics']['liqStaking']>('LIQ stake totals',async()=>{const [total,paused]=await Promise.all([read(registry.liqStaking.distributor,'function totalLIQStaked() view returns(uint256)'),read(registry.liqStaking.distributor,'function paused() view returns(bool)')]);if(typeof total!=='bigint'||total<0n||typeof paused!=='boolean')throw Error();return {totalStaked:total.toString(),paused};},undefined):undefined;
 let rewardRegistryError:string|undefined;
 const rewardTokenAddresses=await optional<Address[]>('Reward registry',async()=>{const tokens=await read(registry.sweep.tokenRegistry,'function allTokens() view returns(address[])');if(!Array.isArray(tokens)||tokens.length>5000||!tokens.every(t=>isAddress(t)))throw Error();return tokens;},[]);
 if(serviceErrors['Reward registry'])rewardRegistryError='The reward registry could not be verified. Configured, indexed and manually added tokens remain available.';
 const sweepReady=await optional('Reward sweeps',async()=>deployed('swapper','multicall3','USDC','WETH')&&same(await read(registry.sweep.swapper,'function weth() view returns(address)'),registry.legacy.WETH)&&Boolean(await read(registry.sweep.swapper,'function allowedOutToken(address) view returns(bool)',[registry.legacy.USDC])),false);
 const pairMatches=async(pool:string,pair:string[])=>{const tokens=await Promise.all(['token0','token1'].map(name=>read(pool,`function ${name}() view returns(address)`)));return tokens.map(t=>String(t).toLowerCase()).sort().join()===pair.map(t=>t.toLowerCase()).sort().join();};
 const marketRouteReady=await optional('iAERO market',async()=>deployed('metarouter','aeroUsdcPool','aeroIaeroClPool','metaquoter','aero','iAERO','USDC')&&await pairMatches(registry.sweep.aeroUsdcPool,[registry.legacy.USDC,registry.aero.token])&&await pairMatches(registry.sweep.aeroIaeroClPool,[registry.aero.token,registry.legacy.iAERO]),false);
 const stake=await optional<any>('Protocol backing',()=>read(registry.aero.votingEscrow,'function staked(uint256) view returns((uint128 amount,uint48 end,bool isPermanent))',[BigInt(registry.aero.protocolNft)]),undefined);
 const owner=await optional<Address|undefined>('NFT custody',()=>read(registry.aero.votingEscrow,'function ownerOf(uint256) view returns(address)',[BigInt(registry.aero.protocolNft)]),undefined);
 const totalLegacyStaked=await optional<string|undefined>('Previous total stake',async()=>String(await read(registry.legacy.epochDistributor,'function totalStaked() view returns(uint256)')),undefined);
 const backingAero=stake?.amount!==undefined?String(stake.amount):undefined;
 const market=await readProtocolMarketMetrics(read,registry,backingAero===undefined?undefined:BigInt(backingAero),snapshot).catch(()=>undefined);
 const newStack=await verifyNewStack(deployment,registry as any,read,async(address)=>{const codes=await Promise.all(clients.map(c=>run(()=>c.getCode({address,blockNumber:block}))));if(codes[0]!==codes[1])throw Error('Runtime disagreement.');return codes[0];});
 let allocations:{chainId:string;amount:string}[]|undefined;
 try{const ids=await read(registry.aero.voter,'function allocationChainIds(uint256) view returns(uint256[])',[BigInt(registry.aero.protocolNft)]);if(!Array.isArray(ids)||ids.length>32)throw Error();allocations=await Promise.all([...new Set([0n,...ids])].map(async(chainId:any)=>({chainId:String(chainId),amount:String(await read(registry.aero.voter,'function allocationChainAmounts(uint256,uint256) view returns(uint128)',[BigInt(registry.aero.protocolNft),BigInt(chainId)]))})));}catch{serviceErrors.Allocations='Current chain allocations could not be verified.';}
 return {registry:registry as unknown as Bootstrap['registry'],liqStakingReady,newStack,rewardTokenAddresses,rewardRegistryError,sweepReady,marketRouteReady,verifiedAt:new Date().toISOString(),snapshot,contracts,serviceErrors,legacyReady,legacyPaused,oldAutoReady,newStackReady:newStack.ready,newStackReason:newStack.reason,metrics:{market,liqStaking,allocations,backingAero,permanent:stake?.isPermanent,protocolNftOwner:owner,legacyTotalStaked:totalLegacyStaked}};
}
