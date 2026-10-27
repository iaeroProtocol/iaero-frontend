import policy from '../../config/protocol-yield.json' with {type:'json'};
export type YieldPrice={source:'swap-quote'|'market-reference'|'price-feed';observedAt:number;reference:string;carriedForward:boolean};
export function canonicalYieldUsdc(asset:{chainId:number;token:string;decimals:number|null}){return asset.decimals===6&&policy.chains.some(c=>c.chainId===asset.chainId&&c.usdc?.toLowerCase()===asset.token.toLowerCase());}
export function yieldPriceObservedAt(asset:{chainId:number;token:string;decimals:number|null;price?:YieldPrice},recordedAtMs:number){return canonicalYieldUsdc(asset)?null:asset.price?.observedAt??(Number.isSafeInteger(recordedAtMs)&&recordedAtMs>=0?Math.floor(recordedAtMs/1000):0);}
export function validYieldPrice(value:unknown):value is YieldPrice{
 const p=value as YieldPrice;
 return !!p&&['swap-quote','market-reference','price-feed'].includes(p.source)&&Number.isSafeInteger(p.observedAt)&&p.observedAt>=0&&typeof p.reference==='string'&&p.reference.length>0&&p.reference.length<=300&&!/[\x00-\x1f]/.test(p.reference)&&typeof p.carriedForward==='boolean';
}
export function freshYieldPrice(observedAt:number,maxAgeSeconds:number,maxFutureSeconds:number,now=Date.now()/1000){return Number.isSafeInteger(observedAt)&&observedAt>=0&&now-observedAt<=maxAgeSeconds&&observedAt-now<=maxFutureSeconds;}
