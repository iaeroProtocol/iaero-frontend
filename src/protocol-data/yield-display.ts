import type {AnnualisedYield,YieldAsset} from './yield-model';
import {WEEK} from './yield-model.ts';
import policy from '../../config/protocol-yield.json' with {type:'json'};
import {canonicalYieldUsdc,freshYieldPrice} from './yield-price.ts';
export const formatYieldPercent=(value:number|null|undefined)=>value==null?'—':value>0&&value<.01?'< 0.01%':value>=1000000?value.toExponential(2)+'%':value.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})+'%';

export function yieldWindowLabel(seconds:number|null){
 if(seconds===null)return 'observing';
 if(seconds===WEEK)return 'rolling 7d';
 if(seconds>=86400)return (Math.floor(seconds/864)/100).toLocaleString('en-GB',{maximumFractionDigits:2})+'d estimate';
 if(seconds>=3600)return (Math.floor(seconds/36)/100).toLocaleString('en-GB',{maximumFractionDigits:2})+'h estimate';
 if(seconds>=60)return Math.floor(seconds/60)+'m estimate';
 return seconds+'s estimate';
}
type Input={summary:{annualised?:AnnualisedYield;earnedApy7d:number|null;receivedApy7d:number|null;apyUnavailableReason:string|null;receivedApyUnavailableReason?:string|null};chains?:{chainId:number;name:string;providers:number}[]};
export function protocolYieldDisplay(data:Input){
 const rate=data.summary.annualised;
 if(!rate)return {earned:data.summary.earnedApy7d,received:data.summary.receivedApy7d,label:'rolling 7d',start:null,end:null,provisional:false,qualification:null,earnedReason:data.summary.apyUnavailableReason,receivedReason:data.summary.receivedApyUnavailableReason??data.summary.apyUnavailableReason};
 const names=rate.unverifiedChainIds.map(id=>data.chains?.find(c=>c.chainId===id)?.name??'Chain '+id);
 const qualification=rate.qualification==='unavailable'?null:names.length?'Provisional estimate · independent confirmation pending: '+names.join(', ')+'.':rate.provisional?'Early estimate · annualised from the observed period.':null;
 return {earned:rate.earnedApy,received:rate.receivedApy,label:yieldWindowLabel(rate.windowSeconds),start:rate.windowStart,end:rate.windowEnd,provisional:rate.provisional,qualification,earnedReason:rate.earnedUnavailableReason,receivedReason:rate.receivedUnavailableReason};
}
export function yieldPriceNote(assets:YieldAsset[],now=Date.now()/1000){
 if(assets.some(a=>BigInt(a.amount)>0n&&a.price&&!canonicalYieldUsdc(a)&&!freshYieldPrice(a.price.observedAt,policy.pricing.maxAgeSeconds,policy.pricing.maxFutureSeconds,now)))return 'Price observations expired. Refresh for current reward estimates.';
 const saved=assets.filter(a=>a.price?.carriedForward),market=assets.some(a=>a.price?.source==='market-reference');
 if(saved.length){const oldest=Math.min(...saved.map(a=>a.price!.observedAt));return 'Some estimates use saved prices observed '+new Date(oldest*1000).toISOString().replace('T',' ').replace('.000Z',' UTC')+'. Current token balances are used; saved prices expire.';}
 return market?'Some tokens use USDC market-price references. Estimated value does not imply that a swap is available.':null;
}
