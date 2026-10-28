import {it,expect} from 'vitest';
import {createPublicClient,custom,parseAbi,decodeFunctionData,encodeFunctionResult,keccak256,multicall3Abi} from 'viem';
import {yieldContractReader} from '../server/yield-read-client';
const address='0x1111111111111111111111111111111111111111',multicall='0xcA11bde05977b3631167028862bE2a173976CA11',code='0x6000',abi=parseAbi(['function value(uint256 n) view returns(uint256)']);
const policy={address:multicall,runtimeHash:keccak256(code),batchSize:16384};
function observer(options:{runtime?:(block:string)=>string;codeFails?:boolean;delta?:bigint;revert?:bigint;aggregateFails?:boolean}={}){
 const calls:any[]=[];
 const value=(data:`0x${string}`)=>{const n=decodeFunctionData({abi,data}).args![0];if(n===options.revert)throw Error('contract_reverted');return encodeFunctionResult({abi,functionName:'value',result:n+(options.delta??0n)});};
 const client=createPublicClient({transport:custom({request:async({method,params}:any)=>{
  calls.push({method,params});
  if(method==='eth_getCode'){if(options.codeFails)throw Error('code_unavailable');return options.runtime?.(params[1])??code;}
  if(method==='eth_call'){
   const [{to,data}]=params;
   if(to.toLowerCase()===multicall.toLowerCase()){
    if(options.aggregateFails)throw Error('gas required exceeds: 16777216');
    const decoded=decodeFunctionData({abi:multicall3Abi,data});
    if(decoded.functionName!=='aggregate3')throw Error('unexpected_multicall');
    return encodeFunctionResult({abi:multicall3Abi,functionName:'aggregate3',result:decoded.args[0].map(call=>{try{return {success:true,returnData:value(call.callData)};}catch{return {success:false,returnData:'0x' as const};}})});
   }
   return value(data);
  }
  throw Error('unexpected_method_'+method);
 }},{retryCount:0}),ccipRead:false});
 return {client,calls};
}
const request=(n:bigint,blockNumber=100n)=>({address,abi,functionName:'value',args:[n],blockNumber});
it('combines independent observers at the exact pinned block without dropping comparisons',async()=>{
 const a=observer(),b=observer(),read=yieldContractReader([a.client,b.client],42161,policy);
 expect(await Promise.all(Array.from({length:16},(_,i)=>read(request(BigInt(i)))))).toEqual(Array.from({length:16},(_,i)=>BigInt(i)));
 for(const o of [a,b]){expect(o.calls.map(c=>c.method)).toEqual(['eth_getCode','eth_call']);expect(o.calls.every(c=>c.params[1]==='0x64')).toBe(true);expect(o.calls[1].params[0].to.toLowerCase()).toBe(multicall.toLowerCase());}
});
it('retains direct reads from every observer if any runtime is wrong',async()=>{
 const a=observer(),b=observer({runtime:()=> '0x6001'}),read=yieldContractReader([a.client,b.client],42161,policy);
 expect(await Promise.all([read(request(1n)),read(request(2n))])).toEqual([1n,2n]);
 for(const o of [a,b]){expect(o.calls.filter(c=>c.method==='eth_call')).toHaveLength(2);expect(o.calls.filter(c=>c.method==='eth_call').every(c=>c.params[0].to===address)).toBe(true);}
});
it('falls back to original direct reads on an unavailable runtime proof',async()=>{
 const a=observer({codeFails:true}),read=yieldContractReader([a.client],1,policy);
 expect(await Promise.all([read(request(3n)),read(request(4n))])).toEqual([3n,4n]);
 expect(a.calls.filter(c=>c.method==='eth_getCode')).toHaveLength(1);expect(a.calls.filter(c=>c.method==='eth_call').every(c=>c.params[0].to===address)).toBe(true);
});
it('requires a new exact-block proof for every historical boundary and collection',async()=>{
 const a=observer({runtime:block=>block==='0x65'?'0x6001':code}),read=yieldContractReader([a.client],8453,policy);
 expect(await read(request(5n))).toBe(5n);expect(await read(request(6n,101n))).toBe(6n);expect(await yieldContractReader([a.client],8453,policy)(request(7n))).toBe(7n);
 expect(a.calls.filter(c=>c.method==='eth_getCode').map(c=>c.params[1])).toEqual(['0x64','0x65','0x64']);
 expect(a.calls.filter(c=>c.method==='eth_call').map(c=>c.params[0].to.toLowerCase())).toEqual([multicall.toLowerCase(),address,multicall.toLowerCase()]);
});
it('rejects disagreement even after both provider runtimes pass',async()=>{
 const a=observer(),b=observer({delta:1n}),read=yieldContractReader([a.client,b.client],8453,policy);
 await expect(read(request(9n))).rejects.toThrow('yield_read_disagreement');
});
it('recovers an aggregate gas failure with exact-block direct reads from the same observer',async()=>{
 const a=observer({aggregateFails:true}),b=observer(),read=yieldContractReader([a.client,b.client],8453,policy);
 expect(await Promise.all([read(request(1n)),read(request(2n))])).toEqual([1n,2n]);
 expect(a.calls.filter(c=>c.method==='eth_call'&&c.params[0].to===address)).toHaveLength(2);expect(b.calls.filter(c=>c.method==='eth_call'&&c.params[0].to===address)).toHaveLength(0);expect([...a.calls,...b.calls].every(c=>c.params[1]==='0x64')).toBe(true);
});
it('keeps a reverted leg unavailable while preserving successful sibling results',async()=>{
 const a=observer({revert:2n}),read=yieldContractReader([a.client],4663,policy),out=await Promise.allSettled([read(request(1n)),read(request(2n)),read(request(3n))]);
 expect(out.map(o=>o.status)).toEqual(['fulfilled','rejected','fulfilled']);expect((out[0] as PromiseFulfilledResult<bigint>).value).toBe(1n);expect((out[2] as PromiseFulfilledResult<bigint>).value).toBe(3n);
});
it('refuses unpinned contract reads before making any RPC request',async()=>{
 const a=observer(),read=yieldContractReader([a.client],8453,policy);
 await expect(read({...request(1n),blockNumber:undefined})).rejects.toThrow('yield_read_block_required');expect(a.calls).toEqual([]);
});
