import {encodeAbiParameters,isAddress,parseAbi,type Address} from 'viem';
import type {BaseClient} from './client';
import type {Bootstrap} from './types';
import {accountReadClient} from './account-read-client';
import {MARKET_ROUTE_PARAMS,METAQUOTER_ABI} from './iaero-route';

const REGISTRY_ABI=parseAbi(['function FACTORY_REGISTRY() view returns(address)','function targetFactories() view returns(address[])','function isMetaRouterApproved(address) view returns(bool)','function tickSpacings() view returns(int24[])']);
const V2_ABI=parseAbi(['function getPool(address,address) view returns(address)']);
const CL_ABI=parseAbi(['function getPool(address,address,int24) view returns(address)']);
const POOL_ABI=parseAbi(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function getReserves() view returns(uint256,uint256,uint256)','function slot0() view returns(uint160,int24,uint16,uint16,uint16,bool)']);
export const NATIVE_COST_BPS=500n;
export type NativePool={address:Address;factory:Address;kind:'V2'|'CL';token0:Address;token1:Address;reserve0?:bigint;reserve1?:bigint;sqrt?:bigint};
export type NativeRoute={pools:NativePool[];tokens:Address[];costMinimum:bigint};
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const positive=(v:unknown):v is bigint=>typeof v==='bigint'&&v>0n&&v<2n**256n;
const address=(v:unknown):v is Address=>typeof v==='string'&&isAddress(v)&&BigInt(v)!==0n;

// Discovery is scoped to this one quote/recheck, at one current block. The
// registry, factories, pools and prices are never retained across submissions.
export function nativeSweepSession(client:BaseClient,boot:Bootstrap){
 let proof:ReturnType<typeof load>|undefined;
 const load=async()=>{
  const registry=boot.registry.sweep.factoryRegistry;
  if(!registry||!boot.contracts?.factoryRegistry?.deployed||!boot.contracts?.metarouter?.deployed||!boot.contracts?.metaquoter?.deployed||!boot.contracts?.multicall3?.deployed)throw Error('The native Aero route has not been verified.');
  const block=await client.getBlock(),reader=accountReadClient(client,boot);
  const read=(target:Address,abi:readonly unknown[],functionName:string,args:readonly unknown[]=[])=>reader.readContract({address:target,abi,functionName,args,blockNumber:block.number} as any) as Promise<any>;
  const [linked,approved,factories]=await Promise.all([read(boot.registry.sweep.metarouter,REGISTRY_ABI,'FACTORY_REGISTRY'),read(registry,REGISTRY_ABI,'isMetaRouterApproved',[boot.registry.sweep.metarouter]),read(registry,REGISTRY_ABI,'targetFactories')]);
  if(!same(linked,registry)||approved!==true||!Array.isArray(factories)||factories.length<1||factories.length>8||!factories.every(address)||new Set(factories.map((a:string)=>a.toLowerCase())).size!==factories.length)throw Error('The native Aero factory registry does not match.');
  const rows=await Promise.all(factories.map(async(factory:Address)=>{
   try{const spacings=await read(factory,REGISTRY_ABI,'tickSpacings');if(!Array.isArray(spacings)||!spacings.length||spacings.length>32||spacings.some(t=>!Number.isInteger(Number(t))||Number(t)<=0||Number(t)>=2**23))throw Error('Invalid CL spacings');return {factory,spacings:spacings.map(Number)};}
   catch{return {factory,spacings:[] as number[]};}
  }));
  return {block,read,rows};
 };
 const verified=()=>proof??=(load());
 const pairs=new Map<string,Promise<NativePool[]>>();
 const pair=(a:Address,b:Address)=>{
  const key=[a.toLowerCase(),b.toLowerCase()].sort().join(':');let pending=pairs.get(key);if(pending)return pending;
  pending=(async()=>{
   const p=await verified();
   const options=p.rows.flatMap<{factory:Address;kind:'CL'|'V2';spacing:number}>(row=>row.spacings.length?row.spacings.map(spacing=>({factory:row.factory,kind:'CL' as const,spacing})):[{factory:row.factory,kind:'V2' as const,spacing:0}]);
   const found=await Promise.all(options.map(async option=>{
    let pool:Address;try{pool=await p.read(option.factory,option.kind==='CL'?CL_ABI:V2_ABI,'getPool',option.kind==='CL'?[a,b,option.spacing]:[a,b]);}catch{return undefined;}
    if(!address(pool))return undefined;
    try{
     const [token0,token1,factory,state]=await Promise.all([p.read(pool,POOL_ABI,'token0'),p.read(pool,POOL_ABI,'token1'),p.read(pool,POOL_ABI,'factory'),p.read(pool,POOL_ABI,option.kind==='CL'?'slot0':'getReserves')]);
     if(!address(token0)||!address(token1)||!same(factory,option.factory)||[token0,token1].map(x=>x.toLowerCase()).sort().join()!==[a,b].map(x=>x.toLowerCase()).sort().join()||!Array.isArray(state))return undefined;
     if(option.kind==='CL'){if(!positive(state[0])||state[0]>=2n**160n)return undefined;return {address:pool,factory,kind:option.kind,token0,token1,sqrt:state[0]} as NativePool;}
     if(!positive(state[0])||!positive(state[1]))return undefined;return {address:pool,factory,kind:option.kind,token0,token1,reserve0:state[0],reserve1:state[1]} as NativePool;
    }catch{return undefined;}
   }));
   return [...new Map(found.filter((r):r is NativePool=>!!r).map(r=>[r.address.toLowerCase(),r])).values()];
  })();pairs.set(key,pending);return pending;
 };
 return {quote:async(tokenIn:Address,tokenOut:Address,amount:bigint)=>{
  if(!positive(amount)||same(tokenIn,tokenOut))throw Error('Choose a positive native-swap input.');
  const p=await verified(),hubs=[...new Map([boot.registry.aero.token,boot.registry.legacy.USDC,boot.registry.legacy.WETH].map(a=>[a.toLowerCase(),a])).values()].filter(a=>!same(a,tokenIn)&&!same(a,tokenOut));
  const paths:{pools:NativePool[];tokens:Address[]}[]=[];
  const direct=await pair(tokenIn,tokenOut);for(const pool of direct)paths.push({pools:[pool],tokens:[tokenIn,tokenOut]});
  await Promise.all(hubs.map(async hub=>{const [first,last]=await Promise.all([pair(tokenIn,hub),pair(hub,tokenOut)]);for(const a of first)for(const b of last)if(!same(a.address,b.address))paths.push({pools:[a,b],tokens:[tokenIn,hub,tokenOut]});}));
  // Bound expensive quoter work while keeping every direct pool. Two-hop paths
  // are ranked by their current marginal price, then checked by MetaQuoter.
  const mid=(path:typeof paths[number])=>path.pools.reduce((value,pool,i)=>{
   const forward=same(pool.token0,path.tokens[i]);if(pool.kind==='V2')return value*(forward?pool.reserve1!:pool.reserve0!)/(forward?pool.reserve0!:pool.reserve1!);
   const ratio=pool.sqrt!**2n;return forward?value*ratio/(2n**192n):value*(2n**192n)/ratio;
  },amount);
  const candidates=paths.filter(path=>positive(mid(path))).sort((a,b)=>{const aa=mid(a),bb=mid(b);return aa===bb?0:aa>bb?-1:1;}).slice(0,64);
  if(!candidates.length)throw Error('No verified native Aero pool route is available for this token.');
  const results=await client.multicall({multicallAddress:boot.registry.sweep.multicall3,allowFailure:true,batchSize:8192,blockNumber:p.block.number,contracts:candidates.map(path=>({address:boot.registry.sweep.metaquoter,abi:METAQUOTER_ABI,functionName:'quoteExactInput',args:[path.pools.map(pool=>pool.address),tokenIn,amount]} as const))});
  if(results.length!==candidates.length)throw Error('The grouped native route quote is incomplete.');
  let best:{route:NativeRoute;buyAmount:bigint}|undefined;
  for(let i=0;i<results.length;i++){const r=results[i];if(r.status!=='success'||!Array.isArray(r.result)||!positive(r.result[0]))continue;const costMinimum=mid(candidates[i])*(10000n-NATIVE_COST_BPS)/10000n;
   if(!positive(costMinimum)||r.result[0]<costMinimum)continue;
   if(!best||r.result[0]>best.buyAmount)best={route:{...candidates[i],costMinimum},buyAmount:r.result[0]};
  }
  if(!best)throw Error('Native Aero routes are unavailable or exceed the 5% fee and price-impact limit. This token stays in your wallet.');
  return {...best,quotedAt:Date.now()};
 }};
}
export function encodeNativeSweeps(boot:Bootstrap,user:Address,rows:readonly {input:{token:Address;amount:bigint};minimum:bigint;native:NativeRoute}[]){
 let commands='0x';const inputs:`0x${string}`[]=[];
 for(const row of rows){const {pools,tokens}=row.native;
  if(!pools.length||pools.length>2||tokens.length!==pools.length+1||!same(tokens[0],row.input.token)||!positive(row.input.amount)||!positive(row.minimum)||row.minimum<row.native.costMinimum)throw Error('Invalid native swap review.');
  for(let i=0;i<pools.length;i++){
   commands+=pools[i].kind==='CL'?'00':'08';
   inputs.push(encodeAbiParameters(MARKET_ROUTE_PARAMS,[{pools:[pools[i].address],tokenIn:tokens[i],amountIn:{mode:i===0?0:1,value:i===0?row.input.amount:1000000n},payerIsUser:i===0,minAmountOut:i===pools.length-1?row.minimum:0n,recipient:i===pools.length-1?user:boot.registry.sweep.metarouter}]));
  }
 }
 return {commands:commands as `0x${string}`,inputs};
}
