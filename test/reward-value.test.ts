import {describe,expect,it,vi} from 'vitest';
import type {Address} from 'viem';
import registry from '../config/base.registry.json';
import {estimateTokenValue,valueInput} from '../server/reward-value';
import {groupRewards} from '../src/live/rewards';
import {activeRewardValue,portfolioRewardValue,priceRewards,rewardValueKey,valuationSnapshot,valueText} from '../src/live/reward-value';
import {initialLiveState} from '../src/live/types';
import type {RewardLeg} from '../src/domain';
const token=registry.legacy.WETH as Address,usdc=registry.legacy.USDC as Address,user='0x1111111111111111111111111111111111111111',config={usdc,weth:token},epoch=1792627200n;
const row=(address=token,amount=10n**18n,decimals:number|null=18):RewardLeg=>({token:address,amount,decimals,symbol:'TOKEN',epoch});
const input=(address=token,amount=1n,decimals:number|null=18)=>({token:address,amount,decimals});
describe('read-only reward estimates',()=>{
  it('values USDC exactly without any quote or float conversion',async()=>{const quote=vi.fn(),v=await estimateTokenValue(input(usdc,12345678n,6),config,quote,100);expect(v.valueWad).toBe('12345678000000000000');expect(quote).not.toHaveBeenCalled();});
  it('uses an exact-amount quote for the total grouped token balance',async()=>{const quote=vi.fn(async()=>({sellAmount:'2',buyAmount:'1234567'})),v=await estimateTokenValue(input(token,2n),config,quote,100);expect(v.valueWad).toBe('1234567000000000000');expect(v.source).toBe('quote');expect(quote).toHaveBeenCalledWith(token,2n);});
  it('prices native ETH through WETH without preparing a wrapping transaction',async()=>{const quote=vi.fn(async()=>({sellAmount:'1',buyAmount:'10'}));await estimateTokenValue(input('0x0000000000000000000000000000000000000000',1n),config,quote);expect(quote).toHaveBeenCalledWith(token,1n);});
  it('uses a reference quote for dust and preserves sub-micro-USDC value',async()=>{
    const quote=vi.fn().mockRejectedValueOnce(Error('No trade for dust')).mockResolvedValueOnce({sellAmount:(10n**18n).toString(),buyAmount:'2345000000'}),v=await estimateTokenValue(input(),config,quote,100);
    expect(v.source).toBe('reference');expect(v.valueWad).toBe('2345');expect(valueText(BigInt(v.valueWad!))).toBe('< 0.000001');
  });
  it('keeps unavailable prices unknown rather than treating them as zero',async()=>{const v=await estimateTokenValue(input(),config,vi.fn().mockRejectedValue(Error('Unavailable')));expect(v.valueWad).toBeNull();expect(v.source).toBe('unavailable');});
  it('never guesses decimals for a reference quote when metadata is unknown',async()=>{const quote=vi.fn().mockRejectedValue(Error('Unavailable'));await estimateTokenValue(input(token,2n,null),config,quote);expect(quote).toHaveBeenCalledTimes(1);});
  it('rejects mismatched quote amounts and zero output as prices',async()=>{const quote=vi.fn().mockResolvedValue({sellAmount:'999',buyAmount:'100'});expect((await estimateTokenValue(input(),config,quote)).valueWad).toBeNull();quote.mockResolvedValue({sellAmount:'1',buyAmount:'0'});expect((await estimateTokenValue(input(token,1n,0),config,quote)).valueWad).toBeNull();});
  it('rejects a quote denominated in another output token',async()=>{const quote=vi.fn().mockResolvedValue({sellAmount:'1',buyAmount:'100',buyToken:token});expect((await estimateTokenValue(input(token,1n,0),config,quote)).valueWad).toBeNull();});
  it.each(['token=x&amount=1','token='+token+'&amount=0','token='+token+'&amount=1&decimals=37','token='+token+'&amount=-1'])('refuses an invalid value request %s',query=>expect(()=>valueInput(new URLSearchParams(query))).toThrow());
});
describe('reward totals and stale results',()=>{
  const cached=(key='selection',at=Date.now()-110000)=>valuationSnapshot(key,groupRewards([row()]),{[token.toLowerCase()]:{token,amount:10n**18n,valueWad:5n*10n**18n,source:'quote',quotedAt:at}},false);
  it('keeps an exact-selection estimate visible while still requesting a new price',async()=>{
    const old=cached(),updates:any[]=[],fetcher=vi.fn(async()=>({ok:true,json:async()=>({token,amount:(10n**18n).toString(),valueWad:'6000000000000000000',source:'quote',quotedAt:Date.now()})})) as any;
    await priceRewards('selection',[row()],usdc,v=>updates.push(v),new AbortController().signal,fetcher,old);
    expect(updates[0].totalWad).toBe(5n*10n**18n);expect(updates[0].asOf).toBe(old.asOf);expect(updates.at(-1).totalWad).toBe(6n*10n**18n);expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retains a fresh value after a transient failure without extending its original expiry',async()=>{
    const old=cached(),updates:any[]=[];await priceRewards('selection',[row()],usdc,v=>updates.push(v),new AbortController().signal,vi.fn(async()=>({ok:false,status:503})) as any,old);
    const last=updates.at(-1);expect(last.totalWad).toBe(old.totalWad);expect(last.asOf).toBe(old.asOf);expect(last.values[token.toLowerCase()].quotedAt).toBe(old.asOf);expect(last.refreshErrors).toBe(1);
    const expired=cached('selection',Date.now()-120001),later:any[]=[];await priceRewards('selection',[row()],usdc,v=>later.push(v),new AbortController().signal,vi.fn().mockRejectedValue(Error('outage')),expired);expect(later[0].totalWad).toBeNull();expect(later.at(-1).totalWad).toBeNull();
  });
  it.each(['account','amount'])('never carries a cached price into a changed %s',async changed=>{
    const updates:any[]=[],old=cached(),rows=[row(token,changed==='amount'?2n*10n**18n:10n**18n)];await priceRewards(changed==='account'?'another-account':'selection',rows,usdc,v=>updates.push(v),new AbortController().signal,vi.fn().mockRejectedValue(Error('outage')),old);expect(updates[0].totalWad).toBeNull();expect(updates.at(-1).totalWad).toBeNull();
  });
  it('invalidates a cached estimate when a successful response has the wrong identity',async()=>{
    const old=cached(),updates:any[]=[];await priceRewards('selection',[row()],usdc,v=>updates.push(v),new AbortController().signal,vi.fn(async()=>({ok:true,json:async()=>({token:usdc,amount:(10n**18n).toString(),valueWad:'999',source:'quote',quotedAt:Date.now()})})) as any,old);expect(updates[0].totalWad).toBe(old.totalWad);expect(updates.at(-1).totalWad).toBeNull();
  });
  it('sums each token only once across its weeks using integer USDC precision',async()=>{
    const rows=[row(usdc,1000000n,6),{...row(usdc,2000000n,6),epoch:epoch-604800n},row(token,2n)],updates:any[]=[];
    const fetcher=vi.fn(async()=>({ok:true,json:async()=>({token,amount:'2',valueWad:'4000000000000000000',source:'quote',quotedAt:Date.now()})})) as any;
    await priceRewards('selection',rows,usdc,v=>updates.push(v),new AbortController().signal,fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(updates.at(-1).totalWad).toBe(7n*10n**18n);expect(updates.at(-1).priced).toBe(2);
  });
  it('reports partial estimates without losing claimable token amounts',async()=>{
    const rows=[row(usdc,1000000n,6),row()],original=rows.map(r=>({...r})),updates:any[]=[];
    await priceRewards('selection',rows,usdc,v=>updates.push(v),new AbortController().signal,vi.fn().mockRejectedValue(Error('No quote')) as any);
    expect(updates.at(-1).totalWad).toBe(10n**18n);expect(updates.at(-1).unpriced).toBe(1);expect(rows).toEqual(original);
  });
  it('shows no numeric total when none of the reward tokens can be priced',()=>{const rows=[row()],v=valuationSnapshot('key',groupRewards(rows),{[token.toLowerCase()]:{token,amount:10n**18n,valueWad:null,source:'unavailable',quotedAt:Date.now()}},false);expect(v.totalWad).toBeNull();expect(valueText(v.totalWad)).toBe('—');});
  it('ignores a previous account or reward selection before the next request completes',()=>{
    const s={...initialLiveState(),address:user as Address,chainId:8453,readAt:123,rewards:[row()]},key=rewardValueKey(user,8453,s.rewards,'','',true);
    s.rewardValuation=valuationSnapshot(key,groupRewards(s.rewards),{},true);expect(activeRewardValue(s)).toBeDefined();s.address='0x2222222222222222222222222222222222222222';expect(activeRewardValue(s)).toBeUndefined();
  });
  it('does not publish a late price result after cancellation',async()=>{
    const controller=new AbortController(),updates:any[]=[];let release!:(value:any)=>void;
    const response=new Promise<any>(r=>{release=r;});const work=priceRewards('key',[row()],usdc,v=>updates.push(v),controller.signal,()=>response);
    controller.abort();release({ok:true,json:async()=>({token,amount:(10n**18n).toString(),valueWad:'1000000000000000000',source:'quote',quotedAt:Date.now()})});await work;expect(updates).toHaveLength(1);expect(updates[0].loading).toBe(true);
  });
  it('never represents a known positive dust estimate as a zero dollar value',()=>expect(valueText(0n,true)).toBe('< 0.000001'));
  it('includes known AutoVault USDC without pretending unknown token rewards have no value',()=>{
    const s={...initialLiveState(),address:user as Address,chainId:8453,readAt:123,rewards:[row()],oldAutoEarned:2000000n};
    const key=rewardValueKey(user,8453,s.rewards,'','',true);s.rewardValuation=valuationSnapshot(key,groupRewards(s.rewards),{},true);
    expect(portfolioRewardValue(s)).toEqual({valueWad:2n*10n**18n,partial:true,positive:true});
  });
});
