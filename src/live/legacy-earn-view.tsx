import {Button,Info,Pill,TokenPair} from '../components';
import {Icon} from '../icons';
import {usePreview} from '../store';
import type {OpenPanel} from '../screens';
import type {Bootstrap} from './types';
import {BalanceAmount} from './exact-amount';
import {RewardTools} from './reward-tools';

// [owner 2026-11-02] Until the new pool is verified ready, Earn stakes through the
// existing previous-staking route (legacyStake and its guards). Loading, failed and
// unconfigured bootstraps stay here; only a verified-ready new pool returns NewEarn.
export const legacyEarnActive=(boot:Bootstrap|undefined)=>!boot?.newStackReady;
export function LegacyEarn({openPanel}:{openPanel:OpenPanel}){
 const s=usePreview(),l=s.live!,paused=l.legacyPaused??l.boot?.legacyPaused;
 const checking=!l.boot&&!l.error,blocked=checking?'Checking the staking pool on Base…':!l.boot?'Base contract data could not be read, so staking is unavailable. Refresh to retry.':!l.boot.legacyReady?'The current staking pool could not be verified on Base. Staking stays unavailable until it is; refresh to retry.':paused===true?'The current staking pool is paused on chain. New stakes are unavailable until it resumes.':undefined,reason=blocked??(s.connected?s.disabledReason('legacyStake'):undefined);
 return <div className="page-enter"><div className="page-title"><div><p className="eyebrow">PUT YOUR POSITION TO WORK</p><h1>Good things keep flowing.</h1><p>New staking is coming. Until it launches, staking uses the current iAERO staking pool (stiAERO). You can move to the new pool when it opens.</p></div><Pill tone={checking?'neutral':blocked?'amber':'blue'}>{checking?'Checking':blocked?'Staking unavailable':'Current pool'}</Pill></div><RewardTools openPanel={openPanel}/>
  <div className="earn-grid"><div className="card staking-card"><div className="staking-card-header"><TokenPair to="stiAERO"/><div><span className="small muted">iAERO → stiAERO</span><h2>Current iAERO staking</h2></div></div><p className="small muted">Stake iAERO from your wallet and receive stiAERO. Your portfolio lists this pool as Previous iAERO staking.</p>
  <div className="live-wallet-balance"><span>iAERO in your wallet</span><strong><BalanceAmount value={l.known.iaero?s.wallet.iaero:undefined} symbol="iAERO"/> <small>iAERO</small></strong></div><div className="form-details"><div><span>Your staked iAERO</span><strong><BalanceAmount value={l.known.legacyStake?s.wallet.legacyStake:undefined} symbol="iAERO"/> iAERO</strong></div><div><span>You receive</span><strong>stiAERO</strong></div><div><span>Rewards</span><strong>Claimed separately</strong></div></div>
  {reason&&<Info tone={blocked&&!checking?'amber':'neutral'}>{reason}</Info>}<Button className="full-width" disabled={!!blocked||(s.connected&&!!reason)} onClick={()=>s.connected?openPanel('legacyStake'):s.setWalletDialog(true)}>{checking?'Checking the staking pool…':blocked?'Staking unavailable':!s.connected?'Connect your wallet':'Stake iAERO'}</Button>
  <p className="form-footnote"><Icon name="shield" size={14}/>You approve only the reviewed amount if needed, then confirm the stake in your wallet.</p></div>
  <aside className="earn-aside"><article className="reward-card"><div className="reward-card-top"><p className="reward-label">YOUR STAKING REWARDS</p><span className="streaming-tag">Previous staking</span></div><p className="reward-overline">Claim and withdraw separately</p><p className="reward-subtitle">Claims pay the original reward tokens and leave your stake in place. Withdrawing iAERO is a separate choice.</p><Button className="claim-button" variant="secondary" onClick={()=>openPanel('legacy')}>Claim rewards</Button></article><Button variant="secondary" className="full-width" onClick={()=>openPanel('legacy')}>Withdraw staked iAERO</Button><Button variant="primary" className="full-width" onClick={()=>openPanel('liq')}>Claim LIQ rewards</Button><Button variant="secondary" className="full-width" onClick={()=>openPanel('liq')}>Manage LIQ staking</Button></aside></div></div>;
}
