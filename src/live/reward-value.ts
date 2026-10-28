import {formatUnits,type Address} from 'viem';
import {groupRewards,type RewardGroup} from './rewards';
import type {RewardLeg} from '../domain';
import type {LiveState} from './types';

export type RewardTokenValue={token:Address;amount:bigint;valueWad:bigint|null;source:'usdc'|'quote'|'reference'|'unavailable';quotedAt:number};
export type RewardValuation={key:string;values:Record<string,RewardTokenValue>;totalWad:bigint|null;priced:number;unpriced:number;pending:number;loading:boolean;asOf:number;refreshErrors?:number};
export function rewardValueKey(address:string|undefined,chainId:number|undefined,rows:readonly RewardLeg[],date:string,customToken:string,readable:boolean){return JSON.stringify([address?.toLowerCase(),chainId,date,customToken,readable,groupRewards(rows).map(g=>[g.token.toLowerCase(),g.amount.toString(),g.decimals])]);}
export const liveValueKey=(state:LiveState)=>rewardValueKey(state.address,state.chainId,state.rewards,state.selectedDate,state.customToken,!!state.readAt);
export const activeRewardValue=(state:LiveState)=>state.rewardValuation?.key===liveValueKey(state)?state.rewardValuation:undefined;
export function portfolioRewardValue(state:LiveState){
  const data=activeRewardValue(state),stale=!!data&&Date.now()-data.asOf>120000;
  const unknownReads=!!state.error||!!state.rewardReadErrors||!!state.rewardSelectionError||!!state.boot?.rewardRegistryError||(state.historyMode==='all'&&!state.legacyDiscovery?.complete);
  const partial=!data||stale||data.loading||!!data.unpriced||!!data.pending||unknownReads||state.oldAutoEarned===undefined;
  const positive=!!data?.priced&&!stale||(state.oldAutoEarned??0n)>0n;
  const known=positive||!!data&&!partial&&data.totalWad!==null;
  return {valueWad:known?(!stale?data?.totalWad??0n:0n)+(state.oldAutoEarned??0n)*10n**12n:null,partial,positive};
}
export function valuationSnapshot(key:string,groups:readonly RewardGroup[],values:Record<string,RewardTokenValue>,loading:boolean):RewardValuation{
  let total=0n,priced=0,unpriced=0,pending=0,asOf=Date.now();
  for(const group of groups){const value=values[group.token.toLowerCase()];if(!value){pending++;continue;}if(value.valueWad===null){unpriced++;continue;}priced++;total+=value.valueWad;asOf=Math.min(asOf,value.quotedAt);}
  return {key,values:{...values},totalWad:priced||!groups.length?total:null,priced,unpriced,pending,loading,asOf};
}
export async function priceRewards(key:string,rows:readonly RewardLeg[],usdc:Address,onUpdate:(value:RewardValuation)=>void,signal:AbortSignal,fetcher:typeof fetch=fetch,previous?:RewardValuation){
  const groups=groupRewards(rows),values:Record<string,RewardTokenValue>={};
  const fresh=(v:RewardTokenValue|undefined)=>!!v&&v.valueWad!==null&&Number.isSafeInteger(v.quotedAt)&&Date.now()-v.quotedAt<=120000&&v.quotedAt<=Date.now()+5000;
  if(previous?.key===key)for(const g of groups){const v=previous.values[g.token.toLowerCase()];if(v?.amount===g.amount&&fresh(v))values[g.token.toLowerCase()]=v;}
  for(const g of groups)if(g.token.toLowerCase()===usdc.toLowerCase())values[g.token.toLowerCase()]={token:g.token,amount:g.amount,valueWad:g.amount*10n**12n,source:'usdc',quotedAt:Date.now()};
  let next=0,refreshErrors=0;const publish=(loading:boolean)=>onUpdate({...valuationSnapshot(key,groups,values,loading),...(refreshErrors?{refreshErrors}:{})});
  publish(true);
  // Cached estimates stabilize the display; every non-USDC value is still refreshed.
  const work=groups.filter(g=>g.token.toLowerCase()!==usdc.toLowerCase());
  await Promise.all(Array.from({length:Math.min(3,work.length)},async()=>{
    while(next<work.length&&!signal.aborted){const g=work[next++];let value:RewardTokenValue;
      let transient=true;
      try{
        const params=new URLSearchParams({token:g.token,amount:g.amount.toString()});if(g.decimals!==null)params.set('decimals',String(g.decimals));
        const r=await fetcher('/api/rewards/value?'+params,{cache:'no-store',signal});if(!r.ok)throw Error('Reward value request unavailable.');transient=false;const data=await r.json();
        if(!r.ok||String(data.token).toLowerCase()!==g.token.toLowerCase()||data.amount!==g.amount.toString()||data.valueWad!==null&&!/^\d{1,180}$/.test(String(data.valueWad))||!['quote','reference','unavailable'].includes(data.source)||!Number.isSafeInteger(data.quotedAt)||Date.now()-data.quotedAt>120000||data.quotedAt>Date.now()+5000)throw Error('Unknown reward value.');
        if((data.valueWad===null)!==(data.source==='unavailable'))throw Error('Unknown reward value.');
        value={token:g.token,amount:g.amount,valueWad:data.valueWad===null?null:BigInt(data.valueWad),source:data.source,quotedAt:data.quotedAt};
      }catch{refreshErrors++;const cached=values[g.token.toLowerCase()];value=transient&&fresh(cached)?cached:{token:g.token,amount:g.amount,valueWad:null,source:'unavailable',quotedAt:Date.now()};}
      if(signal.aborted)return;values[g.token.toLowerCase()]=value;publish(true);
    }
  }));
  if(!signal.aborted)publish(false);
}
export function valueText(value:bigint|null|undefined,positive=false){
  if(value===null||value===undefined)return '—';if((value>0n||positive)&&value<10n**12n)return '< 0.000001';
  return Number(formatUnits(value,18)).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:value<10n**16n?6:2});
}
