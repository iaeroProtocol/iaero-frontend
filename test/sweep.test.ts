import {afterEach,describe,expect,it,vi} from 'vitest';
import {ContractFunctionRevertedError,decodeAbiParameters,decodeFunctionData,encodeAbiParameters,encodeEventTopics,encodeFunctionResult,getAddress,parseAbi,type Address,type EIP1193Provider,type Hash} from 'viem';
import registry from '../config/base.registry.json';
import tokenFilter from '../config/spam-tokens.base.json';
import {UNIT,parseAmount,type Activity,type RewardLeg} from '../src/domain';
import {executeLiveAction,readAccount,type BaseClient,type ExecutionContext} from '../src/live/client';
import {CLAIM_LIMIT,claimAction,groupRewards,sendRewardClaims} from '../src/live/rewards';
import {initialLiveState,type Bootstrap} from '../src/live/types';
import {walletWorkflow} from '../src/live/session';
import {STAKING_ERC20_ABI} from '../src/protocol/streamingClient';
import {LEGACY_DEPOSIT_ABI,METAROUTER_ABI,POOL_ABI,ROUTE_PARAMS,SWEEP_ABI,TRANSFER_ABI,SWEEP_BATCH_LIMIT,SWEEP_GAS_LIMIT,buildSweepPreview,fetchSweepQuote,receiptIaero,receiptOutput,runSweep,swapStep,validateSweepInputs,type SweepInput,type SweepPreview} from '../src/live/sweep';
import {spamReason,type TokenFilter} from '../src/live/token-filter';
import {retryGas,retrySlippage,SweepPreflightRevert} from '../src/live/sweep-retries';
import {pendingTransaction} from '../src/protocol/pendingTransaction';

