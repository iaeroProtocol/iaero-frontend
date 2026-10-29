import {AsyncSection,RecoveryControls} from './async-section';
import {useEffect,useRef,useState} from 'react';
import {Button,Dialog,Info,Pill,TokenPair} from './components';
import {BrandMark,Icon,TokenIcon,type IconName} from './icons';
import {Earn,GetIaero,MigrationBanner,Overview,Portfolio,type OpenPanel} from './screens';
import {PreviewProvider,usePreview} from './store';
import {dollarText,mintPreview,numberText,sampleBuyPreview,tokenText,type Action,type Page} from './domain';
import {CollateralDialog} from './live/new-stack-view';
import {RiftBackground} from './live/rift-background';
import {LiveProvider} from './live/provider';
import {LiveLegacyDialog,LiveLegacyStakeDialog,LiveSweepDialog,LiveStatus,LiveTransactionDialog,LiveWalletDialog,shortAddress} from './live/views';

const loadLiq=()=>import('./live/liq-view');
const loadDeposit=()=>import('./live/deposit-view');
const pages:{key:Page;label:string;icon:IconName}[]=[{key:'overview',label:'Overview',icon:'globe'},{key:'earn',label:'Earn',icon:'layers'},{key:'deposit',label:'Deposit',icon:'plus'},{key:'get',label:'Get iAERO',icon:'swap'},{key:'portfolio',label:'Portfolio',icon:'wallet'}];

