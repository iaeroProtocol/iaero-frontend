// [VERIFIED: docs.dexscreener.com/api/reference, token-pairs/v1]
// Informational USDC valuations only. A market reference is never a swap route
// or evidence that a token is authorised for trading by a quote provider.
import type {Address} from 'viem';
import type {YieldAsset,YieldLedger} from '../src/protocol-data/yield-model.ts';
import type {YieldPrice} from '../src/protocol-data/yield-price.ts';
import {validYieldPrice,freshYieldPrice,canonicalYieldUsdc} from '../src/protocol-data/yield-price.ts';
import {estimateTokenValue} from './reward-value.ts';
import {priceYieldAssets,type PricePolicy,type PriceProof} from './yield-prices.ts';
type Config={usdc:string;weth:string;swapper:string;quoteEndpoint:string;aliases:{chainId:number;token:string;baseToken:string;decimals:number}[];pricing:PricePolicy;market:{endpoint:string;minLiquidityUsdc:number}};
type Basis={amount:bigint;value:bigint;price:YieldPrice};
const key=(a:YieldAsset)=>[a.chainId,a.token.toLowerCase(),a.decimals,a.symbol.toUpperCase()].join(':'),same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const decimal=(v:unknown)=>{if(typeof v!=='string'||!/^\d{1,13}(?:\.\d{1,30})?$/.test(v))return null;const [whole,fraction='']=v.split('.'),n=BigInt(whole)*10n**18n+BigInt((fraction+'0'.repeat(18)).slice(0,18));return n>0n&&n<=10n**30n?n:null;};
// A long collection can outlive an early price. Reuse a newer, provenanced
// ratio from its aligned observation without changing any archived fact or age.
export function finalizePendingPrices(assets:YieldAsset[],snapshots:YieldLedger['snapshots'],policy:Pick<PricePolicy,'maxAgeSeconds'|'maxFutureSeconds'>,now=Date.now()){
 const fresh=(p:YieldPrice|undefined):p is YieldPrice=>!!p&&validYieldPrice(p)&&freshYieldPrice(p.observedAt,policy.maxAgeSeconds,policy.maxFutureSeconds,now/1000),ratios=new Map<string,YieldAsset>(),changedKeys:string[]=[];
 for(const snapshot of snapshots)for(const a of [...snapshot.assets,...(snapshot.prices??[])])if(fresh(a.price)&&a.valueUsdcWad!==null&&BigInt(a.amount)>0n&&BigInt(a.valueUsdcWad)>0n){const old=ratios.get(key(a));if(!old||old.price!.observedAt<a.price.observedAt)ratios.set(key(a),a);}
 const result=assets.map(a=>{
  if(canonicalYieldUsdc(a)||BigInt(a.amount)===0n)return a;
  const ratio=ratios.get(key(a));
  if(ratio&&(!fresh(a.price)||ratio.price!.observedAt>a.price.observedAt)){changedKeys.push(a.chainId+':'+a.token.toLowerCase());return {...a,valueUsdcWad:(BigInt(a.amount)*BigInt(ratio.valueUsdcWad!)/BigInt(ratio.amount)).toString(),price:{...ratio.price!,carriedForward:true}};}
  if(a.valueUsdcWad!==null&&!fresh(a.price)){changedKeys.push(a.chainId+':'+a.token.toLowerCase());const {price,...rest}=a;return {...rest,valueUsdcWad:null};}
  return a;
 });
 return {assets:result,changedKeys};
}
export function createCurrentYieldPricer(state:YieldLedger,config:Config,options:{fetchImpl?:typeof fetch;now?:()=>number}={}){
 const fetcher=options.fetchImpl??fetch,clock=options.now??Date.now,prior=new Map<string,Basis>(),current=new Map<string,Basis>(),attempted=new Map<string,Promise<Basis|null>>();
 const usable=(p:YieldPrice)=>validYieldPrice(p)&&freshYieldPrice(p.observedAt,config.pricing.maxAgeSeconds,config.pricing.maxFutureSeconds,clock()/1000);
 for(const s of state.snapshots)for(const a of [...s.assets,...(s.prices??[])])if(a.price&&usable(a.price)&&a.valueUsdcWad!==null&&BigInt(a.valueUsdcWad)>0n&&BigInt(a.amount)>0n){const old=prior.get(key(a));if(!old||old.price.observedAt<a.price.observedAt)prior.set(key(a),{amount:BigInt(a.amount),value:BigInt(a.valueUsdcWad),price:{...a.price,carriedForward:true}});}
 const apply=(asset:YieldAsset,basis:Basis)=>{if(!usable(basis.price))return false;asset.valueUsdcWad=(BigInt(asset.amount)*basis.value/basis.amount).toString();asset.price={...basis.price};return true;};
 async function basePrice(asset:YieldAsset,token:string):Promise<Basis|null>{
  let denied=false;
  const input={token:token as Address,amount:BigInt(asset.amount),decimals:asset.decimals};
  const quote=await estimateTokenValue(input,{usdc:config.usdc as Address,weth:config.weth as Address},async(sellToken,amount)=>{
   if(denied)throw Error('yield_quote_unavailable');
   const u=new URL(config.quoteEndpoint);for(const [k,v] of Object.entries({chainId:'8453',sellToken,buyToken:config.usdc,sellAmount:amount.toString(),taker:config.swapper,recipient:config.swapper}))u.searchParams.set(k,v);
   const r=await fetcher(u.href,{signal:AbortSignal.timeout(12000)});if(!r.ok){denied=[401,403,422,429].includes(r.status);throw Error('yield_quote_unavailable');}return r.json();
  },clock());
  if(quote.valueWad!==null&&BigInt(quote.valueWad)>0n)return {amount:input.amount,value:BigInt(quote.valueWad),price:{source:'swap-quote',observedAt:Math.floor(quote.quotedAt/1000),reference:config.quoteEndpoint,carriedForward:false}};
  if(asset.decimals===null)return null;
  try{
   const u=new URL(config.market.endpoint);if(u.protocol!=='https:'||u.hostname!=='api.dexscreener.com'||u.username||u.password||u.search||u.hash)throw Error('yield_market_configuration');
   u.pathname='/token-pairs/v1/base/'+token;const r=await fetcher(u.href,{headers:{accept:'application/json'},signal:AbortSignal.timeout(12000)});if(!r.ok)return null;const rows=await r.json();if(!Array.isArray(rows)||rows.length>1000)return null;
   const pairs=rows.filter(p=>p?.chainId==='base'&&same(p.baseToken?.address,token)&&same(p.baseToken?.symbol,asset.symbol)&&same(p.quoteToken?.address,config.usdc)&&typeof p.pairAddress==='string'&&/^0x[0-9a-f]{40}$/i.test(p.pairAddress)&&typeof p.liquidity?.usd==='number'&&Number.isFinite(p.liquidity.usd)&&p.liquidity.usd>=config.market.minLiquidityUsdc&&typeof p.liquidity.quote==='number'&&Number.isFinite(p.liquidity.quote)&&p.liquidity.quote>=config.market.minLiquidityUsdc/4&&decimal(p.priceNative)!==null).sort((a,b)=>b.liquidity.usd-a.liquidity.usd);
   if(!pairs.length)return null;const pair=pairs[0];return {amount:10n**BigInt(asset.decimals),value:decimal(pair.priceNative)!,price:{source:'market-reference',observedAt:Math.floor(clock()/1000),reference:'base:'+pair.pairAddress.toLowerCase(),carriedForward:false}};
  }catch{return null;}
 }
 return async function price(assets:YieldAsset[]){
  for(const asset of assets){if(asset.valueUsdcWad!==null)continue;const id=key(asset),live=current.get(id);if(live&&apply(asset,live))continue;
   const alias=config.aliases.find(a=>a.chainId===asset.chainId&&same(a.token,asset.token)&&a.decimals===asset.decimals);
   if(asset.chainId===8453||alias){if(!attempted.has(id))attempted.set(id,basePrice(asset,alias?.baseToken??asset.token));const basis=await attempted.get(id)!;if(basis&&apply(asset,basis))current.set(id,basis);}
  }
  const proofs:Map<string,PriceProof>=await priceYieldAssets(assets,config.pricing,{fetchImpl:fetcher,time:Math.floor(clock()/1000)});
  for(const asset of assets){const id=key(asset);if(asset.price&&asset.valueUsdcWad!==null&&BigInt(asset.valueUsdcWad)>0n&&BigInt(asset.amount)>0n&&usable(asset.price))current.set(id,{amount:BigInt(asset.amount),value:BigInt(asset.valueUsdcWad),price:{...asset.price}});
   else if(asset.valueUsdcWad===null){const basis=prior.get(id);if(basis)apply(asset,basis);}
  }
  return proofs;
 };
}