const user='0x1111111111111111111111111111111111111111' as Address,other='0x2222222222222222222222222222222222222222' as Address,router='0x0000000000001fF3684f28c67538d4D072C22734' as Address;
const epoch=1792627200n,hash=(n=1)=>('0x'+n.toString(16).padStart(64,'0')) as Hash;
const boot={registry,tokenFilter,sweepReady:true,marketRouteReady:true,aeroCompoundReady:true,legacyReady:true,oldAutoReady:true,legacyPaused:false,newStackReady:false,newStackReason:'Not deployed',snapshot:{block:'123',hash:hash(),timestamp:Number(epoch),independentProviders:2}} as unknown as Bootstrap;
const row=(token:Address=registry.legacy.WETH as Address,epochId=epoch,amount=1n):RewardLeg=>({token,epoch:epochId,amount,symbol:'WETH',decimals:18});
const input:SweepInput={token:registry.legacy.WETH as Address,symbol:'WETH',decimals:18,amount:UNIT};
const combined=[...SWEEP_ABI,...STAKING_ERC20_ABI,...METAROUTER_ABI,...LEGACY_DEPOSIT_ABI] as const;
function env(){
  const storage=new Map<string,string>();vi.stubGlobal('window',{location:{origin:'http://127.0.0.1:4318'},localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},dispatchEvent:()=>{}});
  vi.stubGlobal('navigator',{locks:{request:async(_k:string,_o:unknown,fn:(lock:{name:string})=>unknown)=>fn({name:'lock'})}});
  const sent:{to:string;name:string;args:any;hash:Hash;gas?:string}[]=[],receipts=new Map<Hash,any>(),allowances=new Map<string,bigint>(),simulationFailures=new Set<string>();let account:Address=user,chain='0x2105',output=100000000n,failReceipt=false,corruptLogs=false,postSwap=false,collapseMarket=false;
  const outputFor=(token:string)=>token.toLowerCase()===registry.aero.token.toLowerCase()?output*10n**12n:output;
  const failNext=new Map<string,number>();let receiptMode='normal';
  const allowanceKey=(token:string,spender:string)=>token.toLowerCase()+':'+spender.toLowerCase();
  const request=vi.fn(async(r:any):Promise<any>=>{
    if(r.method==='eth_accounts')return [account];if(r.method==='eth_chainId')return chain;
    if(r.method!=='eth_sendTransaction')throw Error('Unexpected wallet method '+r.method);
    const tx=r.params[0],decoded=decodeFunctionData({abi:combined,data:tx.data}),h=hash(sent.length+1);sent.push({to:tx.to,name:decoded.functionName,args:decoded.args,hash:h,gas:tx.gas});const logs:any[]=[];
    if((failNext.get(decoded.functionName)??0)>0){failNext.set(decoded.functionName,failNext.get(decoded.functionName)!-1);receipts.set(h,{status:'reverted',transactionHash:h,from:user,to:tx.to,logs:[]});return h;}
    if(decoded.functionName==='approve')allowances.set(allowanceKey(tx.to,decoded.args![0] as string),decoded.args![1] as bigint);
    if(decoded.functionName==='executePlanFromCallerAdvanced'){
      postSwap=true;for(const step of decoded.args![0] as any){logs.push({address:corruptLogs?other:registry.sweep.swapper,topics:encodeEventTopics({abi:SWEEP_ABI,eventName:'SwapExecuted',args:{tokenIn:step.tokenIn,outToken:step.outToken}}),data:encodeAbiParameters([{type:'uint8'},{type:'uint256'},{type:'uint256'}],[2,step.amountIn,outputFor(step.outToken)])});}
    }
    if(decoded.functionName==='execute'){
      const [route]=decodeAbiParameters(ROUTE_PARAMS,(decoded.args![1] as readonly Hash[])[0]),final=route;
      logs.push({address:registry.legacy.iAERO,topics:encodeEventTopics({abi:TRANSFER_ABI,eventName:'Transfer',args:{from:registry.sweep.aeroIaeroClPool as Address,to:final.recipient}}),data:encodeAbiParameters([{type:'uint256'}],[route.amountIn.value])});
    }
    receipts.set(h,{status:'success',transactionHash:h,from:user,to:tx.to,logs});return h;
  });
  const provider={request,on:()=>{},removeListener:()=>{}} as unknown as EIP1193Provider;
  const client={getChainId:vi.fn(async()=>8453),getBlock:vi.fn(async()=>({number:123n,timestamp:epoch+86400n})),
    readContract:vi.fn(async(r:any):Promise<any>=>{
      if(r.functionName==='balanceOf')return 1_000_000n*UNIT;if(r.functionName==='allowance')return allowances.get(allowanceKey(r.address,r.args[1]))??0n;
      if(r.functionName==='paused')return false;if(r.functionName==='agg0x')return router;if(r.functionName==='allowedSelectors')return true;if(r.functionName==='dustFloor')return 0n;
      if(r.functionName==='token0')return registry.aero.token;if(r.functionName==='token1')return r.address===registry.sweep.aeroUsdcPool?registry.legacy.USDC:registry.legacy.iAERO;if(r.functionName==='getReserves')return [UNIT,1000000n,0n];if(r.functionName==='slot0')return [2n**96n,0,0,0,0,true];
      if(r.functionName==='getAmountOutWithTotalFee')return postSwap&&collapseMarket?1n:r.address===registry.sweep.aeroUsdcPool?r.args[0]*10n**12n:r.args[0];
      if(r.functionName==='previewClaim')return 1n;if(r.functionName==='currentEpoch')return epoch;if(r.functionName==='previewUSDCMany')return [[],0n];if(r.functionName==='sharesOf')return 0n;if(r.functionName==='symbol')return 'TOKEN';if(r.functionName==='decimals')return 18;
      if(r.functionName==='previewClaimsForEpoch')return r.args[1].map(()=>1n);throw Error('Unexpected read '+r.functionName);
    }),getBalance:vi.fn(async()=>UNIT),estimateContractGas:vi.fn(async(r:any)=>300000n*BigInt(r.functionName==='executePlanFromCallerAdvanced'?r.args[0].length:1)),simulateContract:vi.fn(async(r:any)=>({request:r,...(r.functionName==='quoteExactInput'?{result:[postSwap&&collapseMarket?1n:r.args[2]*(r.args[1].toLowerCase()===registry.aero.token.toLowerCase()?1n:10n**12n),[],[]]}:{})})),
    simulateBlocks:vi.fn(async(r:any)=>[{calls:r.blocks[0].calls.map((call:any)=>{
      const {functionName:name,args=[]}=decodeFunctionData({abi:combined,data:call.data});
      if(name==='approve')return {status:'success',data:encodeFunctionResult({abi:STAKING_ERC20_ABI,functionName:'approve',result:true}),logs:[],gasUsed:40000n};
      const plan=args[0] as any[];
      return {status:plan.some(step=>simulationFailures.has(step.tokenIn.toLowerCase()))?'failure':'success',gasUsed:200000n*BigInt(plan.length),data:encodeFunctionResult({abi:SWEEP_ABI,functionName:'executePlanFromCallerAdvanced',result:plan.reduce((total,step)=>total+outputFor(step.outToken),0n)}),logs:plan.map(step=>({address:registry.sweep.swapper,topics:encodeEventTopics({abi:SWEEP_ABI,eventName:'SwapExecuted',args:{tokenIn:step.tokenIn,outToken:step.outToken}}),data:encodeAbiParameters([{type:'uint8'},{type:'uint256'},{type:'uint256'}],[2,step.amountIn,outputFor(step.outToken)])}))};
    })}]),waitForTransactionReceipt:vi.fn(async(r:any)=>{if(sent.find(tx=>tx.hash===r.hash)?.name==='executePlanFromCallerAdvanced'){if(receiptMode==='timeout')throw Error('Confirmation RPC timed out');if(receiptMode==='replaced')r.onReplaced?.();if(receiptMode==='mismatch')return {...receipts.get(r.hash),transactionHash:hash(999)};}return receipts.get(r.hash);}),getTransactionReceipt:vi.fn(async(r:any)=>{if(failReceipt)throw Error('Post-confirmation read failed');return receipts.get(r.hash);})} as unknown as BaseClient;
  const fetcher=vi.fn(async(url:any):Promise<any>=>{const q=new URL(String(url),'http://localhost');return {ok:true,json:async()=>({sellToken:q.searchParams.get('sellToken'),sellAmount:q.searchParams.get('sellAmount'),buyToken:q.searchParams.get('buyToken')??registry.legacy.USDC,buyAmount:outputFor(q.searchParams.get('buyToken')??registry.legacy.USDC).toString(),taker:registry.sweep.swapper,recipient:registry.sweep.swapper,transaction:{to:router,data:'0x12345678',value:'0'},quotedAt:Date.now()})};});vi.stubGlobal('fetch',fetcher);
  const confirmed=vi.fn(),broadcast=vi.fn(),context:ExecutionContext={client,provider,state:{...initialLiveState(),boot,address:user,chainId:8453,legacyPaused:false},onBroadcast:broadcast,onConfirmed:confirmed};
  return {client,provider,context,sent,receipts,confirmed,broadcast,fetcher,allowances,simulationFailures,failNext,setReceiptMode:(mode:string)=>{receiptMode=mode;},setAccount:(v:Address)=>{account=v;},setChain:(v:string)=>{chain=v;},setOutput:(v:bigint)=>{output=v;},setReceiptFailure:()=>{failReceipt=true;},setCorruptLogs:()=>{corruptLogs=true;},setMarketCollapse:()=>{collapseMarket=true;}};
}
afterEach(()=>vi.unstubAllGlobals());
describe('token aggregation and batch claims',()=>{
  it('aggregates by token address, keeps week details, and never mixes matching symbols',()=>{
    const groups=groupRewards([row(),row(input.token,epoch-604800n,2n),{...row(other),symbol:'WETH'}]);expect(groups).toHaveLength(2);expect(groups.find(g=>g.token===input.token)?.amount).toBe(3n);expect(groups.find(g=>g.token===input.token)?.legs).toHaveLength(2);expect(groups.find(g=>g.token===other)?.amount).toBe(1n);
  });
  it('retains native ETH dust and exact integer units',()=>{const group=groupRewards([row('0x0000000000000000000000000000000000000000',epoch,1n)])[0];expect(group.amount).toBe(1n);expect(group.token).toBe('0x0000000000000000000000000000000000000000');});
  it('rejects duplicate legs, invalid weeks and empty selections before requesting a wallet',()=>{
    expect(()=>claimAction([row(),row()])).toThrow('more than once');expect(()=>claimAction([row(input.token,epoch+1n)])).toThrow('invalid');expect(()=>claimAction([])).toThrow('non-empty');
  });
  it('uses exact token/week pairs and the real contract limit across multiple batches',async()=>{
    const e=env(),send=vi.fn(async(..._args:any[])=>hash()),rows=Array.from({length:51},(_,i)=>row(input.token,epoch-BigInt(i)*604800n));await sendRewardClaims({client:e.client,distributor:registry.legacy.epochDistributor as Address,user,rows,send});expect(CLAIM_LIMIT).toBe(50);expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[0]).toEqual([registry.legacy.epochDistributor,expect.any(Array),'claimMany',[Array(50).fill(input.token),rows.slice(0,50).map(r=>r.epoch)]]);expect(send.mock.calls[1][3][0]).toHaveLength(1);
  });
  it('persists confirmation callbacks for earlier batches when a later batch fails',async()=>{
    const e=env(),confirmed=vi.fn(),send=vi.fn().mockResolvedValueOnce(hash()).mockRejectedValueOnce(Error('Second batch reverted'));
    await expect(sendRewardClaims({client:e.client,distributor:registry.legacy.epochDistributor as Address,user,rows:Array.from({length:51},(_,i)=>row(input.token,epoch-BigInt(i)*604800n)),send,onConfirmed:confirmed})).rejects.toThrow('Second batch');expect(confirmed).toHaveBeenCalledTimes(1);expect(confirmed.mock.calls[0][0].hash).toBe(hash());
  });
  it('refuses an unknown preflight instead of silently dropping a reward',async()=>{
    const e=env(),send=vi.fn();vi.mocked(e.client.readContract).mockRejectedValue(Error('Read unavailable'));await expect(sendRewardClaims({client:e.client,distributor:registry.legacy.epochDistributor as Address,user,rows:[row()],send})).rejects.toThrow('Read unavailable');expect(send).not.toHaveBeenCalled();
  });
  it('reads the full registry in bounded batched views, preserving known principal',async()=>{
    const e=env(),addresses=Array.from({length:140},(_,i)=>('0x'+(i+10).toString(16).padStart(40,'0')) as Address),data=await readAccount(e.client,{...boot,rewardTokenAddresses:addresses},user);expect(data.rewardTokenCount).toBeGreaterThanOrEqual(140);expect(data.rewards.length).toBe(data.rewardTokenCount!*4);expect(vi.mocked(e.client.readContract).mock.calls.filter(([r])=>r.functionName==='previewClaimsForEpoch').length).toBeLessThan(16);expect(data.known.legacyStake).toBe(true);
  });
  it('serializes entire workflows across browser tabs',async()=>{env();vi.stubGlobal('navigator',{locks:{request:async(_k:any,_o:any,fn:any)=>fn(null)}});const work=vi.fn();await expect(walletWorkflow(user,work)).rejects.toThrow('Another tab');expect(work).not.toHaveBeenCalled();});
});
describe('sweep input and quote boundaries',()=>{
  it('supports zero-decimal tokens with integer-only input',()=>{expect(parseAmount('12',0)).toBe(12n);expect(()=>parseAmount('12.1',0)).toThrow();});
  it.each([registry.legacy.iAERO,registry.legacy.stiAERO,'0x0000000000000000000000000000000000000000'])('excludes principal, receipts and native gas %s',token=>expect(()=>validateSweepInputs(boot,[{...input,token:token as Address}],'USDC')).toThrow());
  it('refuses missing deployed routes and duplicate token inputs',()=>{expect(()=>validateSweepInputs({...boot,sweepReady:false},[input],'USDC')).toThrow('not been verified');expect(()=>validateSweepInputs(boot,[input,input],'USDC')).toThrow('more than once');expect(()=>validateSweepInputs({...boot,aeroCompoundReady:false},[input],'stake')).toThrow('not been verified');});
  it('binds a quote to its exact amount, token and swapper recipient',async()=>{
    const e=env();e.fetcher.mockResolvedValueOnce({ok:true,json:async()=>({sellToken:input.token,sellAmount:'1',buyToken:registry.legacy.USDC,buyAmount:'100',taker:registry.sweep.swapper,recipient:other,transaction:{to:router,data:'0x12345678',value:'0'}})} as any);await expect(fetchSweepQuote(e.client,boot,input,100)).rejects.toThrow('does not match');expect(e.sent).toHaveLength(0);
  });
  it('rejects unknown quote routers/selectors before approval',async()=>{const e=env(),original=vi.mocked(e.client.readContract).getMockImplementation()!;vi.mocked(e.client.readContract).mockImplementation(async(r:any)=>r.functionName==='allowedSelectors'?false:original(r));await expect(fetchSweepQuote(e.client,boot,input,100)).rejects.toThrow('does not permit');expect(e.sent).toHaveLength(0);});
  it('uses Metaquoter execution quotes and compounds the disclosed stage minimums',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100);expect(p.minimumOutput).toBe(99n*UNIT);expect(p.minimumIaero).toBe(98010000000000000000n);expect(vi.mocked(e.client.simulateContract).mock.calls.filter(([r])=>r.functionName==='quoteExactInput')).toHaveLength(2);expect(vi.mocked(e.client.readContract).mock.calls.some(([r])=>r.functionName==='getAmountOutWithTotalFee')).toBe(false);});
  it('never weakens the reviewed minimum when executable quotes are refreshed',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'USDC',100);expect(()=>swapStep({...p.quotes[0],buyAmount:1n},p.quotes[0],boot,100)).toThrow('beyond');});
  it('keeps the 2% conversion cost cap when a larger slippage setting is selected',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'iAERO',500);expect(p.minimumOutput).toBe(95n*UNIT);expect(p.minimumIaero).toBe(93100000000000000000n);});
  it('fails stale or tampered previews before any approval',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'USDC',100);await expect(runSweep(e.context,{...p,quotedAt:Date.now()-121000})).rejects.toThrow('quote changed');await expect(runSweep(e.context,{...p,existingOutput:1n})).rejects.toThrow('totals changed');expect(e.sent).toHaveLength(0);});
});
describe('sweep execution and ownership',()=>{
  it('limits approvals and pulls to the reviewed amount; ignores the rest of a large wallet',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'USDC',100),result=await runSweep(e.context,p);
    const approval=e.sent.find(w=>w.name==='approve')!,trade=e.sent.find(w=>w.name==='executePlanFromCallerAdvanced')!;
    expect(approval.args).toEqual([getAddress(registry.sweep.swapper),UNIT]);expect(trade.args[0][0].useAll).toBe(false);expect(trade.args[0][0].amountIn).toBe(UNIT);expect(trade.args[1].toLowerCase()).toBe(user);expect(trade.args[2]).toEqual({minTotalOut:99000000n,allowPartial:false});expect(result.outputAmount).toBe(100000000n);expect(e.sent.some(w=>w.name==='stake')).toBe(false);
  });
  it('stakes only receipt-derived new iAERO, leaving all existing liquid iAERO alone',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100),result=await runSweep(e.context,p),swap=e.sent.find(w=>w.name==='execute')!,[route]=decodeAbiParameters(ROUTE_PARAMS,swap.args[1][0]);
    const final=route;expect(swap.args[0]).toBe('0x00');expect(swap.args[1]).toHaveLength(1);expect(route.tokenIn.toLowerCase()).toBe(registry.aero.token.toLowerCase());expect(route.amountIn).toEqual({mode:0,value:100n*UNIT});expect(route.payerIsUser).toBe(true);expect(final.recipient.toLowerCase()).toBe(user);expect(final.minAmountOut>=p.minimumIaero!).toBe(true);expect(result.staked).toBe(100n*UNIT);expect(e.sent.find(w=>w.name==='stake')!.args[0]).toBe(100n*UNIT);expect(e.sent.filter(w=>w.name==='approve').at(-1)!.args).toEqual([registry.legacy.epochDistributor,100n*UNIT]);
  });
  it('allows liquid iAERO output without staking',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'iAERO',100),result=await runSweep(e.context,p);expect(result.iaero).toBe(100n*UNIT);expect(result.staked).toBe(0n);expect(e.sent.some(w=>w.name==='stake')).toBe(false);});
  it('leaves converted iAERO liquid when previous staking becomes paused',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100),original=vi.mocked(e.client.readContract).getMockImplementation()!;
    vi.mocked(e.client.readContract).mockImplementation(async(r:any)=>r.functionName==='paused'?true:original(r));expect((await runSweep(e.context,p)).stakingDeferred).toMatch(/staking is unavailable/);expect(e.sent.some(w=>w.name==='execute')).toBe(true);expect(e.sent.some(w=>w.name==='stake')).toBe(false);
  });
  it('does not stake when the exact conversion receipt lacks a verifiable iAERO transfer',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100),original=vi.mocked(e.client.getTransactionReceipt).getMockImplementation()!;
    vi.mocked(e.client.getTransactionReceipt).mockImplementation(async(r:any)=>{const receipt=await original(r);return e.sent.find(w=>w.hash===r.hash)?.name==='execute'?{...receipt,logs:[]}:receipt;});await expect(runSweep(e.context,p)).rejects.toThrow('could not be reconciled');expect(e.sent.some(w=>w.name==='stake')).toBe(false);
  });
  it('resets an insufficient nonzero allowance before approving the exact amount',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'USDC',100);e.allowances.set(input.token.toLowerCase()+':'+registry.sweep.swapper.toLowerCase(),1n);await runSweep(e.context,p);expect(e.sent.filter(w=>w.name==='approve').map(w=>w.args[1])).toEqual([0n,UNIT]);
  });
  it('uses existing AERO only when it is explicitly selected',async()=>{const e=env(),aero:SweepInput={token:registry.aero.token as Address,symbol:'AERO',decimals:18,amount:20n*UNIT},p=await buildSweepPreview(e.client,boot,user,[aero],'iAERO',100),result=await runSweep(e.context,p);expect(e.fetcher).not.toHaveBeenCalled();expect(e.sent.find(w=>w.name==='approve')!.args).toEqual([registry.sweep.metarouter,20n*UNIT]);expect(result.iaero).toBe(20n*UNIT);});
  it('retains confirmed step hashes if later receipt reads fail, and never guesses the output',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100);e.setReceiptFailure();await expect(runSweep(e.context,p)).rejects.toThrow('Post-confirmation');expect(e.confirmed).toHaveBeenCalledTimes(2);expect(e.broadcast).toHaveBeenCalledTimes(2);expect(e.sent.some(w=>w.name==='execute'||w.name==='stake')).toBe(false);
  });
  it('rejects output logs from another emitter and stops before conversion',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100);e.setCorruptLogs();await expect(runSweep(e.context,p)).rejects.toThrow('could not be reconciled');expect(e.sent.some(w=>w.name==='execute')).toBe(false);
  });
  it('keeps AERO liquid when the CL market leg moves outside the reviewed floor',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100);e.setMarketCollapse();const result=await runSweep(e.context,p);expect(result.conversionDeferred).toMatch(/2%/);expect(result.outputAmount).toBe(100n*UNIT);expect(e.sent.some(w=>w.name==='execute'||w.name==='stake')).toBe(false);});
  it('rechecks the cap after a slow approval and defers without converting or staking if the market moved',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100),original=vi.mocked(e.client.simulateContract).getMockImplementation()!;let refreshed=0;vi.mocked(e.client.simulateContract).mockImplementation(async(r:any)=>r.functionName==='quoteExactInput'&&++refreshed>=2?{request:r,result:[1n,[],[]]} as any:original(r));const result=await runSweep(e.context,p);expect(result.conversionDeferred).toMatch(/2%/);expect(result.outputAmount).toBe(100n*UNIT);expect(e.sent.some(w=>w.name==='approve'&&w.to.toLowerCase()===registry.aero.token.toLowerCase()&&w.args[0].toLowerCase()===registry.sweep.metarouter.toLowerCase())).toBe(true);expect(e.sent.some(w=>w.name==='execute'||w.name==='stake')).toBe(false);});
  it('stops before the next transaction on an operator stop request',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'USDC',100);let stopped=false;await expect(runSweep(e.context,p,{onConfirmed:()=>{stopped=true;},shouldStop:()=>stopped})).rejects.toThrow('Stopped');expect(e.sent).toHaveLength(1);expect(e.sent[0].name).toBe('approve');});
  it('blocks an account change during approval simulation',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'USDC',100);vi.mocked(e.client.simulateContract).mockImplementation(async(r:any)=>{e.setAccount(other);return {request:r} as any;});await expect(runSweep(e.context,p)).rejects.toThrow('changed');expect(e.sent).toHaveLength(0);});
});

