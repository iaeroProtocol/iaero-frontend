import {it,expect} from 'vitest';
import {fundedIaeroYield} from '../src/live/position-model';
const E=10n**18n,now=1793000000;
const live=()=>({boot:{newStackReady:true,newStack:{configured:true},metrics:{market:{aeroPriceUsdcWad:'640000000000000000',iaeroPegWad:'950000000000000000',blockTimestamp:now}}},newPosition:{stream:{timestamp:now,periodFinish:now+86400,totalStaked:1000n*E,rewardRate:E,precision:E}}}) as any;
it('shares the funded USDC staking APR used by Earn rather than treating it as compounded APY',()=>{expect(fundedIaeroYield(live()).apr).toBeCloseTo(31.536/608*100);});
it('keeps a missing deployment unavailable and describes the funding requirement',()=>{const l=live();l.boot.newStackReady=false;l.boot.newStack.configured=false;l.boot.newStackReason='Awaiting accepted deployment';expect(fundedIaeroYield(l)).toEqual({apr:null,reason:'Awaiting accepted deployment'});});
it.each(['total','rate','price','stale-price'])('keeps %s read failures unknown rather than displaying zero',mode=>{const l=live();if(mode==='total')l.newPosition.stream.totalStaked=undefined;if(mode==='rate')l.newPosition.stream.rewardRate=undefined;if(mode==='price')l.boot.metrics.market.aeroPriceUsdcWad=null;if(mode==='stale-price')l.boot.metrics.market.blockTimestamp=now-901;expect(fundedIaeroYield(l).apr).toBeNull();});
it('distinguishes a genuinely ended stream from a missing read',()=>{const l=live();l.newPosition.stream.periodFinish=now-1;expect(fundedIaeroYield(l)).toMatchObject({apr:0,reason:'The funded stream has ended.'});});
it('does not remove a global rate when only the user’s receipt balance is unavailable',()=>{const l=live();l.newPosition.stream.balance=undefined;expect(fundedIaeroYield(l).apr).toBeGreaterThan(0);});
