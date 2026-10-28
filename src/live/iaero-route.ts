import {encodeAbiParameters,parseAbi,type Address} from 'viem';
import type {BaseClient} from './client';
import type {Bootstrap} from './types';

// [VERIFIED: production frontend 0f3e3e6 / RewardsSection, Aero Commands.sol]
// Carry forward the live site's CL route and total fees/impact limit.
export const IAERO_ROUTE_COST_BPS=200n;
export const METAQUOTER_ABI=parseAbi(['function quoteExactInput(address[] pools,address tokenIn,uint256 amountIn) returns(uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList)']);
const PAIR_ABI=parseAbi(['function token0() view returns(address)','function token1() view returns(address)','function getReserves() view returns(uint256,uint256,uint256)','function slot0() view returns(uint160,int24,uint16,uint16,uint16,bool)']);
export const MARKET_ROUTE_PARAMS=[{type:'tuple',components:[{name:'pools',type:'address[]'},{name:'tokenIn',type:'address'},{name:'amountIn',type:'tuple',components:[{name:'mode',type:'uint8'},{name:'value',type:'uint256'}]},{name:'payerIsUser',type:'bool'},{name:'minAmountOut',type:'uint256'},{name:'recipient',type:'address'}]}] as const;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function marketMidOutput(amount:bigint,aeroReserve:bigint,usdcReserve:bigint,sqrtPriceX96:bigint,aeroIsClToken0:boolean){
 if(amount<=0n||aeroReserve<=0n||usdcReserve<=0n||sqrtPriceX96<=0n||sqrtPriceX96>=2n**160n)throw Error('The Aero market price is unavailable.');
 const aero=amount*aeroReserve/usdcReserve,ratio=sqrtPriceX96*sqrtPriceX96;
 const value=aeroIsClToken0?aero*ratio/(2n**192n):aero*(2n**192n)/ratio;
 if(value<=0n||value>=2n**256n)throw Error('The Aero market output is unavailable.');return value;
}
export async function quoteIaeroRoute(client:BaseClient,boot:Bootstrap,amount:bigint){
 if(!boot.marketRouteReady||amount<=0n)throw Error('A positive input and verified Aero route are required.');
 const {sweep,legacy,aero}=boot.registry,block=await client.getBlock(),read=(address:Address,functionName:'token0'|'token1'|'getReserves'|'slot0')=>client.readContract({address,abi:PAIR_ABI,functionName,blockNumber:block.number});
 const [v0,v1,c0,c1,reserves,slot]=await Promise.all([read(sweep.aeroUsdcPool,'token0'),read(sweep.aeroUsdcPool,'token1'),read(sweep.aeroIaeroClPool,'token0'),read(sweep.aeroIaeroClPool,'token1'),read(sweep.aeroUsdcPool,'getReserves'),read(sweep.aeroIaeroClPool,'slot0')]);
 const v=[String(v0),String(v1)],c=[String(c0),String(c1)];
 if(v.map(a=>a.toLowerCase()).sort().join()!==[aero.token,legacy.USDC].map(a=>a.toLowerCase()).sort().join()||c.map(a=>a.toLowerCase()).sort().join()!==[aero.token,legacy.iAERO].map(a=>a.toLowerCase()).sort().join()||!Array.isArray(reserves)||!Array.isArray(slot))throw Error('The Aero market tokens do not match this route.');
 const mid=marketMidOutput(amount,BigInt(reserves[same(v[0],aero.token)?0:1]),BigInt(reserves[same(v[0],aero.token)?1:0]),BigInt(slot[0]),same(c[0],aero.token));
 const quote=await client.simulateContract({address:sweep.metaquoter,abi:METAQUOTER_ABI,functionName:'quoteExactInput',args:[[sweep.aeroUsdcPool,sweep.aeroIaeroClPool],legacy.USDC,amount],blockNumber:block.number});
 const output=quote.result[0],costMinimum=mid*(10000n-IAERO_ROUTE_COST_BPS)/10000n;
 if(output<=0n||costMinimum<=0n||output<costMinimum)throw Error('The iAERO conversion exceeds the 2% pool-fee and price-impact limit. Keep USDC or try a smaller amount.');
 return {output,mid,costMinimum,block};
}
export function encodeIaeroRoute(boot:Bootstrap,user:Address,usdc:bigint,minimum:bigint){
 const s=boot.registry.sweep;
 return {commands:'0x0800' as const,inputs:[
  encodeAbiParameters(MARKET_ROUTE_PARAMS,[{pools:[s.aeroUsdcPool],tokenIn:boot.registry.legacy.USDC,amountIn:{mode:0,value:usdc},payerIsUser:true,minAmountOut:0n,recipient:s.metarouter}]),
  encodeAbiParameters(MARKET_ROUTE_PARAMS,[{pools:[s.aeroIaeroClPool],tokenIn:boot.registry.aero.token,amountIn:{mode:1,value:1000000n},payerIsUser:false,minAmountOut:minimum,recipient:user}])
 ]};
}