describe('independent swap checks and spam filtering',()=>{
  const rndr:SweepInput={token:'0x1234567000000000000000000000000000000002' as Address,symbol:'(RNDR)',decimals:18,amount:UNIT};
  it('keeps checking after an RNDR quote failure and includes only the passing token',async()=>{
    const e=env(),original=e.fetcher.getMockImplementation()!;
    e.fetcher.mockImplementation(async(url:any)=>new URL(String(url),'http://localhost').searchParams.get('sellToken')===rndr.token?{ok:false}:original(url));
    const progress=vi.fn(),p=await buildSweepPreview(e.client,boot,user,[rndr,input],'USDC',100,fetch,progress);
    expect(p.inputs).toEqual([input]);expect(p.quotes).toHaveLength(1);expect(p.skipped[0]).toMatchObject({input:rndr,stage:'quote'});expect(p.minimumOutput).toBe(99000000n);expect(progress).toHaveBeenLastCalledWith(2,2);expect(e.sent).toHaveLength(0);
  });
  it('excludes a reverting swap while retaining a separately simulated valid swap',async()=>{
    const e=env();e.simulationFailures.add(rndr.token.toLowerCase());
    const p=await buildSweepPreview(e.client,boot,user,[rndr,input],'USDC',100);
    expect(p.inputs).toEqual([input]);expect(p.skipped[0].stage).toBe('simulation');expect(e.client.simulateBlocks).toHaveBeenCalledTimes(3);expect(e.sent).toHaveLength(0);expect(e.allowances.size).toBe(0);
  });
  it('simulates an insufficient allowance reset, exact approval and exact swap without changing actual allowances',async()=>{
    const e=env();e.allowances.set(input.token.toLowerCase()+':'+registry.sweep.swapper.toLowerCase(),1n);
    await buildSweepPreview(e.client,boot,user,[input],'USDC',100);
    const parameters=vi.mocked(e.client.simulateBlocks).mock.calls[0][0],block=parameters.blocks[0];
    expect(parameters.validation).toBe(false);expect(block.stateOverrides).toBeUndefined();expect(block.blockOverrides).toBeUndefined();
    const calls=block.calls as any[];expect(calls).toHaveLength(3);expect(calls.every(c=>c.account===user)).toBe(true);
    expect(calls.slice(0,2).map(c=>decodeFunctionData({abi:STAKING_ERC20_ABI,data:c.data}).args![1])).toEqual([0n,UNIT]);
    const swap=decodeFunctionData({abi:SWEEP_ABI,data:calls[2].data});if(swap.functionName!=='executePlanFromCallerAdvanced')throw Error('Wrong simulated function.');expect(swap.args[1].toLowerCase()).toBe(user);expect(swap.args[0][0].useAll).toBe(false);expect(swap.args[0][0].amountIn).toBe(UNIT);expect(swap.args[2].allowPartial).toBe(false);
    expect(e.sent).toHaveLength(0);expect([...e.allowances.values()]).toEqual([1n]);
  });
  it('shows all failed requests as skipped without allowing a zero-token executable plan',async()=>{
    const e=env();e.fetcher.mockResolvedValue({ok:false} as any);
    const p=await buildSweepPreview(e.client,boot,user,[rndr,input],'USDC',100);
    expect(p.inputs).toHaveLength(0);expect(p.quotes).toHaveLength(0);expect(p.skipped).toHaveLength(2);expect(p.minimumOutput).toBe(0n);
    await expect(runSweep(e.context,p)).rejects.toThrow('Choose between');expect(e.sent).toHaveLength(0);
  });
  it('does not enable a token when the simulation provider is unavailable',async()=>{
    const e=env();vi.mocked(e.client.simulateBlocks).mockRejectedValue(Error('Method unavailable'));
    await expect(buildSweepPreview(e.client,boot,user,[rndr,input],'USDC',100)).rejects.toThrow('Grouped token checks');expect(e.client.simulateBlocks).toHaveBeenCalledTimes(1);expect(e.sent).toHaveLength(0);
  });
  it('rejects a false approval result and missing or foreign simulated output events',async()=>{
    const e=env(),original=vi.mocked(e.client.simulateBlocks).getMockImplementation()!;
    vi.mocked(e.client.simulateBlocks).mockImplementation(async(p:any)=>{const result=await original(p);(result[0].calls[0] as any).data=encodeFunctionResult({abi:STAKING_ERC20_ABI,functionName:'approve',result:false});return result;});
    expect((await buildSweepPreview(e.client,boot,user,[input],'USDC',100)).inputs).toHaveLength(0);
    vi.mocked(e.client.simulateBlocks).mockImplementation(async(p:any)=>{const result=await original(p);(result[0].calls.at(-1) as any).logs[0].address=other;return result;});
    await expect(buildSweepPreview(e.client,boot,user,[input],'USDC',100)).rejects.toThrow('Grouped token checks');expect(e.sent).toHaveLength(0);
  });
  it('hides listed addresses even when they impersonate WETH, while legitimate unpriced tokens remain distinct',()=>{
    const policy=boot.tokenFilter!,blocked=policy.addresses.find(a=>BigInt(a)>0n)!;
    expect(spamReason(policy,blocked,'WETH')).toMatch(/spam filter/);expect(spamReason(policy,rndr.token,'(RNDR)')).toBeUndefined();expect(spamReason(policy,input.token,'WETH')).toBeUndefined();
    expect(spamReason(policy,rndr.token,'Bonus t.me/claim')).toMatch(/symbol/);
  });
  it('uses literal symbol matching rather than executing remote regular expressions',()=>{
    const policy={...boot.tokenFilter!,addresses:[],symbolPatterns:['a.b','(a+)+$']} as TokenFilter;
    expect(spamReason(policy,other,'axb')).toBeUndefined();expect(spamReason(policy,other,'A.B')).toMatch(/symbol/);
  });
  it('filters known spam before quotes or approval simulation and rejects a forged executable selection',async()=>{
    const e=env(),spam={...input,token:boot.tokenFilter!.addresses.find(a=>BigInt(a)>0n)!};
    const p=await buildSweepPreview(e.client,boot,user,[spam,input],'USDC',100);expect(p.inputs).toEqual([input]);expect(p.skipped[0].stage).toBe('filter');expect(e.fetcher).toHaveBeenCalledTimes(1);expect(e.client.simulateBlocks).toHaveBeenCalledTimes(1);
    await expect(runSweep(e.context,{...p,inputs:[spam]})).rejects.toThrow('filtered token');expect(e.sent).toHaveLength(0);
  });
  it('requires the token policy before any preview or approval',async()=>{
    const e=env();await expect(buildSweepPreview(e.client,{...boot,tokenFilter:undefined},user,[input],'USDC',100)).rejects.toThrow('filter is unavailable');expect(e.fetcher).not.toHaveBeenCalled();expect(e.sent).toHaveLength(0);
  });
  it('skips a token that loses its quote after review and still swaps the valid token without approving the skipped one',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[rndr,input],'USDC',100),original=e.fetcher.getMockImplementation()!;
    e.fetcher.mockImplementation(async(url:any)=>new URL(String(url),'http://localhost').searchParams.get('sellToken')===rndr.token?{ok:false}:original(url));
    const result=await runSweep(e.context,p);expect(result.swapped).toBe(1);expect(result.skipped).toHaveLength(1);expect(result.outputAmount).toBe(100000000n);expect(e.sent.some(t=>t.to.toLowerCase()===rndr.token.toLowerCase())).toBe(false);
  });
  it('skips a newly reverting simulation without approving it and continues with the next token',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[rndr,input],'USDC',100);e.simulationFailures.add(rndr.token.toLowerCase());
    const result=await runSweep(e.context,p);expect(result.swapped).toBe(1);expect(result.skipped[0].stage).toBe('simulation');expect(e.sent.some(t=>t.to.toLowerCase()===rndr.token.toLowerCase())).toBe(false);
  });
  it.each(['quote','simulation'] as const)('skips a %s that fails after an exact approval and continues without trading that token',async stage=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[rndr,input],'USDC',100),original=e.fetcher.getMockImplementation()!;
    const result=await runSweep(e.context,p,{onConfirmed:activity=>{
      if(activity.title==='Approve exact (RNDR) amount'){
        if(stage==='quote')e.fetcher.mockImplementation(async(url:any)=>new URL(String(url),'http://localhost').searchParams.get('sellToken')===rndr.token?{ok:false}:original(url));
        else e.simulationFailures.add(rndr.token.toLowerCase());
      }
    }});
    expect(result.swapped).toBe(1);expect(result.skipped[0].stage).toBe(stage);
    expect(e.sent.some(t=>t.name==='approve'&&t.to.toLowerCase()===rndr.token.toLowerCase())).toBe(true);
    expect(e.sent.filter(t=>t.name==='executePlanFromCallerAdvanced').map(t=>t.args[0][0].tokenIn.toLowerCase())).toEqual([input.token.toLowerCase()]);
  });
  it('stops on a wallet rejection rather than continuing to request approvals for other tokens',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[rndr,input],'USDC',100),original=vi.mocked(e.provider.request).getMockImplementation()! as (request:any)=>Promise<any>;
    vi.mocked(e.provider.request).mockImplementation(async(r:any)=>{if(r.method==='eth_sendTransaction')throw Object.assign(Error('Declined by wallet'),{code:4001});return original(r);});
    await expect(runSweep(e.context,p)).rejects.toThrow('Declined');expect(e.sent).toHaveLength(0);
  });
  it('groups successful tokens into one strict batch transaction',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[rndr,input],'USDC',100),result=await runSweep(e.context,p),trades=e.sent.filter(t=>t.name==='executePlanFromCallerAdvanced');
    expect(result.swapped).toBe(2);expect(result.batches).toBe(1);expect(result.outputAmount).toBe(200000000n);expect(trades).toHaveLength(1);expect(trades[0].args[0]).toHaveLength(2);expect(trades[0].args[2]).toEqual({allowPartial:false,minTotalOut:198000000n});expect(BigInt(trades[0].gas!)).toBe(780000n);
  });
  it('leaves a smaller AERO subset liquid rather than weakening the reviewed conversion or staking floor',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,[rndr,input],'stake',100);e.simulationFailures.add(rndr.token.toLowerCase());
    const result=await runSweep(e.context,p);expect(result.swapped).toBe(1);expect(result.outputAmount).toBe(100n*UNIT);expect(result.conversionDeferred).toMatch(/fresh conversion/);expect(result.staked).toBe(0n);expect(e.sent.some(t=>t.name==='execute'||t.name==='stake')).toBe(false);expect(p.minimumOutput).toBe(198n*UNIT);
  });
});

