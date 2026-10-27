import {describe,it,expect} from 'vitest';
import {encodeAbiParameters,encodeEventTopics,parseAbi} from 'viem';
import {scanYieldHistory} from '../server/protocol-yield';
import {refreshClaimMetadata} from '../server/yield-engine';
import {blankLedger,effectiveClaim} from '../server/yield-ledger';
const h=('0x'+'11'.repeat(32)) as `0x${string}`,manager=('0x'+'22'.repeat(20)) as `0x${string}`,recipient=('0x'+'33'.repeat(20)) as `0x${string}`,usdc=('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') as `0x${string}`,gauge=('0x'+'55'.repeat(20)) as `0x${string}`,zero='0x'+'00'.repeat(20);
const abi=parseAbi(['event ClaimFees(uint256 indexed _tokenId,address indexed _recipient,address indexed _token,uint256 _amount)']);
const raw={address:manager,topics:encodeEventTopics({abi,eventName:'ClaimFees',args:{_tokenId:1584n,_recipient:recipient,_token:usdc}}),data:encodeAbiParameters([{type:'uint256'}],[1234567n]),blockNumber:'0x7b',blockHash:h,transactionHash:h,logIndex:'0x1',removed:false};
function context({registered=true,disagree=false,failReceipt=false,badRange=false,wrongClaim=false}={}){
 const log={...raw,...(badRange?{blockNumber:'0x7c'}:{})};
 const receipt={transactionHash:h,blockNumber:123n,blockHash:h,status:failReceipt?'reverted':'success',logs:[{...log,data:wrongClaim?'0x00':log.data,logIndex:1}]};
 const client={request:async()=>[log],getTransactionReceipt:async()=>receipt};
 return {source:{key:'test',name:'test',chainId:8453,historyFromBlock:'123',seedGauges:[],logChunkBlocks:1000,usdc,explorer:'https://basescan.org',approvedRecipients:[recipient]},clients:[client,{...client,request:async()=>disagree?[]:[log]}],block:123n,hash:h,timestamp:1000,factory:manager,header:async()=>({hash:h,timestamp:1000}),read:async(_a:string,s:string)=>s.includes('rewardsToGauge')?registered?gauge:zero:s.includes('gaugeToRewards')?manager:s.includes('decimals')?6:s.includes('symbol')?'USDC':undefined} as any;
}
describe('finalized claim indexing',()=>{
 it('binds received amounts to registered managers and matching receipts, then resumes without double counting',async()=>{
  const state=blankLedger('position'),ctx=context();await scanYieldHistory(ctx,state);expect(state.claims).toHaveLength(1);expect(state.claims[0]).toMatchObject({amount:'1234567',token:usdc,recipient,valueUsdcWad:'1234567000000000000',providers:2});expect(state.cursors[8453].complete).toBe(true);
  await scanYieldHistory(ctx,state);expect(state.claims).toHaveLength(1);
 });
 it('replays earlier history when an independent provider is added, retaining immutable original receipt facts',async()=>{const state=blankLedger('p'),ctx=context();ctx.clients=ctx.clients.slice(0,1);await scanYieldHistory(ctx,state);expect(state.cursors[8453].providers).toBe(1);await scanYieldHistory(context(),state);expect(state.cursors[8453].providers).toBe(2);expect(state.claims).toHaveLength(1);expect(state.claims[0].providers).toBe(1);});
 it('recovers a metadata outage during an independent-provider rescan without changing the original receipt',async()=>{const state=blankLedger('p'),ctx=context(),originalRead=ctx.read;ctx.clients=ctx.clients.slice(0,1);ctx.read=async(a:string,s:string)=>{if(/decimals|symbol/.test(s))throw Error('metadata outage');return originalRead(a,s);};await scanYieldHistory(ctx,state);const original=structuredClone(state.claims[0]);await scanYieldHistory(context(),state);expect(state.cursors[8453].providers).toBe(2);expect(state.claims[0]).toEqual(original);expect(effectiveClaim(state,state.claims[0])).toMatchObject({decimals:6,symbol:'USDC',providers:2,valueUsdcWad:'1234567000000000000'});});
 it('recovers stored metadata on a later tick even without a provider upgrade or log replay',async()=>{const state=blankLedger('p'),ctx=context(),read=ctx.read;ctx.read=async(a:string,s:string)=>{if(/decimals|symbol/.test(s))throw Error();return read(a,s);};await scanYieldHistory(ctx,state);expect(state.claims[0].decimals).toBeNull();await refreshClaimMetadata(context(),state);expect(effectiveClaim(state,state.claims[0]).decimals).toBe(6);expect(state.claims[0].decimals).toBeNull();});
 it('ignores a copied event emitted by an unregistered contract',async()=>{const state=blankLedger('p');await scanYieldHistory(context({registered:false}),state);expect(state.claims).toHaveLength(0);expect(state.cursors[8453].complete).toBe(true);});
 it.each([{disagree:true},{failReceipt:true},{badRange:true},{wrongClaim:true}])('refuses invalid evidence and does not advance the index: %j',async variant=>{const state=blankLedger('p');await expect(scanYieldHistory(context(variant),state)).rejects.toThrow();expect(state.cursors[8453]).toBeUndefined();expect(state.claims).toHaveLength(0);});
 it('stores an unexpected recipient for investigation without treating it as valued protocol income',async()=>{const state=blankLedger('p'),ctx=context();ctx.source.approvedRecipients=[];await scanYieldHistory(ctx,state);expect(state.claims[0].recipientRecognised).toBe(false);expect(state.claims[0].valueUsdcWad).toBeNull();});
 it('refuses a changed finalized checkpoint',async()=>{const state=blankLedger('p'),ctx=context();await scanYieldHistory(ctx,state);ctx.header=async()=>({hash:'0x'+'ff'.repeat(32),timestamp:1000});await expect(scanYieldHistory(ctx,state)).rejects.toThrow('checkpoint_changed');});
});