export function App(){return new URLSearchParams(window.location.search).get('demo')==='1'?<PreviewProvider><AppShell/></PreviewProvider>:<LiveProvider><AppShell/></LiveProvider>;}
const productionSite=import.meta.env.VITE_APP_STAGE==='production';
function AppShell(){
  const s=usePreview(),[panel,setPanel]=useState<Parameters<OpenPanel>[0]|null>(null),[controls,setControls]=useState(false);
  useEffect(()=>{
    const viewport=window.visualViewport;
    const resize=()=>document.documentElement.style.setProperty('--visual-viewport-height',(viewport?.height??window.innerHeight)+'px');
    resize();viewport?.addEventListener('resize',resize);
    return()=>{viewport?.removeEventListener('resize',resize);document.documentElement.style.removeProperty('--visual-viewport-height');};
  },[]);
  useEffect(()=>{document.querySelector('meta[name="theme-color"]')?.setAttribute('content',s.theme==='dark'?'#0a111e':'#f6f7f9');},[s.theme]);
  const openPanel:OpenPanel=p=>setPanel(p);
  return <div className="app">
    {s.mode==='live'&&<RiftBackground/>}
    <a className="skip-link" href="#main-content">Skip to content</a>
    {(!productionSite||s.mode==='demo')&&<div className="preview-ribbon"><div><span className="preview-tag"><span/>{s.mode==='live'?'LOCAL · LIVE BASE':productionSite?'DESIGN DEMO':'LOCAL PREVIEW'}</span><span className="preview-description">{s.mode==='live'?'Actual balances · Wallet-confirmed actions':'Sample data · Simulated actions'}</span>{s.mode==='demo'?<button onClick={()=>setControls(true)}>Preview controls <Icon name="chevron" size={12}/></button>:<a href="/?demo=1">Design demo <Icon name="up-right" size={12}/></a>}</div></div>}
    <header className="site-header"><div className="header-inner"><a className="brand" href="#overview" onClick={e=>{e.preventDefault();s.go('overview');}} aria-label="iAERO overview"><BrandMark/><span>iAERO<span className="wordmark-period">.</span></span></a>
      <nav className="desktop-nav" aria-label="Main navigation">{pages.map(p=><a key={p.key} href={'#'+p.key} aria-current={s.page===p.key?'page':undefined} className={s.page===p.key?'active':''} onClick={e=>{e.preventDefault();s.go(p.key);}}>{p.label}</a>)}</nav>
      <div className="header-actions"><a className="docs-link" href="https://docs.iaero.finance" target="_blank" rel="noreferrer">Docs <Icon name="up-right" size={13}/></a><button className="icon-button theme-toggle" aria-label={s.theme==='light'?'Switch to dark theme':'Switch to light theme'} onClick={s.toggleTheme}><Icon name={s.theme==='light'?'moon':'sun'} size={18}/></button><button className={'wallet-button '+(s.connected?'wallet-connected':'')} onClick={()=>s.setWalletDialog(true)}><Icon name="wallet" size={17}/><span>{s.connected?s.mode==='live'?shortAddress(s.live?.address):'Demo wallet':'Connect wallet'}</span>{s.connected&&<span className="wallet-connected-dot"/>}</button></div>
    </div></header>
    <main className="main-container" id="main-content" tabIndex={-1}>{s.mode==='live'&&<LiveStatus/>}{s.page==='overview'?<Overview openPanel={openPanel}/>:s.page==='earn'?<Earn openPanel={openPanel}/>:s.page==='deposit'?<AsyncSection name="Deposits" loader={loadDeposit} loading={<div className="card section-unavailable">Loading deposit availability…</div>}/>:s.page==='get'?<GetIaero openPanel={openPanel}/>:<Portfolio openPanel={openPanel}/>}</main>
    <footer className="site-footer"><div className="footer-inner"><div><BrandMark className="footer-mark"/><span>iAERO</span><small>A more liquid future.</small></div><nav aria-label="Resources"><a href="https://docs.iaero.finance" target="_blank" rel="noreferrer">Documentation <Icon name="up-right" size={12}/></a><a href="https://x.com/iaeroProtocol" target="_blank" rel="noreferrer">X / Twitter <Icon name="up-right" size={12}/></a><a href="https://discord.gg/YypP6DG3" target="_blank" rel="noreferrer">Discord <Icon name="up-right" size={12}/></a><a href="https://sweeper.iaero.finance" target="_blank" rel="noreferrer">Token Sweeper <Icon name="up-right" size={12}/></a><button onClick={()=>openPanel('legacy')}>Previous rewards</button></nav><span className="footer-copyright">© 2026 iAERO</span></div><div className="footer-preview">{s.mode==='live'?(productionSite?'':'Local contract-testing app · ')+'Base mainnet · Transactions require your wallet signature · '+(s.live?.boot?.newStackReady?'New stream readback verified':s.live?.boot?.deposit?.verified?'Deposit contract verified · New stream pending':'New contract connection pending'):'Design preview · Figures and rates are illustrative · No live wallet or blockchain connection'}</div></footer>
    <nav className="mobile-nav" aria-label="Mobile navigation">{pages.map(p=><a key={p.key} href={'#'+p.key} aria-current={s.page===p.key?'page':undefined} className={s.page===p.key?'active':''} onClick={e=>{e.preventDefault();s.go(p.key);}}><Icon name={p.icon} size={20}/><span>{p.label}</span></a>)}</nav>
    {s.toast&&<div className="toast" role="status"><span><Icon name="check" size={17}/></span><p>{s.toast}</p><button className="icon-button" aria-label="Dismiss notification" onClick={s.dismissToast}><Icon name="close" size={15}/></button></div>}
    {s.walletDialog&&(s.mode==='live'?<LiveWalletDialog/>:<WalletDialog/>)}
    {s.action&&!s.walletDialog&&(s.mode==='live'?<LiveTransactionDialog key={s.action.kind+s.action.amount.toString()+s.action.epoch+s.action.tokenAddress} action={s.action} onDone={()=>setPanel(s.action?.kind.startsWith('liq')?'liq':s.action?.kind.startsWith('collateral')?'receipt':s.action?.kind.startsWith('legacy')||s.action?.kind.startsWith('oldAuto')?'legacy':null)}/>:<TransactionDialog key={s.action.kind+s.action.amount.toString()} action={s.action} onContinueLegacy={()=>setPanel('legacy')}/>)}
    {panel&&!s.action&&!s.walletDialog&&<HelpPanel panel={panel} onClose={()=>setPanel(null)} openPanel={openPanel}/>}
    {controls&&<Dialog title="Your preview, your way." subtitle="Try different states without changing anything on chain." onClose={()=>setControls(false)} className="controls-dialog"><div className="preview-control-list"><Toggle label="Pause new deposits" description="Claims and principal withdrawals stay available." checked={s.flags.paused} onChange={value=>s.setFlags({...s.flags,paused:value})}/><Toggle label="Simulate a reward-read outage" description="Reward figures become unavailable. Principal stays accessible." checked={s.flags.rewardsUnavailable} onChange={value=>s.setFlags({...s.flags,rewardsUnavailable:value})}/></div><div className="preview-control-actions"><Button variant="secondary" onClick={()=>{s.reset();setControls(false);}} iconLeft="refresh">Reset sample balances</Button><Button onClick={()=>setControls(false)}>Done</Button></div><p className="small muted">NFT intake stays unavailable until its verified registration route is accepted. Real wallet connections are disabled in this preview.</p></Dialog>}
  </div>;
}