describe('adaptive swap batches',()=>{
  const inputs=(count:number):SweepInput[]=>Array.from({length:count},(_,i)=>({...input,token:('0x'+(0x1234567000000000000000000000000000000000n+BigInt(i)).toString(16)) as Address,symbol:'TOKEN'+i}));
  it('sends twelve passing swaps as batches of ten and two, with exact approvals and no duplicate inputs',async()=>{
    const e=env(),rows=inputs(12),p=await buildSweepPreview(e.client,boot,user,rows,'USDC',100),result=await runSweep(e.context,p),trades=e.sent.filter(t=>t.name==='executePlanFromCallerAdvanced');
    expect(SWEEP_BATCH_LIMIT).toBe(10);expect(trades.map(t=>t.args[0].length)).toEqual([10,2]);expect(result.batches).toBe(2);expect(result.swapped).toBe(12);expect(result.outputAmount).toBe(1200000000n);
    expect(new Set(trades.flatMap(t=>t.args[0].map((q:any)=>q.tokenIn.toLowerCase()))).size).toBe(12);
    expect(trades.every(t=>BigInt(t.gas!)<=SWEEP_GAS_LIMIT&&t.args[2].allowPartial===false&&t.args[0].every((q:any)=>q.amountIn===UNIT&&!q.useAll))).toBe(true);
    expect(e.sent.filter(t=>t.name==='approve').every(t=>t.args[1]===UNIT&&t.gas===undefined)).toBe(true);
  });
  it.each(['combined simulation','gas budget'])('splits a failing %s into two validated batches without weakening minimums',async reason=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,inputs(4),'USDC',100);
    if(reason==='gas budget')vi.mocked(e.client.estimateContractGas).mockImplementation(async(r:any)=>r.args[0].length>2?13000000n:600000n);
    else{
      const original=vi.mocked(e.client.simulateBlocks).getMockImplementation()!;
      vi.mocked(e.client.simulateBlocks).mockImplementation(async(r:any)=>{
        const result=await original(r),last=r.blocks[0].calls.at(-1),decoded=decodeFunctionData({abi:SWEEP_ABI,data:last.data});
        if(decoded.functionName==='executePlanFromCallerAdvanced'&&decoded.args[0].length>2)(result[0].calls.at(-1) as any).status='failure';return result;
      });
    }
    const result=await runSweep(e.context,p),trades=e.sent.filter(t=>t.name==='executePlanFromCallerAdvanced');
    expect(trades.map(t=>t.args[0].length)).toEqual([2,2]);expect(trades.every(t=>t.args[2].minTotalOut===198000000n)).toBe(true);expect(result.swapped).toBe(4);expect(result.skipped).toHaveLength(0);expect(result.batches).toBe(2);
  });
  it('isolates an individual gas-check failure and still sends the valid subset',async()=>{
    const e=env(),rows=inputs(2),p=await buildSweepPreview(e.client,boot,user,rows,'USDC',100);
    vi.mocked(e.client.estimateContractGas).mockImplementation(async(r:any)=>{if(r.args[0].some((q:any)=>q.tokenIn.toLowerCase()===rows[0].token.toLowerCase()))throw new SweepPreflightRevert('Token gas simulation reverted');return 300000n;});
    const result=await runSweep(e.context,p),trades=e.sent.filter(t=>t.name==='executePlanFromCallerAdvanced');
    expect(result.skipped[0]).toMatchObject({input:rows[0],stage:'batch'});expect(result.swapped).toBe(1);expect(trades).toHaveLength(1);expect(trades[0].args[0][0].tokenIn.toLowerCase()).toBe(rows[1].token.toLowerCase());
  });
  it('requires a successful gas estimate and sends no swaps when estimation is unavailable',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,inputs(2),'USDC',100);vi.mocked(e.client.estimateContractGas).mockRejectedValue(Error('RPC unavailable'));
    await expect(runSweep(e.context,p)).rejects.toThrow('RPC unavailable');expect(e.client.estimateContractGas).toHaveBeenCalledTimes(1);expect(e.sent.some(t=>t.name==='executePlanFromCallerAdvanced')).toBe(false);
  });
  it('does not split or replay a batch after confirmation when its receipt cannot be reconciled',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,inputs(2),'USDC',100);e.setCorruptLogs();
    await expect(runSweep(e.context,p)).rejects.toThrow('reconciled');expect(e.sent.filter(t=>t.name==='executePlanFromCallerAdvanced')).toHaveLength(1);expect(e.client.estimateContractGas).toHaveBeenCalledTimes(1);expect(e.confirmed).toHaveBeenCalledTimes(3);
  });
  it('stops before approving the next group when the user stops after a confirmed batch',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,inputs(12),'USDC',100);let stopped=false;
    await expect(runSweep(e.context,p,{onConfirmed:a=>{if(a.title.startsWith('Sweep batch'))stopped=true;},shouldStop:()=>stopped})).rejects.toThrow('Stopped');
    expect(e.sent.filter(t=>t.name==='executePlanFromCallerAdvanced')).toHaveLength(1);expect(e.sent.filter(t=>t.name==='approve')).toHaveLength(10);
  });
  it('rechecks wallet identity after gas estimation before submitting a batch',async()=>{
    const e=env(),p=await buildSweepPreview(e.client,boot,user,inputs(2),'USDC',100);vi.mocked(e.client.estimateContractGas).mockImplementation(async()=>{e.setAccount(other);return 600000n;});
    await expect(runSweep(e.context,p)).rejects.toThrow('changed');expect(e.sent.some(t=>t.name==='executePlanFromCallerAdvanced')).toBe(false);
  });
});

