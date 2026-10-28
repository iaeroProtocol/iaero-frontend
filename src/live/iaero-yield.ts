import policy from '../../config/iaero-yield.json';
import {annualisedApy,WEEK} from '../protocol-data/yield-model';
import {yieldWindowLabel} from '../protocol-data/yield-display';
import {YIELD_REPORT_MAX_AGE_MS} from '../protocol-data/yield-freshness';
import {acceptedReadCoverage} from '../protocol-data/read-coverage';
import type {ProtocolYieldReport} from './use-protocol-yield';
import type {Bootstrap} from './types';
const uint=(value:unknown):value is string=>typeof value==='string'&&/^\d{1,78}$/.test(value)&&BigInt(value)<2n**256n;

// [SETTLED: owner 2026-10-28; RewardsHarvesterV2.processAndDistribute]
// This is a current-price staking estimate. Receipt-time valuations, observed
// token income and the historical AERO-backing return remain unchanged.
export function observedIaeroYield(data:ProtocolYieldReport|undefined,boot:Bootstrap|undefined,now=Date.now()){
 const rate=data?.summary.annualised,seconds=rate?.windowSeconds??null;
 const unavailable=(reason:string)=>({apy:null as number|null,label:yieldWindowLabel(seconds),reason,priceUsdcWad:null as string|null,totalStaked:null as string|null,capitalUsdcWad:null as string|null,netIncomeUsdcWad:null as string|null,stakersBps:policy.legacyStakersBps});
 if(!data?.readAtMs||now-data.readAtMs>YIELD_REPORT_MAX_AGE_MS||data.readAtMs>now+5000)return unavailable('Waiting for a fresh shared reward observation.');
 if(!rate||rate.earnedApy===null||!uint(rate.earnedIncomeUsdcWad)||seconds===null||!Number.isSafeInteger(seconds)||seconds<=0||seconds>WEEK)return unavailable(rate?.earnedUnavailableReason??'The observed income window is unavailable.');
 if(!boot)return unavailable('Reading the current iAERO price and staking total.');
 // A future stream must publish its global stake and actual split before this
 // legacy estimate can be replaced. Never substitute an old pool silently.
 if(boot.newStackReady||boot.newStack?.configured)return unavailable('Waiting for the new staking pool’s total stake and reward allocation.');
 if(!boot.legacyReady||!uint(boot.metrics.legacyTotalStaked))return unavailable('The current iAERO staking total is unavailable.');
 const market=boot.metrics.market;
 if(!market||!Number.isSafeInteger(market.readAtMs)||market.readAtMs>now+5000||now-market.readAtMs>policy.marketMaxAgeMs||market.asOfBlock!==boot.snapshot.block||market.blockTimestamp!==boot.snapshot.timestamp||!acceptedReadCoverage(market.readProviders,boot.readCoverage))return unavailable('The current iAERO market price is unavailable or expired.');
 if(market.iaeroDecimals!==undefined&&market.iaeroDecimals!==policy.stakingDecimals)return unavailable('iAERO token precision could not be verified.');
 // Older public responses omit the direct price. Both observed market legs
 // are required in that case; AERO alone is never a fallback price.
 const raw=market.iaeroPriceUsdcWad===undefined&&uint(market.aeroPriceUsdcWad)&&uint(market.iaeroPegWad)?(BigInt(market.aeroPriceUsdcWad)*BigInt(market.iaeroPegWad)/10n**18n).toString():market.iaeroPriceUsdcWad;
 if(!uint(raw)||BigInt(raw)<=0n)return unavailable('A positive iAERO market price is required.');
 const total=BigInt(boot.metrics.legacyTotalStaked);if(total===0n)return unavailable('No iAERO is currently staked in this reward pool.');
 const capital=total*BigInt(raw)/10n**BigInt(policy.stakingDecimals),net=BigInt(rate.earnedIncomeUsdcWad)*BigInt(policy.legacyStakersBps)/10000n,apy=annualisedApy(net,capital,seconds);
 if(apy===null)return unavailable('The iAERO return could not be annualised.');
 return {apy,label:yieldWindowLabel(seconds),reason:null,priceUsdcWad:raw,totalStaked:total.toString(),capitalUsdcWad:capital.toString(),netIncomeUsdcWad:net.toString(),stakersBps:policy.legacyStakersBps};
}
