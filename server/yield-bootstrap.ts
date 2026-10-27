import {configuredBaseReads} from './read-rpc-policy.ts';
import {readCoverage} from '../src/protocol-data/read-coverage.ts';
import {readRpcFetch} from './read-rpc-fetch.ts';
// Portable read-only capital-basis adapter shared by the scheduled Worker.
import {createPublicClient,http,parseAbi,stringToHex} from 'viem';
import registry from '../config/base.registry.json' with {type:'json'};
import deployment from '../config/saero.deployment.json' with {type:'json'};
import {verifyNewStack} from './new-stack.ts';
import {reservePrice} from './protocol-metrics.ts';
export async function yieldBootstrap(urls:string[]){
 configuredBaseReads(JSON.stringify(urls));
 const clients=urls.map(url=>createPublicClient({transport:http(url,{retryCount:0,timeout:20000,fetchFn:readRpcFetch}),ccipRead:false}));
 if((await Promise.all(clients.map(c=>c.getChainId()))).some(id=>id!==8453))throw Error('yield_base_chain');
 const heads=await Promise.all(clients.map(c=>c.getBlock({blockTag:'finalized'}))),block=heads.reduce((n,h)=>h.number<n?h.number:n,heads[0].number),headers=await Promise.all(clients.map(c=>c.getBlock({blockNumber:block})));
 if(headers.some(h=>h.hash!==headers[0].hash||h.timestamp!==headers[0].timestamp)||Date.now()/1000-Number(headers[0].timestamp)>3600)throw Error('yield_base_header');
 const read=async(address:string,signature:string,args:readonly unknown[]=[])=>{const values=await Promise.all(clients.map(c=>c.readContract({address:address as `0x${string}`,abi:parseAbi([signature]),functionName:signature.match(/^function (\w+)/)![1],args,blockNumber:block} as any)));if(values.some(v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x)!==JSON.stringify(values[0],(_,x)=>typeof x==='bigint'?x.toString():x)))throw Error('yield_base_read');return values[0] as any;};
 const [stake,t0,t1,type,reserves,ad,ud]=await Promise.all([
  read(registry.aero.votingEscrow,'function staked(uint256) view returns((uint128 amount,uint48 end,bool isPermanent))',[BigInt(registry.aero.protocolNft)]),read(registry.sweep.aeroUsdcPool,'function token0() view returns(address)'),read(registry.sweep.aeroUsdcPool,'function token1() view returns(address)'),read(registry.sweep.aeroUsdcPool,'function POOL_TYPE() view returns(bytes32)'),read(registry.sweep.aeroUsdcPool,'function getReserves() view returns(uint256,uint256,uint256)'),read(registry.aero.token,'function decimals() view returns(uint8)'),read(registry.legacy.USDC,'function decimals() view returns(uint8)')
 ]);
 const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();let price:bigint|null=null;
 if(type!==stringToHex('V2_VOLATILE',{size:32}))throw Error('yield_price_pool_type');
 if(same(t0,registry.aero.token)&&same(t1,registry.legacy.USDC))price=reservePrice(BigInt(reserves[0]),BigInt(reserves[1]),Number(ad),Number(ud));
 else if(same(t1,registry.aero.token)&&same(t0,registry.legacy.USDC))price=reservePrice(BigInt(reserves[1]),BigInt(reserves[0]),Number(ad),Number(ud));else throw Error('yield_price_pair');
 const newStack=await verifyNewStack(deployment,registry as any,read,async(address)=>{const codes=await Promise.all(clients.map(c=>c.getCode({address:address as `0x${string}`,blockNumber:block})));if(codes.some(v=>v!==codes[0]))throw Error('Runtime disagreement');return codes[0];});
 return {newStack,readCoverage:readCoverage(clients.length),snapshot:{block:block.toString(),timestamp:Number(headers[0].timestamp),hash:headers[0].hash,independentProviders:clients.length},metrics:{backingAero:stake.amount.toString(),market:{tvlUsdcWad:price===null?null:(BigInt(stake.amount)*price/10n**BigInt(ad)).toString()}}};
}