describe('reviewed automatic gas and slippage retries',()=>{
 const preview=(e:ReturnType<typeof env>,mode:'USDC'|'iAERO'|'stake'='USDC',rows=[input],bps=100)=>buildSweepPreview(e.client,boot,user,rows,mode,bps,e.fetcher as typeof fetch,undefined,true);
 const trades=(e:ReturnType<typeof env>,name='executePlanFromCallerAdvanced')=>e.sent.filter(t=>t.name===name);
 it('reviews a bounded slippage schedule and anchors all retry minima to the quoted output',async()=>{const e=env(),p=await preview(e);expect(p.retry).toMatchObject({maxRetries:2,maxSlippageBps:225,minimumOutputByAttempt:[99000000n,98500000n,97750000n]});expect([0,1,2].map(n=>retrySlippage(500,n))).toEqual([500,750,1000]);expect(retryGas(300000n,0)).toBe(390000n);expect(retryGas(300000n,1,390000n)).toBe(585000n);expect(retryGas(10000000n,2)).toBe(SWEEP_GAS_LIMIT);});
 it('retries an exact reverted receipt with fresh quotes, 50% more gas and 1.5x slippage',async()=>{const e=env(),p=await preview(e),events=vi.fn();e.failNext.set('executePlanFromCallerAdvanced',1);const result=await runSweep(e.context,p,{onRetry:events}),tx=trades(e);expect(tx).toHaveLength(2);expect(tx.map(t=>BigInt(t.gas!))).toEqual([390000n,585000n]);expect(tx.map(t=>t.args[0][0].slippageBps)).toEqual([100,150]);expect(tx.map(t=>t.args[2].minTotalOut)).toEqual([99000000n,98500000n]);expect(result.outputAmount).toBe(100000000n);expect(result.swapped).toBe(1);expect(result.hashes).not.toContain(tx[0].hash);expect(events.mock.calls[0][0]).toMatchObject({attempt:1,slippageBps:150,hash:tx[0].hash});expect(e.fetcher.mock.calls.some(([url])=>new URL(String(url),'http://localhost').searchParams.get('slippageBps')==='150')).toBe(true);});
 it('stops after two retries and retains all three failed receipt links',async()=>{const e=env(),p=await preview(e),events=vi.fn();e.failNext.set('executePlanFromCallerAdvanced',100);const r=await runSweep(e.context,p,{onRetry:events});expect(trades(e)).toHaveLength(3);expect(trades(e).map(t=>BigInt(t.gas!))).toEqual([390000n,585000n,877500n]);expect(r.swapped).toBe(0);expect(r.skipped[0].reason).toContain('Retry limit');expect(events.mock.calls.map(([event])=>event.hash)).toEqual(trades(e).map(t=>t.hash));expect(events.mock.calls.at(-1)![0].exhausted).toBe(true);});
 it('falls back to individual tokens for the last retry without replaying a successful token',async()=>{const e=env(),second={...input,token:'0x1234567000000000000000000000000000000001' as Address,symbol:'OTHER'},p=await preview(e,'USDC',[input,second]);e.failNext.set('executePlanFromCallerAdvanced',2);const r=await runSweep(e.context,p);expect(trades(e).map(t=>t.args[0].length)).toEqual([2,2,1,1]);expect(r.swapped).toBe(2);expect(r.outputAmount).toBe(200000000n);expect(r.batches).toBe(2);expect(r.skipped).toEqual([]);});
 it.each(['timeout','replaced','mismatch'])('does not retry a %s or uncertain transaction',async mode=>{const e=env(),p=await preview(e);e.setReceiptMode(mode);await expect(runSweep(e.context,p)).rejects.toThrow();expect(trades(e)).toHaveLength(1);expect(pendingTransaction(8453,user)).not.toBeNull();});
 it.each(['wrong sender','wrong target','wrong hash','success'])('refuses to retry when the independent failed-receipt read has %s',async mode=>{const e=env(),p=await preview(e);e.failNext.set('executePlanFromCallerAdvanced',1);const original=vi.mocked(e.client.getTransactionReceipt).getMockImplementation()!;vi.mocked(e.client.getTransactionReceipt).mockImplementation(async request=>{const r=await original(request);return {...r,...(mode==='wrong sender'?{from:other}:mode==='wrong target'?{to:other}:mode==='wrong hash'?{transactionHash:hash(999)}:{status:'success'})};});await expect(runSweep(e.context,p)).rejects.toThrow('Transaction reverted');expect(trades(e)).toHaveLength(1);});
 it('stops on a wallet decline instead of retrying or changing allowances again',async()=>{const e=env(),p=await preview(e),original=vi.mocked(e.provider.request).getMockImplementation()! as any;vi.mocked(e.provider.request).mockImplementation(async(r:any)=>{if(r.method==='eth_sendTransaction'&&decodeFunctionData({abi:combined,data:r.params[0].data}).functionName==='executePlanFromCallerAdvanced')throw Object.assign(Error('User rejected'),{code:4001});return original(r);});await expect(runSweep(e.context,p)).rejects.toThrow('User rejected');expect(trades(e)).toHaveLength(0);expect(e.sent.filter(t=>t.name==='approve')).toHaveLength(1);expect(pendingTransaction(8453,user)).toBeNull();});
 it('stops if the user stops after a confirmed failed attempt',async()=>{const e=env(),p=await preview(e);e.failNext.set('executePlanFromCallerAdvanced',1);let stopped=false;await expect(runSweep(e.context,p,{onRetry:()=>{stopped=true;},shouldStop:()=>stopped})).rejects.toThrow('Stopped');expect(trades(e)).toHaveLength(1);});
 it('does not replay a successful trade if its output logs cannot be reconciled',async()=>{const e=env(),p=await preview(e);e.setCorruptLogs();await expect(runSweep(e.context,p)).rejects.toThrow('reconciled');expect(trades(e)).toHaveLength(1);});
 it('never replays success when a confirmation callback throws a preflight-shaped error',async()=>{const e=env(),p=await preview(e);await expect(runSweep(e.context,p,{onConfirmed:activity=>{if(activity.title.startsWith('Sweep batch'))throw new SweepPreflightRevert('Callback failure');}})).rejects.toThrow('Callback failure');expect(trades(e)).toHaveLength(1);});
 it('refuses forged retry limits before any wallet request',async()=>{const e=env(),p=await preview(e);p.retry!.maxSlippageBps=10000;await expect(runSweep(e.context,p)).rejects.toThrow('limits changed');expect(e.sent).toHaveLength(0);});
 it('refuses a forged minimum below the explicitly approved slippage floor',async()=>{const e=env(),p=await preview(e);p.retry!.minimumOutputByAttempt[2]=1n;await expect(runSweep(e.context,p)).rejects.toThrow('limits changed');expect(e.sent).toHaveLength(0);});
 it('uses bounded retries during read-only preview simulation without making an approval',async()=>{const e=env(),original=vi.mocked(e.client.simulateBlocks).getMockImplementation()!;vi.mocked(e.client.simulateBlocks).mockImplementation(async request=>{const result=await original(request),data=(request.blocks![0] as any).calls.at(-1).data,step=(decodeFunctionData({abi:SWEEP_ABI,data}).args![0] as any)[0];if(step.slippageBps<150)(result[0].calls.at(-1) as any).status='failure';return result;});const p=await preview(e);expect(p.quotes[0].retryLevel).toBe(1);expect(p.minimumOutput).toBe(98500000n);expect(e.sent).toHaveLength(0);expect(e.allowances.size).toBe(0);const r=await runSweep(e.context,p);expect(r.swapped).toBe(1);expect(trades(e)[0].args[0][0].slippageBps).toBe(150);});
 it('boosts an unsent execution simulation revert without confusing it with a failed broadcast',async()=>{const e=env(),p=await preview(e),original=vi.mocked(e.client.simulateContract).getMockImplementation()!;let first=true;vi.mocked(e.client.simulateContract).mockImplementation(async(request:any)=>{if(request.functionName==='executePlanFromCallerAdvanced'&&first){first=false;throw new ContractFunctionRevertedError({abi:SWEEP_ABI,functionName:'executePlanFromCallerAdvanced',data:'0x'});}return original(request);});const r=await runSweep(e.context,p);expect(trades(e)).toHaveLength(1);expect(trades(e)[0].args[0][0].slippageBps).toBe(150);expect(r.swapped).toBe(1);});
 it('does not turn an execution simulation RPC outage into a gas retry',async()=>{const e=env(),p=await preview(e),original=vi.mocked(e.client.simulateContract).getMockImplementation()!;let calls=0;vi.mocked(e.client.simulateContract).mockImplementation(async(request:any)=>{if(request.functionName==='executePlanFromCallerAdvanced'){calls++;throw Error('RPC HTTP 401');}return original(request);});await expect(runSweep(e.context,p)).rejects.toThrow('HTTP 401');expect(trades(e)).toHaveLength(0);expect(calls).toBe(1);expect(pendingTransaction(8453,user)).toBeNull();});
 it('never retries quote authentication or HTTP outages as a slippage problem',async()=>{const e=env();e.fetcher.mockResolvedValue({ok:false,status:503,json:async()=>({code:'QUOTE_AUTHENTICATION'})});const p=await preview(e);expect(p.inputs).toHaveLength(0);expect(p.skipped[0].reason).toContain('authentication');expect(e.fetcher).toHaveBeenCalledTimes(1);expect(e.sent).toHaveLength(0);});
 it('retries a confirmed failed conversion with a fresh protected route and stakes only its new output',async()=>{const e=env(),p=await preview(e,'stake');e.failNext.set('execute',1);const r=await runSweep(e.context,p);expect(trades(e)).toHaveLength(1);expect(trades(e,'execute')).toHaveLength(2);expect(BigInt(trades(e,'execute')[1].gas!)).toBeGreaterThan(BigInt(trades(e,'execute')[0].gas!));expect(r.iaero).toBe(100n*UNIT);expect(r.staked).toBe(100n*UNIT);expect(trades(e,'stake')[0].args).toEqual([100n*UNIT]);});
 it('leaves AERO liquid when all conversion retries have confirmed failed receipts',async()=>{const e=env(),p=await preview(e,'stake');e.failNext.set('execute',100);const r=await runSweep(e.context,p);expect(trades(e,'execute')).toHaveLength(3);expect(trades(e,'stake')).toHaveLength(0);expect(r.conversionDeferred).toContain('retry limit');expect(r.iaero).toBe(0n);expect(r.outputAmount).toBe(100n*UNIT);});
 it('retries a confirmed reverted stake with gas only and the same exact receipt-derived amount',async()=>{const e=env(),p=await preview(e,'stake');e.failNext.set('stake',1);const r=await runSweep(e.context,p);expect(trades(e,'execute')).toHaveLength(1);expect(trades(e,'stake')).toHaveLength(2);expect(trades(e,'stake').every(t=>t.args[0]===100n*UNIT)).toBe(true);expect(r.staked).toBe(100n*UNIT);});
 it('leaves iAERO liquid after the final staking failure',async()=>{const e=env(),p=await preview(e,'stake');e.failNext.set('stake',100);const r=await runSweep(e.context,p);expect(trades(e,'stake')).toHaveLength(3);expect(trades(e,'execute')).toHaveLength(1);expect(r.stakingDeferred).toContain('retry limit');expect(r.iaero).toBe(100n*UNIT);expect(r.staked).toBe(0n);});
 it('preserves the 2% conversion-cost cap when retry slippage reaches 10%',async()=>{const e=env(),p=await preview(e,'stake',[input],500);expect(p.retry!.maxSlippageBps).toBe(1000);e.setMarketCollapse();const r=await runSweep(e.context,p);expect(r.conversionDeferred).toContain('2%');expect(trades(e,'execute')).toHaveLength(0);expect(trades(e,'stake')).toHaveLength(0);});
});

