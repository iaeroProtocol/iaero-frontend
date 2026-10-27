import {acceptedReadCoverage,type ReadCoverage} from '../src/protocol-data/read-coverage.ts';
import policy from '../config/liq-yield.json' with {type:'json'};
import yieldPolicy from '../config/protocol-yield.json' with {type:'json'};
import {priceYieldAssets} from './yield-prices.ts';
import type {Bootstrap} from '../src/live/types.ts';
const E18=10n**18n,word=(v:unknown):v is string=>typeof v==='string'&&/^\d{1,78}$/.test(v)&&BigInt(v)<2n**256n;
export type LiqYieldReport={readCoverage?:ReadCoverage;status:'estimated'|'unavailable';aprPct:number|null;reason:string|null;readAtMs:number;asOfBlock:string;chainTimestamp:number;readProviders:number;forecastUpdatedAt:string|null;forecastEpochStart:number|null;forecastMaxAgeSeconds:number;weeklyProtocolUsdWad:string|null;weeklyLiqUsdcWad:string|null;totalStaked:string|null;stakedValueUsdcWad:string|null;liqPriceUsdcWad:string|null;usdcPriceUsdWad:string|null;revenueShareBps:number;annualWeeks:number;sourceUrl:string};
// [VERIFIED: old useStaking.calculateLiqStakingAPR; TreasuryDistributor.LIQ_SHARE_BPS]
// Keep the published forecast method as APR, not compounded or actually received APY.
export function calculateLiqApr(weeklyUsd:bigint,totalStaked:bigint,liqPriceUsdc:bigint,usdcPriceUsd:bigint,decimals=18){
 if(weeklyUsd<0n||totalStaked<0n||liqPriceUsdc<=0n||usdcPriceUsd<=0n||!Number.isInteger(decimals)||decimals<0||decimals>36)throw Error('LIQ yield inputs unavailable.');
 const weeklyLiqUsdc=weeklyUsd*BigInt(policy.revenueShareBps)/10000n*E18/usdcPriceUsd,stakedValueUsdc=totalStaked*liqPriceUsdc/10n**BigInt(decimals);
 if(totalStaked>0n&&stakedValueUsdc===0n)throw Error('LIQ staking value is below the calculation precision.');
 const aprPct=stakedValueUsdc===0n?0:Number(weeklyLiqUsdc*BigInt(policy.annualWeeks)*E18/stakedValueUsdc)/1e18*100;if(!Number.isFinite(aprPct))throw Error('LIQ yield is outside the supported range.');return {aprPct,weeklyLiqUsdc,stakedValueUsdc};
}
export function readWeeklyForecast(data:any,now:number){
 const updated=typeof data?.updatedAt==='string'?Date.parse(data.updatedAt):NaN;
 if(!Number.isFinite(updated)||updated>now+60000||now-updated>policy.forecastMaxAgeSeconds*1000)throw Error('The published weekly forecast is unavailable or older than seven days.');
 if(!Number.isSafeInteger(data.epochStart)||data.epochStart<0||data.epochStart*1000>updated+60000||updated-data.epochStart*1000>7*86400000+3600000)throw Error('The forecast week could not be verified.');
 let weekly:bigint;if(data.estimatedWeeklyUSD_1e18!==undefined){if(!word(data.estimatedWeeklyUSD_1e18))throw Error('Invalid weekly forecast.');weekly=BigInt(data.estimatedWeeklyUSD_1e18);}else{if(!word(data.stakersWeeklyUSD_1e18)||data.splitBps?.stakers!==undefined&&data.splitBps.stakers!==policy.stakersShareBps)throw Error('Invalid weekly forecast.');weekly=BigInt(data.stakersWeeklyUSD_1e18)*10000n/BigInt(policy.stakersShareBps);}
 return {weekly,updatedAt:new Date(updated).toISOString(),epochStart:data.epochStart};
}
export async function loadLiqYield(boot:Bootstrap,options:{fetchImpl?:typeof fetch;now?:number}={}):Promise<LiqYieldReport>{
 const now=options.now??Date.now(),fetcher=options.fetchImpl??fetch,m=boot.metrics.market,totals=boot.metrics.liqStaking;
 const out:LiqYieldReport={readCoverage:boot.readCoverage,status:'unavailable',aprPct:null,reason:null,readAtMs:now,asOfBlock:boot.snapshot.block,chainTimestamp:boot.snapshot.timestamp,readProviders:boot.snapshot.independentProviders,forecastUpdatedAt:null,forecastEpochStart:null,forecastMaxAgeSeconds:policy.forecastMaxAgeSeconds,weeklyProtocolUsdWad:null,weeklyLiqUsdcWad:null,totalStaked:totals?.totalStaked??null,stakedValueUsdcWad:null,liqPriceUsdcWad:m?.liqPriceUsdcWad??null,usdcPriceUsdWad:null,revenueShareBps:policy.revenueShareBps,annualWeeks:policy.annualWeeks,sourceUrl:policy.forecastUrl};
 try{
  if(!boot.liqStakingReady||!totals||!word(totals.totalStaked)||!acceptedReadCoverage(boot.snapshot.independentProviders,boot.readCoverage))throw Error('Verified LIQ staking totals are unavailable.');
  if(totals.paused!==false)throw Error('LIQ staking is paused.');
  if(!m||!acceptedReadCoverage(m.readProviders,boot.readCoverage)||now-m.readAtMs>120000||m.readAtMs>now+60000||!word(m.liqPriceUsdcWad)||BigInt(m.liqPriceUsdcWad)<=0n||m.liqDecimals===null)throw Error('A current verified LIQ price is unavailable.');
  const asset={chainId:8453,token:boot.registry.legacy.USDC,amount:'1000000',decimals:6,symbol:'USDC',valueUsdcWad:null as string|null};
  const [forecast,proofs]=await Promise.all([
   (async()=>{const response=await fetcher(policy.forecastUrl,{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('The published weekly forecast is unavailable.');return readWeeklyForecast(await response.json(),now);})(),
   priceYieldAssets([asset],yieldPolicy.pricing,{time:Math.floor(now/1000),fetchImpl:fetcher})
  ]);
  Object.assign(out,{forecastUpdatedAt:forecast.updatedAt,forecastEpochStart:forecast.epochStart,weeklyProtocolUsdWad:forecast.weekly.toString()});
  const usdc=proofs.get('8453:'+asset.token.toLowerCase());if(!usdc)throw Error('The USD-to-USDC reference price is unavailable.');
  const rate=calculateLiqApr(forecast.weekly,BigInt(totals.totalStaked),BigInt(m.liqPriceUsdcWad!),BigInt(usdc.usdcPriceUsdWad),m.liqDecimals!);
  return {...out,status:'estimated',reason:null,aprPct:rate.aprPct,weeklyLiqUsdcWad:rate.weeklyLiqUsdc.toString(),stakedValueUsdcWad:rate.stakedValueUsdc.toString(),usdcPriceUsdWad:usdc.usdcPriceUsdWad};
 }catch(error){out.reason=error instanceof Error&&!/https?:|request|details:/i.test(error.message)?error.message:'The LIQ yield estimate is temporarily unavailable.';return out;}
}
let cached:{at:number;value:LiqYieldReport}|undefined,active:Promise<LiqYieldReport>|undefined;
export async function liqYield(bootstrap:()=>Promise<Bootstrap>){if(cached&&Date.now()-cached.at<60000)return cached.value;active??=bootstrap().then(boot=>loadLiqYield(boot)).then(value=>{cached={at:Date.now(),value};return value;}).finally(()=>{active=undefined;});return active;}
