import type {ReactNode} from 'react';
import {Icon,TokenIcon} from '../icons';
import {usePreview} from '../store';
import {activeRewardValue,portfolioRewardValue,valueText} from './reward-value';
import {useReadExpiry} from './use-retained-read';

export function RewardValueCard(){
  const s=usePreview(),l=s.live!,data=activeRewardValue(l);
  const unknownReads=!!l.error||!!l.rewardReadErrors||!!l.rewardSelectionError||!!l.boot?.rewardRegistryError||(l.historyMode==='all'&&!l.legacyDiscovery?.complete);
  const stale=useReadExpiry(data?.asOf);
  const partial=unknownReads||!!data?.unpriced||!!data?.pending;
  const value=stale||unknownReads&&!data?.priced?null:data?.totalWad;
  const label=stale?'Estimate expired':partial?'Partial USDC estimate':'Estimated reward value';
  return <div className="reward-value-card" role="region" aria-label="USDC value of selected rewards" aria-live="polite"><div className="reward-value-header"><span><TokenIcon token="USDC" size={25}/>{label}</span><button className="icon-button" aria-label="Refresh reward values" disabled={data?.loading||!l.readAt||!!l.error} onClick={s.liveControls!.refreshRewardValues}><Icon name="refresh" size={14}/></button></div><div className="reward-value-total"><strong>{valueText(value,!!data?.priced)}</strong><span>USDC</span>{data?.loading&&<span className="spinner"/>}</div><p>{stale?'Refresh values for a current estimate.':l.error||data?.refreshErrors?'Refresh delayed. Showing the last estimate with its original expiry.':data?.loading?`Pricing ${data.priced+data.unpriced} of ${data.priced+data.unpriced+data.pending} tokens…`:data?.unpriced?`${data.unpriced} token${data.unpriced===1?' has':'s have'} no USDC quote and ${data.unpriced===1?'is':'are'} excluded from this estimate.`:unknownReads?'Some selected rewards could not be read; the estimate is incomplete.':data?'Live estimate · before gas.':'Reward values appear after your balances are read.'}{data&&!data.loading&&data.priced>0&&!stale&&<> · {new Date(data.asOf).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</>}</p><small className="reward-value-footnote">USDC equivalent before gas. Claim all pays the original tokens.</small></div>;
}
export function TokenRewardValue({token}:{token:string}){
  const {live:l}=usePreview(),data=l?activeRewardValue(l):undefined,value=data?.values[token.toLowerCase()];
  const stale=useReadExpiry(value?.quotedAt);
  return <small className={'token-reward-value '+(value?.valueWad===null?'unpriced':'')} title={value?.source==='reference'?'Indicative value from a reference-size quote; the full reward amount may not be tradeable.':'Estimated USDC equivalent, before gas.'}>{!value?'Valuing…':stale?'Estimate expired':value.valueWad===null?'Unpriced':'≈ '+valueText(value.valueWad,true)+' USDC'}{value?.source==='reference'&&!stale&&' · indicative'}</small>;
}
export function PortfolioRewardValue({action}:{action?:ReactNode}){
  const {live:l}=usePreview(),value=portfolioRewardValue(l!);
  return <><h2>{valueText(value.valueWad,value.positive)} <small className="portfolio-usdc-unit">USDC</small></h2>{action}<p>{value.partial?'Partial estimate · selected rewards + AutoVault':'Selected staking rewards + AutoVault · estimated'}</p></>;
}