describe('direct new AERO compounding',()=>{
 it('quotes every reward directly into new AERO and never approves USDC',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100),r=await runSweep(e.context,p);expect(p.outToken).toBe(registry.aero.token);expect(p.minimumOutput).toBe(99n*UNIT);expect(e.fetcher.mock.calls.every(([u])=>new URL(String(u),'http://localhost').searchParams.get('buyToken')===registry.aero.token)).toBe(true);const swap=e.sent.find(t=>t.name==='executePlanFromCallerAdvanced')!;expect(swap.args[0].every((step:any)=>step.outToken.toLowerCase()===registry.aero.token.toLowerCase())).toBe(true);expect(e.sent.some(t=>t.to.toLowerCase()===registry.legacy.USDC.toLowerCase())).toBe(false);expect(r.staked).toBe(100n*UNIT);expect(e.sent.find(t=>t.name==='approve'&&t.to.toLowerCase()===registry.aero.token.toLowerCase())!.args).toEqual([registry.sweep.metarouter,100n*UNIT]);});
 it('converts selected wallet USDC through the swapper into AERO',async()=>{const e=env(),usdc:SweepInput={token:registry.legacy.USDC as Address,symbol:'USDC',decimals:6,amount:20000000n},p=await buildSweepPreview(e.client,boot,user,[usdc],'iAERO',100);expect(p.existingOutput).toBe(0n);expect(p.quotes).toHaveLength(1);await runSweep(e.context,p);const trade=e.sent.find(t=>t.name==='executePlanFromCallerAdvanced')!;expect(trade.args[0][0].tokenIn.toLowerCase()).toBe(registry.legacy.USDC.toLowerCase());expect(trade.args[0][0].outToken.toLowerCase()).toBe(registry.aero.token.toLowerCase());expect(trade.args[0][0].amountIn).toBe(20000000n);expect(e.sent.find(t=>t.name==='approve'&&t.to.toLowerCase()===registry.legacy.USDC.toLowerCase())!.args).toEqual([getAddress(registry.sweep.swapper),20000000n]);});
 it('rejects a forged preview output before requesting a signature',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100);await expect(runSweep(e.context,{...p,outToken:registry.legacy.USDC as Address})).rejects.toThrow('output token changed');expect(e.sent).toHaveLength(0);});
 it('rejects mixed review output currencies before any approval',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100);p.quotes[0].outToken=registry.legacy.USDC as Address;await expect(runSweep(e.context,p)).rejects.toThrow('reviewed selection');expect(e.sent).toHaveLength(0);});
 it('does not reconcile a USDC receipt as an AERO compound output',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100),q=p.quotes[0],log={address:registry.sweep.swapper,topics:encodeEventTopics({abi:SWEEP_ABI,eventName:'SwapExecuted',args:{tokenIn:input.token,outToken:registry.legacy.USDC as Address}}),data:encodeAbiParameters([{type:'uint8'},{type:'uint256'},{type:'uint256'}],[2,input.amount,100n*UNIT])};expect(()=>receiptOutput([log],boot,[q])).toThrow('reconciled');});
 it('rejects a fresh USDC quote where AERO was requested',async()=>{const e=env();e.fetcher.mockImplementation(async()=>({ok:true,json:async()=>({sellToken:input.token,sellAmount:input.amount.toString(),buyToken:registry.legacy.USDC,buyAmount:(100n*UNIT).toString(),taker:registry.sweep.swapper,recipient:registry.sweep.swapper,transaction:{to:router,data:'0x12345678',value:'0'},quotedAt:Date.now()})}) as any);const p=await buildSweepPreview(e.client,boot,user,[input],'stake',100);expect(p.inputs).toEqual([]);expect(p.skipped[0].reason).toContain('does not match');expect(e.sent).toHaveLength(0);});
 it('retains AERO units across reviewed gas/slippage retries',async()=>{const e=env(),p=await buildSweepPreview(e.client,boot,user,[input],'stake',100,fetch,undefined,true);expect(p.retry!.minimumOutputByAttempt).toEqual([99n*UNIT,985n*UNIT/10n,9775n*UNIT/100n]);e.failNext.set('executePlanFromCallerAdvanced',1);const r=await runSweep(e.context,p);const swaps=e.sent.filter(t=>t.name==='executePlanFromCallerAdvanced');expect(swaps.map(t=>t.args[0][0].outToken.toLowerCase())).toEqual([registry.aero.token.toLowerCase(),registry.aero.token.toLowerCase()]);expect(swaps.map(t=>t.args[2].minTotalOut)).toEqual([99n*UNIT,985n*UNIT/10n]);expect(r.staked).toBe(100n*UNIT);});
});
