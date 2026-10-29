import {useState} from 'react';
import type {RewardLeg} from '../domain';
import {Button,Info} from '../components';
import {usePreview} from '../store';
import {publicBaseClient} from './client';
import {groupRewards,previewRewardClaims,type RewardClaimPlan} from './rewards';
import {useRetainedRead} from './use-retained-read';
import {ExactAmount} from './exact-amount';
import './legacy-claim-review.css';

export function useLegacyClaimPlan(rows:readonly RewardLeg[]|undefined){
 const s=usePreview(),l=s.live!,[client]=useState(()=>s.liveControls?.readClient?.()??publicBaseClient()),[revision,setRevision]=useState(0);
 const key=rows?.length&&l.address&&l.chainId===8453&&l.boot?.legacyReady?JSON.stringify([l.address.toLowerCase(),l.chainId,l.boot.registry.legacy.epochDistributor.toLowerCase(),rows.map(r=>[r.token.toLowerCase(),r.epoch.toString(),r.amount.toString(),r.decimals,r.symbol])]):undefined;
 const reading=useRetainedRead<RewardClaimPlan>(key,revision,()=>previewRewardClaims(client,l.boot!.registry.legacy.epochDistributor,l.address!,rows!,l.boot),{maxAgeMs:120000});
 return {...reading,ready:!!reading.data&&!reading.reading&&!reading.error&&!reading.expired,recheck:()=>setRevision(n=>n+1)};
}
export function LegacyClaimAvailability({reading,disabled=false}:{reading:ReturnType<typeof useLegacyClaimPlan>;disabled?:boolean}){
 const plan=reading.error||reading.expired&&!disabled?undefined:reading.data,available=plan?groupRewards(plan.eligible).length:0;
 return <div className="legacy-claim-availability" aria-label="Previous reward payout availability">
  {reading.reading&&<p role="status" className="small muted">Checking reward balances and simulating the claim…</p>}
  {reading.error&&<p role="alert" className="form-error">{reading.error}</p>}
  {reading.expired&&!disabled&&<Info tone="amber">The payout check expired. Recheck availability before claiming.</Info>}
  {reading.expired&&disabled&&<p className="small muted" role="status">Finish the active step before rechecking payouts. Each claim batch is checked again before a wallet request.</p>}
  {plan&&plan.blocked.length>0&&<Info tone="amber"><strong>{available} reward token{available===1?'':'s'} can be claimed now. {plan.blocked.length} {plan.blocked.length===1?'stays':'stay'} unclaimed.</strong><p>A displayed entitlement does not guarantee that the distributor can pay it. The unavailable rewards below are excluded from this transaction.</p><details><summary>View {plan.blocked.length} unavailable reward token{plan.blocked.length===1?'':'s'}</summary>{plan.blocked.map(r=><div className="legacy-claim-blocked-token" key={r.token}><strong>{r.symbol} <a href={'https://basescan.org/address/'+r.token} target="_blank" rel="noreferrer">{r.token.slice(0,6)}…{r.token.slice(-4)} ↗</a></strong><p>Previewed: <ExactAmount value={r.amount} decimals={r.decimals}/>{r.balance!==undefined&&<> · Available at distributor: <ExactAmount value={r.balance} decimals={r.decimals}/></>}</p><p>{r.reason==='insufficient-balance'?'The distributor holds less than this selection requires. This reward remains unclaimed.':'The reward transfer did not pass simulation. This reward remains unclaimed.'}</p></div>)}</details></Info>}
  {plan&&plan.eligible.length===0&&plan.blocked.length===0&&!reading.reading&&<Info>The selected rewards are already settled. Refresh the history; no transaction is needed.</Info>}
  <Button variant="ghost" disabled={disabled||reading.reading} onClick={reading.recheck}>{reading.reading?'Checking availability…':'Recheck payout availability'}</Button>
 </div>;
}
