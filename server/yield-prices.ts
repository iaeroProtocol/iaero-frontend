// [VERIFIED: keeper/src/prices.ts and DefiLlama free API price documentation]
// Pending prices are current estimates. Claimed income only uses a price at
// its historical receipt time; current-price fallbacks are never permitted.
import type {YieldAsset,YieldClaim} from '../src/protocol-data/yield-model.ts';
export type PriceSource={id:string;symbol:string};
export type PricePolicy={endpoint:string;maxAgeSeconds:number;maxFutureSeconds:number;minConfidence:number;usdcSource:PriceSource;assets:{chainId:number;token:string;decimals:number;symbol:string;sources:PriceSource[]}[]};
export type PriceProof={source:string;timestamp:number;confidence:number|null;priceUsdWad:string;usdcSource:string;usdcTimestamp:number;usdcPriceUsdWad:string;kind:'current-estimate'|'historical-estimate'};
const E18=10n**18n;
function wad(n:number):bigint|null{
 if(!Number.isFinite(n)||n<=0||n>1e12)return null;
 // Convert the decimal/exponent representation to integer precision.
 const [mantissa,exp='0']=String(n).toLowerCase().split('e'),[whole,fraction='']=mantissa.split('.'),digits=BigInt(whole+fraction),shift=18+Number(exp)-fraction.length;
 const value=shift>=0?digits*10n**BigInt(shift):digits/10n**BigInt(-shift);return value>0n?value:null;
}
export function validPrice(coin:any,source:PriceSource,policy:PricePolicy,time:number){
 if(!coin||typeof coin.symbol!=='string'||coin.symbol.toUpperCase()!==source.symbol.toUpperCase()||typeof coin.price!=='number'||!Number.isSafeInteger(coin.timestamp))return null;
 if(time-coin.timestamp>policy.maxAgeSeconds||coin.timestamp-time>policy.maxFutureSeconds)return null;
 if(coin.confidence!==undefined&&coin.confidence!==null&&(typeof coin.confidence!=='number'||!Number.isFinite(coin.confidence)||coin.confidence<policy.minConfidence||coin.confidence>1))return null;
 const price=wad(coin.price);return price===null?null:{price,timestamp:coin.timestamp as number,confidence:typeof coin.confidence==='number'?coin.confidence:null};
}
export async function priceYieldAssets(assets:YieldAsset[],policy:PricePolicy,options:{time?:number;historical?:boolean;fetchImpl?:typeof fetch}={}){
 const time=options.time??Math.floor(Date.now()/1000),fetcher=options.fetchImpl??fetch,proofs=new Map<string,PriceProof>();
 const slugs:Record<number,string>={8453:'base',1:'ethereum',4663:'robinhood',42161:'arbitrum'};
 const candidates=assets.filter(a=>a.valueUsdcWad===null&&a.decimals!==null).map(asset=>({asset,rule:policy.assets.find(r=>r.chainId===asset.chainId&&r.token.toLowerCase()===asset.token.toLowerCase()&&r.decimals===asset.decimals&&r.symbol.toUpperCase()===asset.symbol.toUpperCase())??(slugs[asset.chainId]?{chainId:asset.chainId,token:asset.token,decimals:asset.decimals,symbol:asset.symbol,sources:[{id:slugs[asset.chainId]+':'+asset.token,symbol:asset.symbol}]}:undefined)})).filter(a=>a.rule);
 if(!candidates.length)return proofs;
 const ids=[...new Set([policy.usdcSource.id,...candidates.flatMap(c=>c.rule!.sources.map(s=>s.id))])],coins=new Map<string,any>();
 for(let i=0;i<ids.length;i+=60){
  try{const u=new URL(policy.endpoint);if(u.protocol!=='https:'||!['coins.llama.fi','api.llama.fi'].includes(u.hostname))throw Error('yield_price_host');
   u.pathname=(options.historical?'/prices/historical/'+time:'/prices/current')+'/'+ids.slice(i,i+60).map(encodeURIComponent).join(',');
   const r=await fetcher(u.href,{headers:{accept:'application/json'},signal:AbortSignal.timeout(12000)});if(!r.ok)continue;const data=await r.json();if(!data?.coins||typeof data.coins!=='object')continue;for(const [id,coin] of Object.entries(data.coins))coins.set(id.toLowerCase(),coin);
  }catch{/* Unknown remains unknown; one failed chunk does not erase others. */}
 }
 const usdc=validPrice(coins.get(policy.usdcSource.id.toLowerCase()),policy.usdcSource,policy,time);if(!usdc)return proofs;
 for(const {asset,rule} of candidates){for(const source of rule!.sources){const p=validPrice(coins.get(source.id.toLowerCase()),source,policy,time);if(!p)continue;
   asset.valueUsdcWad=(BigInt(asset.amount)*p.price*E18/(10n**BigInt(asset.decimals!)*usdc.price)).toString();
   asset.price={source:'price-feed',observedAt:Math.min(p.timestamp,usdc.timestamp),reference:source.id,carriedForward:false};
   proofs.set(asset.chainId+':'+asset.token.toLowerCase(),{source:source.id,timestamp:p.timestamp,confidence:p.confidence,priceUsdWad:p.price.toString(),usdcSource:policy.usdcSource.id,usdcTimestamp:usdc.timestamp,usdcPriceUsdWad:usdc.price.toString(),kind:options.historical?'historical-estimate':'current-estimate'});break;}}
 return proofs;
}
export async function historicalClaimPrice(claim:YieldClaim,policy:PricePolicy,fetchImpl?:typeof fetch){
 if(claim.recipientRecognised===false||claim.decimals===null)return null;
 const asset:YieldAsset={chainId:claim.chainId,token:claim.token,amount:claim.amount,decimals:claim.decimals,symbol:claim.symbol,valueUsdcWad:null};
 const proofs=await priceYieldAssets([asset],policy,{time:claim.timestamp,historical:true,fetchImpl});const proof=proofs.get(claim.chainId+':'+claim.token.toLowerCase());return proof&&asset.valueUsdcWad!==null?{valueUsdcWad:asset.valueUsdcWad,proof}:null;
}
