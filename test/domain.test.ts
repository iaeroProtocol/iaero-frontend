import {describe,expect,it} from 'vitest';
import {applyAction,initialWallet,mintPreview,parseAmount,sampleBuyPreview,UNIT,type Action} from '../src/domain';

const at=1_800_000_000;
const action=(kind:Action['kind'],amount=UNIT):Action=>({kind,amount,title:'Test',description:'',source:'Sample wallet',target:'Sample position',approval:false});

describe('lossless preview amounts',()=>{
  it('preserves all 18 decimals without passing through floating point',()=>expect(parseAmount('12345678.123456789012345678')).toBe(12345678123456789012345678n));
  it.each(['1e3','-1','Infinity','1,000','0','0.0000000000000000001'])('refuses ambiguous or invalid amount %s',value=>expect(()=>parseAmount(value)).toThrow());
  it('requires USDC precision when the input token uses six decimals',()=>expect(()=>parseAmount('1.0000001',6)).toThrow());
});

describe('deposit economics',()=>{
  it('conserves the input as liquid output plus protocol fee',()=>{
    const input=UNIT+19n,preview=mintPreview(input);
    expect(preview.fee).toBe(50000000000000000n);expect(preview.received+preview.fee).toBe(input);
  });
  it('enforces the actual minimum and maximum deposit bounds',()=>{
    expect(()=>mintPreview(UNIT-1n)).toThrow();expect(()=>mintPreview(10_000_000n*UNIT+1n)).toThrow();expect(mintPreview(10_000_000n*UNIT).received).toBe(9_500_000n*UNIT);
  });
  it('only mints the net iAERO and debits the exact AERO amount',()=>{
    const before=initialWallet(at),after=applyAction(before,action('mint',100n*UNIT),at);
    expect(before.aero-after.aero).toBe(100n*UNIT);expect(after.iaero-before.iaero).toBe(95n*UNIT);expect(after.staked).toBe(before.staked);
  });
});

describe('principal and reward separation',()=>{
  it('returns the exact principal on an equal stake/unstake round trip',()=>{
    const before=initialWallet(at),staked=applyAction(before,action('stake',125n*UNIT),at),after=applyAction(staked,action('unstake',125n*UNIT),at);
    expect(after).toEqual(before);
  });
  it('keeps accumulated USDC claimable after the entire principal exits',()=>{
    const before=initialWallet(at),exited=applyAction(before,action('unstake',before.staked),at),claimed=applyAction(exited,action('claim',0n),at);
    expect(exited.staked).toBe(0n);expect(exited.earned).toBe(before.earned);expect(claimed.usdc-before.usdc).toBe(before.earned);expect(claimed.earned).toBe(0n);
  });
  it('preserves old rewards after legacy principal withdrawal',()=>{
    const before=initialWallet(at),exited=applyAction(before,action('legacyWithdraw'),at),claimed=applyAction(exited,action('legacyClaim'),at);
    expect(exited.legacyStake).toBe(0n);expect(exited.legacyRewards).toBe(before.legacyRewards);expect(claimed.usdc-before.usdc).toBe(before.legacyRewards);
  });
  it('refuses to spend a stale or insufficient principal balance',()=>expect(()=>applyAction(initialWallet(at),action('stake',10_000n*UNIT),at)).toThrow('balance changed'));
  it('does not double-pay a legacy claim',()=>{
    const first=applyAction(initialWallet(at),action('legacyClaim'),at);
    expect(()=>applyAction(first,action('legacyClaim'),at)).toThrow();
  });
  it('keeps the two staking routes separate',()=>{
    const before=initialWallet(at),after=applyAction(before,action('autoStake',10n*UNIT),at);
    expect(after.staked).toBe(before.staked);expect(after.autoStaked).toBe(10n*UNIT);expect(after.iaero).toBe(before.iaero-10n*UNIT);
  });
  it('fails closed for the unregistered NFT intake route',()=>expect(()=>applyAction(initialWallet(at),action('nft'),at)).toThrow('registration'));
});

describe('sample market route',()=>{
  it('spends exactly the input USDC and credits only the quoted output',()=>{
    const before=initialWallet(at),input=100_000_000n,quote=sampleBuyPreview(input),after=applyAction(before,action('buy',input),at);
    expect(before.usdc-after.usdc).toBe(input);expect(after.iaero-before.iaero).toBe(quote.received);
  });
});
