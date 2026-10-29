import {Icon,type IconName} from '../icons';
import {usePreview} from '../store';
import type {OpenPanel} from '../screens';

export function RewardTools({openPanel}:{openPanel:OpenPanel}){
 const s=usePreview(),b=s.live?.boot;
 const tools:{panel:'liq'|'claimCompound'|'claimSweep';title:string;note:string;icon:IconName;available:boolean}[]=[
  {panel:'liq',title:'Claim LIQ rewards',note:'Rewards from your staked LIQ',icon:'gift',available:true},
  {panel:'claimCompound',title:'Claim & compound',note:'Claim rewards → AERO → iAERO · optional stake',icon:'layers',available:!!b?.sweepReady&&!!b?.aeroCompoundReady},
  {panel:'claimSweep',title:'Claim & sweep to USDC',note:'Claim rewards and convert in one guided flow',icon:'swap',available:!!b?.sweepReady},
 ];
 return <section className="reward-tools" aria-label="Reward tools">{tools.map(t=><button key={t.panel} className="reward-tool" aria-label={t.title} disabled={s.connected&&!t.available} title={s.connected&&!t.available?'This conversion route could not be verified. Refresh to retry.':undefined} onClick={()=>s.connected?openPanel(t.panel):s.setWalletDialog(true)}><span className="reward-tool-icon"><Icon name={t.icon} size={20}/></span><span><strong>{t.title}</strong><small>{t.note}</small></span><Icon name="arrow" size={17}/></button>)}</section>;
}
