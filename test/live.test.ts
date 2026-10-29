import {afterEach,describe,expect,it,vi} from 'vitest';
import {decodeFunctionData,parseAbi,type Address,type EIP1193Provider} from 'viem';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import registry from '../config/base.registry.json';
import {canonicalReadRequest} from '../server/base-rpc';
import {createGuardedSender,executeLiveAction,legacyConfig,readAccount,fetchBootstrap,publicError,publicBaseClient,type BaseClient} from '../src/live/client';
import {WALLET_READ_TIMEOUT_MS,type TransactionStage} from '../src/live/transaction-stages';
import {initialLiveState,liveReason,type Bootstrap,type LiveState} from '../src/live/types';
import {pendingTransaction} from '../src/protocol/pendingTransaction';
import {UNIT,type Action} from '../src/domain';

const user='0x1111111111111111111111111111111111111111' as Address,other='0x2222222222222222222222222222222222222222' as Address;
const hash=('0x'+'ab'.repeat(32)) as `0x${string}`,epoch=1792627200n;
const boot={registry,verifiedAt:new Date().toISOString(),snapshot:{block:'123',hash,timestamp:1792952223,independentProviders:2},contracts:{},legacyReady:true,legacyPaused:false,oldAutoReady:true,newStackReady:false,newStackReason:'New contracts not deployed.',metrics:{backingAero:'1',permanent:true,protocolNftOwner:user,legacyTotalStaked:'1'}} as unknown as Bootstrap;
const state=():LiveState=>({...initialLiveState(),boot,address:user,chainId:8453,known:{legacyStake:true},legacyReceipts:20n*UNIT,legacyPaused:false});
const action=(kind:Action['kind'],amount=10n*UNIT):Action=>({kind,amount,title:'Reviewed action',description:'',source:'Legacy',target:'Connected wallet',approval:false});
function setup(){
  const storage=new Map<string,string>(),events=new EventTarget();
  vi.stubGlobal('window',{localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},dispatchEvent:(e:Event)=>events.dispatchEvent(e)});
  vi.stubGlobal('navigator',{locks:{request:async(_name:string,_options:unknown,fn:(lock:{name:string})=>unknown)=>fn({name:'test-lock'})}});
  let account:Address=user,chain='0x2105';
  const request=vi.fn(async({method}:any):Promise<any>=>{
    if(method==='eth_accounts')return [account];if(method==='eth_chainId')return chain;if(method==='eth_sendTransaction')return hash;throw Error('Unexpected wallet method '+method);
  });
  const provider={request,on:()=>{},removeListener:()=>{}} as unknown as EIP1193Provider;
  const client={getChainId:vi.fn(async()=>8453),getBlock:vi.fn(async()=>({number:123n,timestamp:1792952223n})),getBalance:vi.fn(async()=>UNIT),
    readContract:vi.fn(async(r:any):Promise<any>=>{
      if(r.functionName==='paused')return false;if(r.functionName==='currentEpoch')return epoch;
      if(r.functionName==='symbol')return 'USDC';if(r.functionName==='decimals')return 6;
      if(r.functionName==='previewClaim')return 50n;if(r.functionName==='previewUSDCMany')return [[],100n];
      return 20n*UNIT;
    }),simulateContract:vi.fn(async(r:any)=>({request:r})),waitForTransactionReceipt:vi.fn(async(_r:any)=>({status:'success',transactionHash:hash})),getTransactionReceipt:vi.fn(async()=>{throw Error('No receipt');})} as unknown as BaseClient;
  return {provider,request,client,setAccount:(a:Address)=>{account=a;},setChain:(c:string)=>{chain=c;},storage};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('claim wallet handoff',()=>{
 it('reports wallet handoff only at the actual write and never repeats or times out an unresolved wallet request',async()=>{
  vi.useFakeTimers();const env=setup(),stages:TransactionStage[]=[],broadcast=vi.fn();let releaseSimulation!:(r:any)=>void,releaseWallet!:(h:typeof hash)=>void;
  vi.mocked(env.client.simulateContract).mockImplementation(()=>new Promise(r=>{releaseSimulation=r;}));
  const original=env.request.getMockImplementation()!;env.request.mockImplementation(r=>r.method==='eth_sendTransaction'?new Promise(resolve=>{releaseWallet=resolve;}):original(r));
  const send=await createGuardedSender({...env,state:state(),onBroadcast:broadcast},undefined,undefined,s=>stages.push(s));let settled=false;
  const attempt=send(registry.legacy.epochDistributor as Address,LEGACY_TEST_CLAIM_ABI,'claimMany',[[registry.legacy.USDC],[epoch]]).finally(()=>{settled=true;});
  await vi.advanceTimersByTimeAsync(0);expect(stages.at(-1)).toBe('simulating');expect(stages).not.toContain('requesting-wallet');expect(env.request.mock.calls.some(([r])=>r.method==='eth_sendTransaction')).toBe(false);
  releaseSimulation({request:{address:registry.legacy.epochDistributor,abi:LEGACY_TEST_CLAIM_ABI,functionName:'claimMany',args:[[registry.legacy.USDC],[epoch]]}});await vi.advanceTimersByTimeAsync(0);
  expect(stages.at(-1)).toBe('requesting-wallet');expect(pendingTransaction(8453,user)).toMatchObject({action:'claimMany'});expect(pendingTransaction(8453,user)?.hash).toBeUndefined();
  await vi.advanceTimersByTimeAsync(WALLET_READ_TIMEOUT_MS*3);expect(settled).toBe(false);expect(env.request.mock.calls.filter(([r])=>r.method==='eth_sendTransaction')).toHaveLength(1);expect(pendingTransaction(8453,user)).not.toBeNull();
  releaseWallet(hash);await attempt;expect(broadcast).toHaveBeenCalledWith(hash);expect(pendingTransaction(8453,user)).toBeNull();
 });
 it('bounds a stalled preflight account read and cannot revive the send when the old answer arrives',async()=>{
  vi.useFakeTimers();const env=setup(),stages:TransactionStage[]=[];let release!:(r:any)=>void;const original=env.request.getMockImplementation()!;env.request.mockImplementation(r=>r.method==='eth_accounts'?new Promise(resolve=>{release=resolve;}):original(r));
  const attempt=createGuardedSender({...env,state:state(),onBroadcast:vi.fn()},undefined,undefined,s=>stages.push(s)),rejection=expect(attempt).rejects.toThrow('wallet did not answer');await vi.advanceTimersByTimeAsync(WALLET_READ_TIMEOUT_MS);await rejection;
  release([user]);await vi.advanceTimersByTimeAsync(0);expect(stages).toEqual(['checking-wallet']);expect(env.client.simulateContract).not.toHaveBeenCalled();expect(env.request.mock.calls.some(([r])=>r.method==='eth_sendTransaction')).toBe(false);expect(pendingTransaction(8453,user)).toBeNull();
 });
 it('preserves account-change refusal and emits no write-stage notification',async()=>{
  const env=setup(),stages:TransactionStage[]=[];const send=await createGuardedSender({...env,state:state(),onBroadcast:vi.fn()},undefined,undefined,s=>stages.push(s));env.setAccount(other);
  await expect(send(registry.legacy.epochDistributor as Address,LEGACY_TEST_CLAIM_ABI,'claimMany',[[registry.legacy.USDC],[epoch]])).rejects.toThrow('changed');expect(stages).not.toContain('requesting-wallet');expect(pendingTransaction(8453,user)).toBeNull();
 });
});
const LEGACY_TEST_CLAIM_ABI=parseAbi(['function claimMany(address[],uint256[])']);

