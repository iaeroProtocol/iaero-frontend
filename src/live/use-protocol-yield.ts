import {useEffect,useState} from 'react';
import {validateYieldReport} from '../protocol-data/validate-report';
import {protocolDataUrl} from '../protocol-data/api';
import type {AnnualisedYield,YieldAsset,YieldClaim} from '../protocol-data/yield-model';
import {currentYieldDisplay,YIELD_REPORT_MAX_AGE_MS,yieldFreshness} from '../protocol-data/yield-freshness';
export type ProtocolYieldReport={asOfTimestamp?:number;status:string;positionId:string;createdAt:string;readAtMs:number|null;syncing?:boolean;syncUnavailable?:boolean;summary:{annualised?:AnnualisedYield;earnedPriceObservedAt?:number|null;historyComplete:boolean;receivedValueUsdcWad:string|null;receivedPartial:boolean;pendingValueUsdcWad:string|null;pendingPartial:boolean;receivedApy7d:number|null;earnedApy7d:number|null;apyUnavailableReason:string|null;receivedApyUnavailableReason?:string|null};chainTotals?:{chainId:number;name:string;pendingValueUsdcWad:string|null;pendingPartial:boolean;receivedValueUsdcWad?:string|null;receivedPartial?:boolean;unpricedTokens:{token:string;symbol:string}[];providers:number}[];chains:{name:string;chainId:number;providers:number;status:string;explorer:string;historyComplete?:boolean}[];assets:YieldAsset[];claims:YieldClaim[];storedClaims:number;storedObservations:number;errors:string[];sharedHistory?:boolean;receivedHistory?:{timestamp:number;from:number;to:number;claims:number;valueUsdcWad:string|null;partial:boolean}[]};
// Display cache only. Durable history and new observations remain on the shared
// service. Reports and their original price/report expiry times are unchanged.
let cachedReport:ProtocolYieldReport|undefined;
export function useProtocolYield(){
 const [data,setData]=useState<ProtocolYieldReport|undefined>(()=>cachedReport),[error,setError]=useState(false),[revision,setRevision]=useState(0),[clock,setClock]=useState(()=>Date.now());
 useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,running=false,failures=0;
  const schedule=(ms:number)=>{clearTimeout(timer);if(!controller.signal.aborted)timer=setTimeout(()=>void run(),ms);};
  const run=async()=>{
   if(controller.signal.aborted||running)return;if(document.hidden){schedule(5000);return;}running=true;let invalidReport=false;
   const attempt=new AbortController(),stop=()=>attempt.abort(),deadline=setTimeout(stop,8000);controller.signal.addEventListener('abort',stop,{once:true});
   try{
    const response=await fetch(protocolDataUrl('/api/protocol-yield'),{signal:attempt.signal,cache:'no-store'});if(!response.ok)throw Error();invalidReport=true;const report=validateYieldReport(await response.json()) as ProtocolYieldReport;invalidReport=false;
    if(!controller.signal.aborted){if(!cachedReport||(report.readAtMs??0)>=(cachedReport.readAtMs??0))cachedReport=report;setData(cachedReport);setError(false);failures=0;schedule(report.syncing?1000:60000);}
   }catch{if(!controller.signal.aborted){if(invalidReport){cachedReport=undefined;setData(undefined);}setError(true);schedule(Math.min(5000,1000*2**Math.min(failures++,3)));}}
   finally{clearTimeout(deadline);controller.signal.removeEventListener('abort',stop);running=false;}
  };
  const visible=()=>{if(!document.hidden)schedule(0);};document.addEventListener('visibilitychange',visible);void run();
  return()=>{controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
 },[revision]);
 useEffect(()=>{
  const tick=()=>setClock(Date.now()),deadline=data?yieldFreshness(data).nextDeadlineMs:null;
  const timer=deadline===null?undefined:setTimeout(tick,Math.max(1,Math.min(deadline-Date.now(),2147483647)));
  const visible=()=>{if(!document.hidden)tick();};document.addEventListener('visibilitychange',visible);window.addEventListener('focus',tick);
  return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',tick);};
 },[data,clock]);
 const now=Date.now(),view=data?currentYieldDisplay(data,now):undefined;
 const stale=!!data?.readAtMs&&now-data.readAtMs>YIELD_REPORT_MAX_AGE_MS,unknown=stale||!data?.readAtMs;
 return {data:view?.data,error,unknown,priceExpired:view?.priceExpired??false,pendingPricesExpired:view?.pendingPricesExpired??false,earnedPriceExpired:view?.earnedPriceExpired??false,refresh:()=>setRevision(n=>n+1)};
}
