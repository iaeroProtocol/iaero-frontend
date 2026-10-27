import policy from '../../config/protocol-yield.json' with {type:'json'};
import type {AnnualisedYield,YieldAsset} from './yield-model.ts';
import {canonicalYieldUsdc,yieldPriceObservedAt,freshYieldPrice} from './yield-price.ts';
export const YIELD_REPORT_MAX_AGE_MS=900000;
export const EXPIRED_YIELD_PRICE_REASON='Price observations expired. Refresh for a current earned-yield estimate.';
type Report={readAtMs:number|null;asOfTimestamp?:number;assets:YieldAsset[];summary:{pendingValueUsdcWad:string|null;pendingPartial:boolean;earnedApy7d:number|null;apyUnavailableReason:string|null;earnedPriceObservedAt?:number|null;annualised?:AnnualisedYield};chainTotals?:{chainId:number;pendingValueUsdcWad:string|null;pendingPartial:boolean}[]};
const key=(a:YieldAsset)=>a.chainId+':'+a.token.toLowerCase();
export function yieldFreshness(report:Report,now=Date.now()){
 const reference=Math.min(report.readAtMs??0,(report.asOfTimestamp??Number.POSITIVE_INFINITY)*1000),priced=report.assets.filter(a=>BigInt(a.amount)>0n&&a.valueUsdcWad!==null&&!canonicalYieldUsdc(a));
 const pendingTimes=priced.map(a=>({asset:a,observedAt:yieldPriceObservedAt(a,reference)!}));
 const fresh=(at:number)=>freshYieldPrice(at,policy.pricing.maxAgeSeconds,policy.pricing.maxFutureSeconds,now/1000);
 const expired=pendingTimes.filter(p=>!fresh(p.observedAt)),a=report.summary.annualised;
 const declared=a?a.earnedPriceObservedAt:report.summary.earnedPriceObservedAt;
 // Older reports did not bind the aligned ratio time. Their display lifetime
 // conservatively starts at the common observation cutoff, not a later fetch.
 const earnedTime=declared===undefined?Math.min(Math.floor(reference/1000),...pendingTimes.map(p=>p.observedAt)):declared;
 const earnedValue=a?a.earnedApy:report.summary.earnedApy7d,earnedPriceExpired=earnedValue!==null&&earnedTime!==null&&!fresh(earnedTime);
 const deadlines=[...(report.readAtMs===null?[]:[report.readAtMs+YIELD_REPORT_MAX_AGE_MS+1]),...pendingTimes.map(p=>(p.observedAt+policy.pricing.maxAgeSeconds)*1000+1),...(earnedTime===null?[]:[(earnedTime+policy.pricing.maxAgeSeconds)*1000+1])].filter(t=>Number.isFinite(t)&&t>now);
 return {pendingPricesExpired:expired.length>0,earnedPriceExpired,priceExpired:expired.length>0||earnedPriceExpired,expiredAssetKeys:expired.map(p=>key(p.asset)),expiredChainIds:[...new Set(expired.map(p=>p.asset.chainId))],nextDeadlineMs:deadlines.length?Math.min(...deadlines):null};
}
export function currentYieldDisplay<T extends Report>(report:T,now=Date.now()){
 const freshness=yieldFreshness(report,now);if(!freshness.priceExpired)return {data:report,...freshness};
 const assets=report.assets.map(a=>freshness.expiredAssetKeys.includes(key(a))?{...a,valueUsdcWad:null}:a),summary={...report.summary};
 if(freshness.pendingPricesExpired){summary.pendingValueUsdcWad=null;summary.pendingPartial=true;}
 if(freshness.earnedPriceExpired){
  summary.earnedApy7d=null;summary.apyUnavailableReason=EXPIRED_YIELD_PRICE_REASON;
  if(summary.annualised){const a=summary.annualised;summary.annualised={...a,earnedApy:null,earnedIncomeUsdcWad:null,earnedUnavailableReason:EXPIRED_YIELD_PRICE_REASON,qualification:a.receivedApy!==null?a.provisional?'provisional':'verified':'unavailable'};}
 }
 const chainTotals=report.chainTotals?.map(c=>freshness.expiredChainIds.includes(c.chainId)?{...c,pendingValueUsdcWad:null,pendingPartial:true}:c);
 return {data:{...report,assets,summary,...(chainTotals?{chainTotals}:{})} as T,...freshness};
}
