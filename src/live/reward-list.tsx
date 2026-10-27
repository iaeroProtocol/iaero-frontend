import {useState} from 'react';
import {formatUnits} from 'viem';
import {Button} from '../components';
import {Icon,TokenIcon} from '../icons';
import {usePreview} from '../store';
import {claimAction,groupRewards} from './rewards';
import {RewardValueCard,TokenRewardValue} from './reward-value-view';
import {ExactAmount} from './exact-amount';

const amount=(n:bigint,d:number|null)=>d===null?n.toString()+' raw units':formatUnits(n,d);
const date=(epoch:bigint)=>new Date(Number(epoch)*1000).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
export function RewardSummary({rows}:{rows:Parameters<typeof groupRewards>[0]}){return <div className="claim-token-summary">{groupRewards(rows).map(r=><div key={r.token}><span><TokenIcon token={r.symbol} size={24}/>{r.symbol}</span><ExactAmount value={r.amount} decimals={r.decimals}/></div>)}</div>;}
export function RewardList(){
  const s=usePreview(),l=s.live!,groups=groupRewards(l.rewards),reason=s.disabledReason('legacyClaimMany');
  const [error,setError]=useState('');
  const review=(rows:typeof l.rewards,all=false)=>{try{setError('');s.setAction(claimAction(rows,all));}catch(e){setError((e as Error).message);}};
  return <><RewardValueCard/><div className="claim-all-toolbar"><div><strong>{groups.length} reward token{groups.length===1?'':'s'}</strong><span>Aggregated across the selected weeks</span></div><Button iconLeft="gift" disabled={!!reason||l.loading||!groups.length} onClick={()=>review(l.rewards,true)}>Claim all</Button></div>{error&&<p className="form-error" role="alert">{error}</p>}
    <div className="legacy-reward-list aggregated-reward-list" aria-live="polite">{groups.length?groups.map(r=><div className="reward-token-group" key={r.token}><div className="legacy-reward-row"><TokenIcon token={r.symbol} size={32}/><div><strong title={r.token}>{r.symbol}</strong><small>{r.legs.length} reward week{r.legs.length===1?'':'s'} · {BigInt(r.token)===0n?'Native ETH':<a href={'https://basescan.org/address/'+r.token} title={r.token} target="_blank" rel="noreferrer">{r.token.slice(0,6)}…{r.token.slice(-4)} ↗</a>}</small></div><div className="legacy-reward-amount"><div className="reward-token-figures"><ExactAmount value={r.amount} decimals={r.decimals}/><TokenRewardValue token={r.token}/></div><Button variant="secondary" disabled={!!reason||l.loading} onClick={()=>s.setAction(claimAction(r.legs))}>Claim</Button></div></div><details className="reward-week-details"><summary>View reward weeks <Icon name="chevron" size={10}/></summary>{r.legs.map(leg=><div key={leg.epoch.toString()}><span>Week of {date(leg.epoch)}</span><strong>{amount(leg.amount,r.decimals)}</strong><button className="text-link" disabled={!!reason||l.loading} onClick={()=>s.setAction({kind:'legacyClaim',amount:leg.amount,tokenAddress:leg.token,tokenSymbol:leg.symbol,tokenDecimals:leg.decimals,epoch:leg.epoch,title:'Claim '+leg.symbol+' for one week',description:'Claim this specific reward week. Your other rewards and principal stay in place.',source:'Previous reward week',target:'Your connected wallet',approval:false})}>Claim week</button></div>)}</details></div>):<div className="legacy-no-rewards"><Icon name="gift" size={24}/><p>{l.loading?'Reading selected reward weeks…':l.readAt?'No positive rewards found in the successful reads for this selection.':'Waiting for your reward reads.'}</p><small>Choose an earlier date or add another token to look further back.</small></div>}</div></>;
}
