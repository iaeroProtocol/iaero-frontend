import {useEffect,useState} from 'react';
import {validateYieldReport} from '../protocol-data/validate-report';
import {protocolDataUrl} from '../protocol-data/api';
import type {AnnualisedYield,YieldAsset,YieldClaim} from '../protocol-data/yield-model';
import {currentYieldDisplay,YIELD_REPORT_MAX_AGE_MS,yieldFreshness} from '../protocol-data/yield-freshness';
export type ProtocolYieldReport={asOfTimestamp?:number;status:string;positionId:string;createdAt:string;readAtMs:number|null;syncing?:boolean;syncUnavailable?:boolean;summary:{annualised?:AnnualisedYield;earnedPriceObservedAt?:number|null;historyComplete:boolean;receivedValueUsdcWad:string|null;receivedPartial:boolean;pendingValueUsdcWad:string|null;pendingPartial:boolean;receivedApy7d:number|null;earnedApy7d:number|null;apyUnavailableReason:string|null;receivedApyUnavailableReason?:string|null};chainTotals?:{chainId:number;name:string;pendingValueUsdcWad:string|null;pendingPartial:boolean;receivedValueUsdcWad?:string|null;receivedPartial?:boolean;unpricedTokens:{token:string;symbol:string}[];providers:number}[];chains:{name:string;chainId:number;providers:number;status:string;explorer:string;historyComplete?:boolean}[];assets:YieldAsset[];claims:YieldClaim[];storedClaims:number;storedObservations:number;errors:string[];sharedHistory?:boolean;receivedHistory?:{timestamp:number;from:number;to:number;claims:number;valueUsdcWad:string|null;partial:boolean}[]};
export function useProtocolYield(){
 const [data,setData]=useState<ProtocolYieldReport>(),[error,setError]=useState(false),[revision,setRevision]=useState(0),[clock,setClock]=useState(()=>Date.now());
 useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const run=async()=>{if(document.hidden){timer=setTimeout(()=>void run(),5000);return;}
   try{const response=await fetch(protocolDataUrl('/api/protocol-yield'),{signal:controller.signal});if(!response.ok)throw Error();const report=validateYieldReport(await response.json());if(!controller.signal.aborted){setData(report);setError(false);timer=setTimeout(()=>void run(),report.syncing?5000:60000);}}
   catch{if(!controller.signal.aborted){setError(true);timer=setTimeout(()=>void run(),30000);}}
  };void run();return()=>{controller.abort();clearTimeout(timer);};
 },[revision]);
 useEffect(()=>{
  const tick=()=>setClock(Date.now()),deadline=data?yieldFreshness(data).nextDeadlineMs:null;
  const timer=deadline===null?undefined:setTimeout(tick,Math.max(1,Math.min(deadline-Date.now(),2147483647)));
  const visible=()=>{if(!document.hidden)tick();};document.addEventListener('visibilitychange',visible);window.addEventListener('focus',tick);
  return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',tick);};
 },[data,clock]);
 const now=Date.now(),view=data?currentYieldDisplay(data,now):undefined;
 const stale=!!data?.readAtMs&&now-data.readAtMs>YIELD_REPORT_MAX_AGE_MS,unknown=stale||error||!data?.readAtMs;
 return {data:view?.data,error,unknown,priceExpired:view?.priceExpired??false,pendingPricesExpired:view?.pendingPricesExpired??false,earnedPriceExpired:view?.earnedPriceExpired??false,refresh:()=>setRevision(n=>n+1)};
}
