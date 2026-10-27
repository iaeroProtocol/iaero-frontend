import {expect,it} from 'vitest';
import {createPublicClient,custom,decodeFunctionData,encodeFunctionResult,parseAbi} from 'viem';
import {base} from 'viem/chains';
import registry from '../config/base.registry.json';
import {accountReadClient} from '../src/live/account-read-client';
import type {BaseClient} from '../src/live/client';
import type {Bootstrap} from '../src/live/types';
const abi=parseAbi(['function balanceOf(address) view returns(uint256)']),aggregate=parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] returnData)']),user='0x1111111111111111111111111111111111111111';
it('reads many balances in one pinned multicall without changing the execution client',async()=>{
 const requests:any[]=[],original=createPublicClient({chain:base,batch:{multicall:false},ccipRead:false,transport:custom({request:async request=>{requests.push(request);const calls=decodeFunctionData({abi:aggregate,data:(request.params as any)[0].data}).args![0];expect(calls).toHaveLength(40);return encodeFunctionResult({abi:aggregate,functionName:'aggregate3',result:calls.map(()=>({success:true,returnData:encodeFunctionResult({abi,functionName:'balanceOf',result:42n})}))});}})}),boot={registry,contracts:{multicall3:{deployed:true}}} as unknown as Bootstrap,reader=accountReadClient(original as unknown as BaseClient,boot);
 const values=await Promise.all(Array.from({length:40},()=>reader.readContract({address:registry.legacy.USDC as any,abi,functionName:'balanceOf',args:[user],blockNumber:9000000n})));expect(values).toEqual(Array(40).fill(42n));expect(requests).toHaveLength(1);expect(requests[0].params[1]).toBe('0x895440');expect(original.batch?.multicall).toBe(false);expect(reader.ccipRead).toBe(false);
});
it('keeps direct reads when the multicall deployment is not verified',()=>{const original=createPublicClient({chain:base,transport:custom({request:async()=>{throw Error('Must not call');}})});expect(accountReadClient(original as unknown as BaseClient,{registry,contracts:{}} as unknown as Bootstrap)).toBe(original);});