describe('read-only local RPC boundary',()=>{
  it('keeps browser reads on loopback and disables contract-directed CCIP HTTP requests',()=>{
    vi.stubGlobal('window',{location:{origin:'http://127.0.0.1:4317'}});const client=publicBaseClient();expect(client.ccipRead).toBe(false);expect(client.transport.url).toBe('http://127.0.0.1:4317/api/base');
  });
  it.each(['eth_sendRawTransaction','eth_sendTransaction','personal_sign','eth_signTypedData_v4','anvil_setCode','debug_traceTransaction'])('refuses %s without an upstream request',method=>expect(()=>canonicalReadRequest({jsonrpc:'2.0',id:1,method,params:[]})).toThrow());
  it('refuses mixed read/write batches, oversized batches, and malformed params',()=>{
    expect(()=>canonicalReadRequest([{method:'eth_chainId'},{method:'eth_sendTransaction'}])).toThrow();
    expect(()=>canonicalReadRequest(Array(51).fill({method:'eth_call'}))).toThrow();expect(()=>canonicalReadRequest({method:'eth_call',params:{}})).toThrow();
  });
  it('re-encodes JSON reads and accepts gas simulation',()=>expect(JSON.parse(canonicalReadRequest({method:'eth_estimateGas',params:[{to:user}]})).method).toBe('eth_estimateGas'));
});
describe('actual routes and write guard',()=>{
  it.each(['legacyClaimMany','legacyWithdraw','oldAutoClaim','oldAutoWithdraw','liqClaimMany','liqWithdraw'] as const)('blocks %s while showing a retained observation during an RPC outage',kind=>{const s=state();s.error='Base refresh unavailable';expect(liveReason(kind,s,true)).toMatch(/Refresh Base contract data successfully/);});
  it('does not alias missing new contracts to deployed legacy contracts',()=>{
    const c=legacyConfig(boot);expect(c.streamingDistributor).toBeUndefined();expect(c.svault).toBeUndefined();expect(c.streamAutoVault).toBeUndefined();
    for(const kind of ['stake','unstake','claim','autoStake','autoUnstake','autoClaim','mint','nft'] as const)expect(liveReason(kind,state(),true)).toMatch(/not deployed/);
  });
  it('gates old AutoVault withdrawals on downstream pause reads while keeping its USDC claims separate',()=>{
    const s=state();s.legacyPaused=true;expect(liveReason('oldAutoWithdraw',s,true)).toMatch(/paused/);expect(liveReason('oldAutoClaim',s,true)).toBeUndefined();
    s.legacyPaused=undefined;expect(liveReason('oldAutoWithdraw',s,true)).toMatch(/could not be read/);
  });
  it('withdraws the exact reviewed amount; never calls an unbounded exit or approval',async()=>{
    const {provider,client,request}=setup(),seen=vi.fn();await executeLiveAction({provider,client,state:state(),action:action('legacyWithdraw',3n*UNIT),onBroadcast:seen});
    const tx=request.mock.calls.find(([r])=>r.method==='eth_sendTransaction')![0].params[0];
    expect(tx.to.toLowerCase()).toBe(registry.legacy.epochDistributor.toLowerCase());expect(tx.from.toLowerCase()).toBe(user.toLowerCase());
    expect(decodeFunctionData({abi:parseAbi(['function unstake(uint256)']),data:tx.data})).toEqual({functionName:'unstake',args:[3n*UNIT]});
    expect(seen).toHaveBeenCalledWith(hash);expect(pendingTransaction(8453,user)).toBeNull();expect(client.simulateContract).toHaveBeenCalledTimes(1);
  });
  it('refuses a receipt shortfall before simulation or signing',async()=>{
    const {provider,client,request}=setup();vi.mocked(client.readContract).mockImplementation(async(r:any)=>r.functionName==='paused'?false:r.address===registry.legacy.stiAERO?1n:20n*UNIT);
    await expect(executeLiveAction({provider,client,state:state(),action:action('legacyWithdraw'),onBroadcast:vi.fn()})).rejects.toThrow('receipts');
    expect(client.simulateContract).not.toHaveBeenCalled();expect(request.mock.calls.some(([r])=>r.method==='eth_sendTransaction')).toBe(false);
  });
  it.each(['account','network'])('refuses a changed %s during simulation',async(change)=>{
    const env=setup();vi.mocked(env.client.simulateContract).mockImplementation(async(r:any)=>{if(change==='account')env.setAccount(other);else env.setChain('0x1');return {request:r} as any;});
    await expect(executeLiveAction({...env,state:state(),action:action('legacyWithdraw'),onBroadcast:vi.fn()})).rejects.toThrow('changed');
    expect(env.request.mock.calls.some(([r])=>r.method==='eth_sendTransaction')).toBe(false);expect(pendingTransaction(8453,user)).toBeNull();
  });
  it('does not revive a cancelled workflow when the same wallet returns before simulation completes',async()=>{
    const env=setup();let current=true;
    vi.mocked(env.client.simulateContract).mockImplementation(async(r:any)=>{current=false;env.setAccount(other);env.setAccount(user);return {request:r} as any;});
    await expect(executeLiveAction({...env,state:state(),action:action('legacyWithdraw'),canContinue:()=>current,onBroadcast:vi.fn()})).rejects.toThrow('changed');
    expect(env.request.mock.calls.some(([r])=>r.method==='eth_sendTransaction')).toBe(false);expect(pendingTransaction(8453,user)).toBeNull();
  });
  it('does not request a signature for a reverting simulation',async()=>{
    const env=setup();vi.mocked(env.client.simulateContract).mockRejectedValue(Error('Contract reverted'));
    await expect(executeLiveAction({...env,state:state(),action:action('legacyWithdraw'),onBroadcast:vi.fn()})).rejects.toThrow('reverted');
    expect(env.request.mock.calls.some(([r])=>r.method==='eth_sendTransaction')).toBe(false);expect(pendingTransaction(8453,user)).toBeNull();
  });
  it('claims the selected token and exact week, including native ETH address zero',async()=>{
    const env=setup(),token='0x0000000000000000000000000000000000000000';
    await executeLiveAction({...env,state:state(),action:{...action('legacyClaim',50n),tokenAddress:token,tokenDecimals:18,tokenSymbol:'ETH',epoch},onBroadcast:vi.fn()});
    expect(env.client.simulateContract).toHaveBeenCalledWith(expect.objectContaining({address:registry.legacy.epochDistributor,functionName:'claim',args:[token,epoch],account:user,chainId:8453}));
  });
  it('rejects an implicit or malformed reward selection',async()=>{
    const env=setup();await expect(executeLiveAction({...env,state:state(),action:action('legacyClaim'),onBroadcast:vi.fn()})).rejects.toThrow('exact reward');
    expect(env.client.simulateContract).not.toHaveBeenCalled();
  });
  it('uses the old AutoVault for its exact-share withdrawal and separate USDC claim',async()=>{
    const env=setup();await executeLiveAction({...env,state:state(),action:action('oldAutoWithdraw',2n*UNIT),onBroadcast:vi.fn()});
    expect(env.client.simulateContract).toHaveBeenLastCalledWith(expect.objectContaining({address:registry.legacy.autoVault,functionName:'withdraw',args:[2n*UNIT]}));
    await executeLiveAction({...env,state:state(),action:{...action('oldAutoClaim',100n),epochs:[epoch,epoch-604800n]},onBroadcast:vi.fn()});
    expect(env.client.simulateContract).toHaveBeenLastCalledWith(expect.objectContaining({address:registry.legacy.autoVault,functionName:'claimUSDC',args:[[epoch,epoch-604800n]]}));
  });
  it('keeps the broadcast hash if receipt reads fail, and refuses a duplicate send after reload',async()=>{
    const env=setup(),broadcast=vi.fn();vi.mocked(env.client.waitForTransactionReceipt).mockRejectedValue(Error('Read failed after send'));
    await expect(executeLiveAction({...env,state:state(),action:action('legacyWithdraw'),onBroadcast:broadcast})).rejects.toThrow('Read failed');
    expect(broadcast).toHaveBeenCalledWith(hash);expect(pendingTransaction(8453,user)?.hash).toBe(hash);
    await expect(executeLiveAction({...env,state:state(),action:action('legacyWithdraw'),onBroadcast:broadcast})).rejects.toThrow('unresolved');
    expect(env.request.mock.calls.filter(([r])=>r.method==='eth_sendTransaction')).toHaveLength(1);
  });
  it('does not report a replacement or mismatched receipt as success',async()=>{
    const env=setup();vi.mocked(env.client.waitForTransactionReceipt).mockImplementation(async(r:any)=>{r.onReplaced?.({reason:'repriced'});return {status:'success',transactionHash:hash} as any;});
    await expect(executeLiveAction({...env,state:state(),action:action('legacyWithdraw'),onBroadcast:vi.fn()})).rejects.toThrow('changed during confirmation');
    expect(pendingTransaction(8453,user)?.replaced).toBe(true);
  });
  it('clears explicit wallet rejection but preserves an ambiguous send failure',async()=>{
    const env=setup(),original=env.request.getMockImplementation()!;
    env.request.mockImplementation(async(r:any)=>{if(r.method==='eth_sendTransaction')throw Object.assign(Error('Rejected'),{code:4001});return original(r);});
    await expect(executeLiveAction({...env,state:state(),action:action('legacyWithdraw'),onBroadcast:vi.fn()})).rejects.toThrow();expect(pendingTransaction(8453,user)).toBeNull();
    env.request.mockImplementation(async(r:any)=>{if(r.method==='eth_sendTransaction')throw Error('Connection lost');return original(r);});
    await expect(executeLiveAction({...env,state:state(),action:action('legacyWithdraw'),onBroadcast:vi.fn()})).rejects.toThrow();expect(pendingTransaction(8453,user)).not.toBeNull();expect(pendingTransaction(8453,user)?.hash).toBeUndefined();
  });
});
describe('real balance failure boundaries',()=>{
  it('keeps AutoVault USDC on its latest window when an older staking date is selected',async()=>{
    const env=setup(),original=vi.mocked(env.client.readContract).getMockImplementation()!;
    vi.mocked(env.client.readContract).mockImplementation(async(r:any)=>r.functionName==='previewUSDCMany'?[r.args[1].map((e:bigint)=>e===epoch?100n:0n),r.args[1].includes(epoch)?100n:0n]:original(r));
    const data=await readAccount(env.client,boot,user,'2025-10-23');expect(data.oldAutoEarned).toBe(100n);expect(data.oldAutoEpochs[0]).toBe(epoch);expect(data.rewardEpochs?.[0]).toBe(1761177600n);expect(data.rewards.every(r=>r.epoch<=1761177600n)).toBe(true);
  });
  it.each(['invalid-date','2099-01-01'])('does not hide AutoVault payouts behind an invalid staking date (%s)',async date=>{
    const env=setup(),data=await readAccount(env.client,boot,user,date);expect(data.rewardSelectionError).toBeTruthy();expect(data.rewards).toEqual([]);expect(data.oldAutoEarned).toBe(100n);expect(data.oldAutoEpochs[0]).toBe(epoch);
  });
  it('reads AutoVault rewards even when the independent staking epoch getter is unavailable',async()=>{
    const env=setup(),original=vi.mocked(env.client.readContract).getMockImplementation()!;vi.mocked(env.client.readContract).mockImplementation(async(r:any)=>{if(r.functionName==='currentEpoch')throw Error('Staking epoch unavailable');return original(r);});const data=await readAccount(env.client,boot,user);expect(data.oldAutoEarned).toBe(100n);expect(data.oldAutoEpochs[0]).toBe(epoch);expect(data.errors).toContain('Legacy current epoch could not be read.');
  });
  it.each([[epoch+604799n,epoch],[epoch+604800n,epoch+604800n]])('uses the exact UTC AutoVault week at timestamp %s',async(timestamp,week)=>{
    const env=setup();vi.mocked(env.client.getBlock).mockResolvedValue({number:123n,timestamp} as any);const data=await readAccount(env.client,boot,user,'2025-10-23');expect(data.oldAutoEpochs).toHaveLength(26);expect(data.oldAutoEpochs[0]).toBe(week);expect(new Set(data.oldAutoEpochs).size).toBe(26);
  });
  it.each([['invalid-date',''],['','invalid-token']])('keeps principal reads when the reward selector is invalid (%s)',async(date,token)=>{
    const env=setup(),data=await readAccount(env.client,boot,user,date,token);expect(data.known.legacyStake).toBe(true);expect(data.wallet.legacyStake).toBe(20n*UNIT);expect(data.oldAutoShares).toBe(20n*UNIT);expect(data.rewardSelectionError).toBeTruthy();
  });
  it('keeps principal and receipt reads when all reward reads fail; unknown is not zero',async()=>{
    const env=setup(),original=vi.mocked(env.client.readContract).getMockImplementation()!;
    vi.mocked(env.client.readContract).mockImplementation(async(r:any)=>{if(['previewClaim','previewUSDCMany'].includes(r.functionName))throw Error('Reward read unavailable');return original(r);});
    const data=await readAccount(env.client,boot,user);expect(data.known.legacyStake).toBe(true);expect(data.wallet.legacyStake).toBe(20n*UNIT);expect(data.legacyReceipts).toBe(20n*UNIT);expect(data.known.legacyRewards).toBeUndefined();expect(data.oldAutoShares).toBe(20n*UNIT);expect(data.oldAutoEarned).toBeUndefined();expect(data.rewardReadErrors).toBeGreaterThan(0);
  });
  it('does not hide dust, applies no USD threshold, and preserves unknown token units',async()=>{
    const env=setup(),original=vi.mocked(env.client.readContract).getMockImplementation()!;
    vi.mocked(env.client.readContract).mockImplementation(async(r:any)=>{if(['symbol','decimals'].includes(r.functionName))throw Error('Nonstandard token');if(r.functionName==='previewClaim')return 1n;return original(r);});
    const data=await readAccount(env.client,boot,user,'',other);expect(data.rewards.length).toBe((boot.registry.knownLegacyRewardTokens.length+1)*4);expect(data.rewards.every(r=>r.amount===1n)).toBe(true);expect(data.rewards.find(r=>r.token.toLowerCase()===other)?.decimals).toBeNull();expect(data.rewards.find(r=>BigInt(r.token)===0n)?.symbol).toBe('ETH');
  });
  it('sanitizes endpoint-bearing exceptions',()=>expect(publicError(Error('Request failed at https://provider.invalid/private-secret'))).not.toContain('private-secret'));
});
describe('reviewed client identity',()=>{
  it('preserves all six reviewed client source hashes unchanged',async()=>{
    const source=JSON.parse(await readFile(new URL('../REVIEWED_CLIENT_SOURCE.json',import.meta.url),'utf8'));
    for(const entry of source.clientFilesUnmodified){const bytes=await readFile(new URL('../'+entry.file,import.meta.url));expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);}
  });
});

it('releases an initial contract read that never responds instead of leaving the wallet connecting forever',async()=>{
 vi.useFakeTimers();vi.stubGlobal('fetch',vi.fn((_url,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))));
 try{const pending=fetchBootstrap(),failure=expect(pending).rejects.toThrow('verification timed out');await vi.advanceTimersByTimeAsync(25000);await failure;expect(vi.getTimerCount()).toBe(0);}finally{vi.useRealTimers();}
});
