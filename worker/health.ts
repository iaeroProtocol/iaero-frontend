export function historyHealth(report:any,legacy:any,enabled:boolean,now=Date.now()){
 const fresh=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value<=now+60000&&now-value<=900000;
 const recorderFresh=fresh(report?.readAtMs),claimHistoryComplete=report?.summary?.historyComplete===true,legacyIndexComplete=legacy?.complete===true&&fresh(legacy?.readAtMs),independentCoverageComplete=report?.summary?.independentCoverageComplete===true;
 const pricedPendingComplete=report?.summary?.pendingPartial!==true;
 const partial=!!report?.errors?.length||!claimHistoryComplete||!legacyIndexComplete||!pricedPendingComplete;
 const status=!enabled?'disabled':!recorderFresh?'stale':partial?'partial':independentCoverageComplete?'ok':'limited';
 return {status,healthy:enabled&&recorderFresh&&!partial,collectorEnabled:enabled,lastObservationAt:report?.readAtMs??null,claimHistoryComplete,legacyIndexComplete,independentCoverageComplete,pricedPendingComplete};
}