function Toggle({label,description,checked,onChange}:{label:string;description:string;checked:boolean;onChange:(value:boolean)=>void}){return <label className="toggle-row"><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" role="switch" checked={checked} onChange={e=>onChange(e.target.checked)}/><span className="toggle-track" aria-hidden="true"><span/></span></label>;}

function WalletDialog(){
  const s=usePreview();
  return <Dialog title={s.connected?'Your demo wallet.':'Meet your new iAERO.'} subtitle={s.connected?'A little space to explore. All balances stay on this device.':'Try the complete experience with a sample portfolio.'} onClose={()=>s.setWalletDialog(false)}>
    <div className="demo-wallet-visual"><span className="demo-wallet-orbit"/><span className="demo-wallet-token"><TokenIcon token="iAERO" size={74}/></span><span className="demo-wallet-label"><span className="status-dot"/> Sample wallet · Base</span></div>
    <div className="demo-wallet-balances"><div><span>Liquid iAERO</span><strong>{tokenText(s.wallet.iaero)}</strong></div><div><span>Staked iAERO</span><strong>{tokenText(s.wallet.staked)}</strong></div><div><span>Earned USDC</span><strong>{tokenText(s.wallet.earned,6)}</strong></div></div>
    {s.connected?<div className="wallet-dialog-actions"><Button variant="secondary" onClick={()=>{s.disconnect();s.setWalletDialog(false);}}>Disconnect demo</Button><Button onClick={()=>s.setWalletDialog(false)}>Back to the app</Button></div>:<Button className="full-width" icon="arrow" onClick={s.connect} data-autofocus>Use demo wallet</Button>}
    <p className="wallet-privacy"><Icon name="shield" size={15}/>No real funds. No wallet signature. Just a local preview.</p>
  </Dialog>;
}

function TransactionDialog({action,onContinueLegacy}:{action:Action;onContinueLegacy:()=>void}){
  const s=usePreview(),[phase,setPhase]=useState<'review'|'approving'|'approved'|'submitting'|'done'>('review'),[error,setError]=useState('');
  const lock=useRef(false),busy=phase==='submitting'||phase==='approving';
  const isClaim=['claim','autoClaim','legacyClaim'].includes(action.kind),isLegacy=action.kind.startsWith('legacy');
  const amount=isClaim?action.kind==='claim'?s.wallet.earned:action.kind==='autoClaim'?s.wallet.autoEarned:s.wallet.legacyRewards:action.kind==='legacyWithdraw'?s.wallet.legacyStake:action.amount;
  const token=isClaim||action.kind==='buy'?'USDC':action.kind==='mint'?'AERO':'iAERO';
  const received=action.kind==='mint'?mintPreview(action.amount).received:action.kind==='buy'?sampleBuyPreview(action.amount).received:amount;
  const receivedToken=isClaim?'USDC':action.kind==='stake'?'stiAERO':action.kind==='autoStake'?'vault shares':'iAERO';
  const close=()=>{if(!busy)s.setAction(null);};
  const confirm=async()=>{
    if(lock.current)return;lock.current=true;setError('');
    try{
      if(action.approval&&phase==='review'){
        setPhase('approving');await new Promise(resolve=>setTimeout(resolve,450));setPhase('approved');
      }else{setPhase('submitting');await s.execute(action);setPhase('done');}
    }catch(e){setError((e as Error).message);setPhase(action.approval?'approved':'review');}finally{lock.current=false;}
  };
  return <Dialog title={phase==='done'?'A good move.':action.title} subtitle={phase==='done'?'Your sample balances have been updated locally.':action.description} onClose={close} busy={busy} className="transaction-dialog">
    {phase==='done'?<><div className="transaction-success"><span><Icon name="check" size={36}/></span><h3>Simulation complete</h3><p>No real tokens moved. Your activity is saved in this preview.</p></div><Button className="full-width" icon="arrow" onClick={()=>{s.setAction(null);if(isLegacy)onContinueLegacy();}}>{isLegacy?'Continue your transition':'Back to the app'}</Button></>:<>
      <span className="simulation-label"><Icon name="spark" size={13}/>Local simulation · no signature requested</span>
      <div className="transaction-amount"><TokenIcon token={token} size={46}/><strong>{tokenText(amount,token==='USDC'?6:18,4)}</strong><span>{token}</span></div>
      <div className="transaction-summary"><div><span>From</span><strong>{action.source}</strong></div><div><span>To</span><strong>{action.target}</strong></div><div><span>{isClaim?'Estimated USDC claim':'You receive'}</span><strong>{tokenText(received,isClaim?6:18,4)} {receivedToken}</strong></div>{action.kind==='mint'&&<div><span>Protocol mint fee</span><strong>5% · {tokenText(mintPreview(amount).fee)} AERO</strong></div>}<div><span>Network</span><strong><span className="base-mark"/> Base · simulated</strong></div></div>
      {action.approval&&<div className="transaction-progress"><div className={phase==='review'||phase==='approving'?'active':'complete'}><span>{phase==='review'||phase==='approving'?'1':<Icon name="check" size={12}/>}</span><strong>Approve exact amount</strong><small>{phase==='approving'?'Simulating…':phase==='review'?'First step':'Complete'}</small></div><div className={phase==='approved'||phase==='submitting'?'active':''}><span>2</span><strong>Confirm {action.kind==='mint'?'deposit':action.kind==='buy'?'swap':'stake'}</strong><small>Separate action</small></div></div>}
      {error&&<p role="alert" className="form-error">{error}</p>}
      <Button className="full-width" disabled={busy} icon={busy?undefined:'arrow'} onClick={()=>void confirm()}>{busy?<><span className="spinner"/>{phase==='approving'?'Simulating approval…':'Updating sample balances…'}</>:action.approval&&phase==='review'?'Simulate exact approval':'Confirm simulation'}</Button><p className="form-footnote"><Icon name="shield" size={13}/>{isClaim?'Claiming leaves your principal in place.':'Your balance and route are checked again before completion.'}</p>
    </>}
  </Dialog>;
}

function HelpPanel({panel,onClose,openPanel}:{panel:Parameters<OpenPanel>[0];onClose:()=>void;openPanel:OpenPanel}){
  const s=usePreview();
  if(['sweep','compound','claimSweep','claimCompound','liqSweep','liqCompound'].includes(panel)&&s.mode==='live')return <LiveSweepDialog intent={{mode:['sweep','claimSweep','liqSweep'].includes(panel)?'USDC':'stake',claimFirst:!['sweep','compound'].includes(panel),source:panel.startsWith('liq')?'liq':'all'}} onClose={onClose}/>;
  if(panel==='legacyStake'&&s.mode==='live')return <LiveLegacyStakeDialog onClose={onClose}/>;
  if(panel==='legacy'&&s.mode==='live')return <LiveLegacyDialog onClose={onClose}/>;
  if(panel==='legacy')return <Dialog title="The next chapter of your stake." subtitle="A clear path forward. Your old rewards stay yours." onClose={onClose} className="legacy-dialog">
    <Pill tone="neutral">Previous staking → USDC stream</Pill>
    {!s.connected?<><p className="dialog-body-copy">Claim your old rewards, withdraw your iAERO, then stake in the new stream. Each step is a separate transaction. Old rewards remain claimable after withdrawal.</p><Button className="full-width" onClick={()=>{onClose();s.setWalletDialog(true);}} icon="arrow">Explore with a demo wallet</Button></>:<div className="legacy-steps">
      <div className="legacy-step"><span className={s.wallet.legacyRewards===0n?'complete':''}>{s.wallet.legacyRewards===0n?<Icon name="check" size={16}/>:'1'}</span><div><h3>Keep what you earned</h3><p>{tokenText(s.wallet.legacyRewards,6)} USDC in your sample old-reward selection.</p><Button variant="secondary" disabled={s.wallet.legacyRewards===0n} onClick={()=>s.setAction({kind:'legacyClaim',amount:s.wallet.legacyRewards,title:'Claim previous USDC',description:'Selected old USDC rewards return to your wallet. Your old stake is unaffected.',source:'Previous reward selection',target:'Your demo wallet',approval:false})}>{s.wallet.legacyRewards===0n?'Selected USDC claimed':'Claim selected old USDC'}</Button></div></div>
      <div className="legacy-step"><span className={s.wallet.legacyStake===0n?'complete':''}>{s.wallet.legacyStake===0n?<Icon name="check" size={16}/>:'2'}</span><div><h3>Bring your iAERO with you</h3><p>{tokenText(s.wallet.legacyStake)} iAERO in your old staking position.</p><Button variant="secondary" disabled={s.wallet.legacyStake===0n} onClick={()=>s.setAction({kind:'legacyWithdraw',amount:s.wallet.legacyStake,title:'Withdraw previous stake',description:'Your old iAERO principal returns to your wallet. Unclaimed old rewards remain claimable afterward.',source:'Previous staking position',target:'Your demo wallet',approval:false})}>{s.wallet.legacyStake===0n?'Old stake withdrawn':'Withdraw old iAERO'}</Button></div></div>
      <div className="legacy-step"><span>3</span><div><h3>Start the new stream</h3><p>Approve your exact iAERO amount and stake in the new USDC stream.</p><Button icon="arrow" onClick={()=>{onClose();s.go('earn');}}>Go to new staking</Button></div></div>
    </div>}<Info>Other legacy tokens and older reward periods remain claimable. Withdrawing your principal does not erase your earned rewards.</Info>
  </Dialog>;
  if(panel==='receipt'&&s.mode==='live')return <CollateralDialog onClose={onClose}/>;
  if(panel==='receipt')return <Dialog title="Your stake, made transferable." subtitle="A little clarity on iAERO, stiAERO and your rewards." onClose={onClose}><div className="receipt-explainer"><TokenPair from="iAERO" to="stiAERO"/><h3>1 stiAERO represents 1 staked iAERO.</h3><p>Stake iAERO to receive stiAERO. Redeem the receipt to withdraw the corresponding iAERO.</p><p>Transferring stiAERO moves the withdrawal rights and future USDC rewards. USDC you already earned stays claimable by you.</p><Info tone="blue">For supported lending integrations, use the designated wstiAERO wrapper. Arbitrary pools, bridges and contracts may not be able to claim rewards from a raw stiAERO receipt.</Info></div><Button className="full-width" onClick={onClose}>Got it</Button></Dialog>;
  if(panel==='liq'&&s.mode==='live')return <AsyncSection name="LIQ staking and rewards" loader={loadLiq} componentProps={{onClose,onSweep:(mode:'USDC'|'stake')=>openPanel(mode==='USDC'?'liqSweep':'liqCompound')}} loading={<Dialog title="LIQ staking" onClose={onClose}><p role="status">Loading your LIQ controls…</p></Dialog>} renderError={retry=><Dialog title="LIQ controls could not load." onClose={onClose}><RecoveryControls name="LIQ staking and rewards" retry={retry}/></Dialog>}/>;
  if(panel==='liq')return <Dialog title="A place for your LIQ." subtitle="Your existing LIQ tokens and staking continue separately." onClose={onClose}><div className="liq-visual"><TokenIcon token="LIQ" size={64}/><h3>{s.connected&&(s.mode==='demo'||s.live?.known.liq)?tokenText(s.wallet.liq):'—'} LIQ</h3><p>{s.mode==='live'?'Actual Base wallet balance':s.connected?'Sample wallet balance':'Connect the demo wallet to see a sample balance.'}</p></div><p className="dialog-body-copy">LIQ emissions depend on the current schedule. The new USDC staking stream does not replace the existing LIQ staking program or change its withdrawal rules.</p><a className="button button-primary full-width" href="https://app.iaero.finance" target="_blank" rel="noreferrer">Open current iAERO app <Icon name="up-right" size={16}/></a><p className="form-footnote">Opens the existing app in a new tab.</p></Dialog>;
  return <Dialog title="A more liquid way to participate." subtitle="Permanent backing. Transferable tokens. USDC rewards." onClose={onClose} className="how-dialog"><div className="learn-steps"><div><TokenIcon token="AERO" size={42}/><span><h3>Start with AERO or iAERO</h3><p>Buy liquid iAERO on the market, or deposit AERO into the permanent protocol position. Minting carries a 5% protocol fee.</p></span></div><div><TokenIcon token="stiAERO" size={42}/><span><h3>Stake iAERO, receive stiAERO</h3><p>Your receipt represents your iAERO principal and future USDC earnings. Unstake to receive your iAERO back.</p></span></div><div><TokenIcon token="USDC" size={42}/><span><h3>Protocol revenue, in USDC</h3><p>Rewards flow over time while the stream is funded. Claim whenever you choose; rates vary with protocol revenue.</p></span></div></div><Info>AERO deposited into the vault is permanent. iAERO is liquid and transferable, but cannot be redeemed for the underlying AERO.</Info><Button className="full-width" icon="arrow" onClick={()=>{onClose();s.go('earn');}}>Explore the earning experience</Button></Dialog>;
}