// The compound flow receives new AERO directly from RewardSwapper. Its final
// [VERIFIED: deployed-aero-audit/inputs/deployed-tree/V3/src/metarouter/libraries/Commands.sol]
// conversion uses only the verified AERO/iAERO CL pool (CL_SWAP_EXACT_IN=0x00).
export async function quoteAeroIaeroRoute(client:BaseClient,boot:Bootstrap,amount:bigint){
 if(!boot.aeroCompoundReady||amount<=0n||amount>=2n**256n)throw Error('A positive AERO input and verified compound route are required.');
 const {sweep,legacy,aero}=boot.registry,block=await client.getBlock(),read=(functionName:'token0'|'token1'|'slot0')=>client.readContract({address:sweep.aeroIaeroClPool,abi:PAIR_ABI,functionName,blockNumber:block.number});
 const [token0,token1,slot]=await Promise.all([read('token0'),read('token1'),read('slot0')]);
 if([String(token0),String(token1)].map(a=>a.toLowerCase()).sort().join()!==[aero.token,legacy.iAERO].map(a=>a.toLowerCase()).sort().join()||!Array.isArray(slot))throw Error('The Aero market tokens do not match this route.');
 const sqrt=BigInt(slot[0]);if(sqrt<=0n||sqrt>=2n**160n)throw Error('The Aero market price is unavailable.');
 const ratio=sqrt*sqrt,mid=same(String(token0),aero.token)?amount*ratio/(2n**192n):amount*(2n**192n)/ratio;
 if(mid<=0n||mid>=2n**256n)throw Error('The Aero market output is unavailable.');
 const quote=await client.simulateContract({address:sweep.metaquoter,abi:METAQUOTER_ABI,functionName:'quoteExactInput',args:[[sweep.aeroIaeroClPool],aero.token,amount],blockNumber:block.number}),output=quote.result[0],costMinimum=mid*(10000n-IAERO_ROUTE_COST_BPS)/10000n;
 if(output<=0n||costMinimum<=0n||output<costMinimum)throw Error('The iAERO conversion exceeds the 2% pool-fee and price-impact limit. Keep AERO or try a smaller amount.');
 return {output,mid,costMinimum,block};
}
export function encodeAeroIaeroRoute(boot:Bootstrap,user:Address,amount:bigint,minimum:bigint){
 if(amount<=0n||minimum<=0n)throw Error('Positive AERO input and iAERO minimum are required.');
 return {commands:'0x00' as const,inputs:[encodeAbiParameters(MARKET_ROUTE_PARAMS,[{pools:[boot.registry.sweep.aeroIaeroClPool],tokenIn:boot.registry.aero.token,amountIn:{mode:0,value:amount},payerIsUser:true,minAmountOut:minimum,recipient:user}])]};
}
