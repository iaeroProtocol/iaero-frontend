import {expect,it} from 'vitest';
import {createPublicClient,custom,decodeFunctionData,encodeFunctionResult,parseAbi,type Address} from 'viem';
import {base} from 'viem/chains';
import registry from '../config/base.registry.json';
import tokenFilter from '../config/spam-tokens.base.json';
import {scanSweepWallet} from '../src/live/sweep';
import type {BaseClient} from '../src/live/client';
import type {Bootstrap} from '../src/live/types';
it('batches a large wallet metadata scan and preserves balances when one symbol reverts',async()=>{
 const tokens=Array.from({length:40},(_,i)=>('0x'+(0x9000000000000000000000000000000000000000n+BigInt(i)).toString(16)) as Address),abi=parseAbi(['function balanceOf(address) view returns(uint256)','function symbol() view returns(string)','function decimals() view returns(uint8)','function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] returnData)']),requests:any[]=[];
 const call=(target:string,data:`0x${string}`):`0x${string}`=>{const decoded=decodeFunctionData({abi,data});let result:any;if(decoded.functionName==='aggregate3')result=(decoded.args![0] as any[]).map(c=>{try{return {success:true,returnData:call(c.target,c.callData)};}catch{return {success:false,returnData:'0x'};}});else if(decoded.functionName==='balanceOf')result=1n;else if(decoded.functionName==='decimals')result=18;else{if(target.toLowerCase()===tokens[3])throw Error('Symbol reverted');result='TKN-'+String(tokens.findIndex(t=>t===target.toLowerCase())).padStart(3,'0');}return encodeFunctionResult({abi,functionName:decoded.functionName,result} as any);};
 const raw=createPublicClient({chain:base,batch:{multicall:false},ccipRead:false,transport:custom({request:async request=>{requests.push(request);expect(request.method).toBe('eth_call');const tx=(request.params as any)[0];return call(tx.to,tx.data);}})}),client={...raw,getBlock:async()=>({number:9000000n,timestamp:1793000000n})} as unknown as BaseClient,boot={registry:{...registry,knownLegacyRewardTokens:[]},rewardTokenAddresses:tokens,contracts:{multicall3:{deployed:true}},sweepReady:true,tokenFilter} as unknown as Bootstrap;
 const result=await scanSweepWallet(client,boot,tokens[0]);expect(result.tokens).toHaveLength(40);expect(result.errors).toEqual([]);expect(result.hidden).toEqual([]);expect(result.tokens.every(t=>t.balance===1n&&t.decimals===18)).toBe(true);expect(result.tokens.find(t=>t.token===tokens[3])!.symbol).toContain('…');expect(result.tokens.find(t=>t.token===tokens[0])!.symbol).toBe('TKN-000');expect(requests.length).toBeLessThanOrEqual(12);expect(raw.batch?.multicall).toBe(false);
});
