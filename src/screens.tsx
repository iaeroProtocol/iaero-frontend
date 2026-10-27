import {OverviewDashboard} from './live/overview-dashboard';
import {LiqYieldCard} from './live/liq-yield-view';
import {ProtocolTransparency} from './live/transparency';
import {useState} from 'react';
import {Button,EmptyWallet,Info,OrbitalScene,Pill,RevenueChart,SectionHeading,SegmentedTabs,TokenPair} from './components';
import {Icon,TokenIcon} from './icons';
import {usePreview} from './store';
import {amountText,dollarText,mintPreview,numberText,parseAmount,SAMPLE_APR_BPS,SAMPLE_IAERO_PRICE,sampleBuyPreview,tokenText,UNIT,type Action,type ActionKind} from './domain';
import {LiveEarn,LiveGet,LivePortfolio,LiveProtocolStats,LiveRewardCard} from './live/views';

export type OpenPanel=(panel:'how'|'legacy'|'liq'|'receipt')=>void;

function PortfolioStats(){const s=usePreview();if(s.mode==='live')return <LiveProtocolStats/>;return <div className="protocol-stats" aria-label="Illustrative protocol statistics">
  <div><span>Permanent AERO backing <Icon name="shield" size={14}/></span><strong>4.85<span>M</span><small>AERO</small></strong><p><span className="mini-dot"/>One permanent position</p></div>
  <div><span>Total iAERO staked <Icon name="layers" size={14}/></span><strong>3.72<span>M</span><small>iAERO</small></strong><p>Working across the Aero ecosystem</p></div>
  <div><span>Staking APR <Icon name="chart" size={14}/></span><strong>22.64<span>%</span><small className="positive">Variable</small></strong><p>Annualized sample stream rate</p></div>
  <div><span>Rewards distributed <Icon name="gift" size={14}/></span><strong>1.24<span>M</span><small>USDC</small></strong><p>Illustrative cumulative rewards</p></div>
</div>;}

export function MigrationBanner({openPanel}:{openPanel:OpenPanel}){
  const {connected,wallet,mode}=usePreview();
  if(mode==='live')return <div className="migration-banner"><span className="migration-icon"><Icon name="swap" size={21}/></span><div><strong>Your previous rewards stay yours.</strong><p>Read your legacy stake, claim selected rewards, or withdraw principal separately.</p></div><button className="text-link" onClick={()=>openPanel('legacy')}>Previous staking & rewards <Icon name="arrow" size={17}/></button></div>;
  if(connected&&wallet.legacyStake===0n&&wallet.legacyRewards===0n)return null;
  return <div className="migration-banner"><span className="migration-icon"><Icon name="swap" size={21}/></span><div><strong>{connected?'A new home for your existing stake.':'Already part of iAERO?'}</strong><p>{connected?`${tokenText(wallet.legacyStake)} iAERO in your old position. Your old rewards stay claimable.`:'Move your existing stake to the new USDC stream. Keep access to your old rewards.'}</p></div><button className="text-link" onClick={()=>openPanel('legacy')}>{connected?'Move your stake':'Explore the transition'}<Icon name="arrow" size={17}/></button></div>;
}

export function RewardCard({compact=false,strategy='direct'}:{compact?:boolean;strategy?:'direct'|'auto'}){
  const {connected,wallet,flags,setWalletDialog,setAction,go,mode}=usePreview();
  if(mode==='live')return <LiveRewardCard/>;
  const earned=strategy==='auto'?wallet.autoEarned:wallet.earned;
  const claim=()=>setAction({kind:strategy==='auto'?'autoClaim':'claim',amount:earned,title:strategy==='auto'?'Claim AutoVault USDC':'Claim USDC',description:'Your earned USDC goes to your connected wallet. Your stake stays in place.',source:strategy==='auto'?'AutoVault USDC rewards':'USDC reward stream',target:'Your demo wallet',approval:false});
  return <article className={'reward-card '+(compact?'reward-card-compact':'')}>
    <div className="reward-card-top"><span className="reward-label"><TokenIcon token="USDC" size={30}/>{strategy==='auto'?'AUTOVAULT REWARDS':'YOUR REWARDS'}</span><span className="streaming-tag"><span/>Streaming</span></div>
    {connected?<><p className="reward-overline">Available to claim</p><div className="reward-value" aria-label="Claimable USDC">{flags.rewardsUnavailable?'—':earned>0n&&earned<100n?'< 0.0001':tokenText(earned,6,4)}<span>USDC</span></div><p className="reward-subtitle">Earned by your iAERO. Ready when you are.</p><Button className="claim-button" variant="secondary" icon="arrow" onClick={claim} disabled={flags.rewardsUnavailable||earned===0n}>Claim USDC</Button><div className="reward-detail"><span><span className="status-dot"/> {flags.rewardsUnavailable?'Reward feed unavailable':'Accruing while the stream is funded'}</span><button onClick={()=>go('earn')} aria-label="Manage your stake"><Icon name="up-right" size={16}/></button></div></>:<><p className="reward-overline">Your stake. Your stream.</p><h3>Real rewards.<br/>In USDC.</h3><p className="reward-subtitle">Stake iAERO to receive a share of protocol revenue, streamed over time.</p><Button className="claim-button" variant="secondary" icon="arrow" onClick={()=>setWalletDialog(true)}>Explore your rewards</Button><div className="reward-detail"><span><span className="status-dot"/> Claim whenever you choose</span></div></>}
  </article>;
}

export function Overview({openPanel}:{openPanel:OpenPanel}){const {mode}=usePreview();return mode==='live'?<OverviewDashboard openPanel={openPanel}/>:<OriginalOverview openPanel={openPanel}/>;}

function OriginalOverview({openPanel}:{openPanel:OpenPanel}){
  const {go,mode,connected,setWalletDialog,live}=usePreview();
  return <div className="page-enter">
    <div className="overview-kicker"><span>LIQUID BY DESIGN.</span><span className="ecosystem-label"><span className="base-mark"/>BUILT ON BASE</span></div>
    <section className="hero" aria-label="The next chapter of iAERO"><div className="hero-grid"/><div className="hero-copy"><div className="hero-eyebrow"><span className="hero-eyebrow-line"/> THE NEXT CHAPTER OF iAERO</div><h1>Stay liquid.<br/><span>Earn in USDC.</span></h1><p>Your AERO, with more possibilities.<br/>Liquid iAERO. Continuous rewards. One simple experience.</p><div className="hero-buttons"><Button onClick={()=>mode==='demo'?go('earn'):connected?live?.boot?.newStackReady?go('earn'):openPanel('legacy'):setWalletDialog(true)} icon="arrow">{mode==='live'?connected?'Manage rewards':'Connect your wallet':'Start earning'}</Button><button className="hero-learn" onClick={()=>openPanel('how')}>How it works <span>↗</span></button></div><div className="hero-footnote"><span className="hero-mini-token">A</span><span>Aero-powered. Base-built.</span></div></div><OrbitalScene/><div className="hero-coordinate" aria-hidden="true">LIQUIDITY WITHOUT LIMITS</div></section>
    <PortfolioStats/>
    <SectionHeading title="A clearer picture of your yield." eyebrow="THE PROTOCOL, AT A GLANCE"><span className="sample-caption">{mode==='live'?'Live Base contract data':'Illustrative protocol data'} <Icon name="info" size={13}/></span></SectionHeading>
    <div className="overview-main-grid"><RevenueChart/>{mode==='live'?<div className="overview-side-stack"><RewardCard compact/><LiqYieldCard compact onManage={()=>openPanel('liq')}/></div>:<RewardCard compact/>}</div>
    {mode==='live'&&<ProtocolTransparency/>}
    <SectionHeading title="Your next move." eyebrow="MAKE IT YOURS"><button className="text-link" onClick={()=>openPanel('how')}>Get to know iAERO <Icon name="up-right" size={15}/></button></SectionHeading>
    <div className="product-grid">
      <button className="product-card" onClick={()=>go('get')}><span className="product-card-icon mint-icon"><Icon name="swap" size={23}/></span><Icon className="product-arrow" name="up-right" size={19}/><h3>Get liquid iAERO</h3><p>Buy on the market or deposit AERO. Choose the route that works for you.</p><span className="product-card-link">Find your route <Icon name="arrow" size={15}/></span></button>
      <button className="product-card product-card-featured" onClick={()=>go('earn')}><span className="product-card-icon earn-icon"><Icon name="layers" size={23}/></span><Icon className="product-arrow" name="up-right" size={19}/><h3>Put iAERO to work</h3><p>Stake your iAERO and receive a share of protocol revenue in USDC.</p><span className="product-card-link">Explore staking <Icon name="arrow" size={15}/></span></button>
      <button className="product-card" onClick={()=>go('portfolio')}><span className="product-card-icon portfolio-icon"><Icon name="wallet" size={23}/></span><Icon className="product-arrow" name="up-right" size={19}/><h3>See the whole picture</h3><p>Your tokens, staking positions and rewards. All in one considered space.</p><span className="product-card-link">Your portfolio <Icon name="arrow" size={15}/></span></button>
    </div>
    <MigrationBanner openPanel={openPanel}/>
  </div>;
}

function AmountInput({value,onChange,balance,token='iAERO',decimals=18}:{value:string;onChange:(value:string)=>void;balance:bigint;token?:string;decimals?:number}){
  const {connected}=usePreview();
  return <div className="amount-box"><div className="amount-topline"><label htmlFor="transaction-amount">You {token==='iAERO'?'use':'pay'}</label><span>{connected?<>Balance: {tokenText(balance,decimals)} <button onClick={()=>onChange(amountText(balance,decimals))}>MAX</button></>:'Connect to see balance'}</span></div><div className="amount-input-row"><input id="transaction-amount" aria-label={`${token} amount`} inputMode="decimal" autoComplete="off" placeholder="0.00" value={value} onChange={e=>onChange(e.target.value)}/><span className="input-token"><TokenIcon token={token} size={27}/>{token}</span></div><div className="amount-bottomline"><span>{value&&/^\d+(\.\d*)?$/.test(value)?`≈ $${numberText(Number(value)*(token==='USDC'?1:token==='AERO'?0.644:0.6112))}`:'Enter your amount'}</span><div className="amount-shortcuts">{[25,50,100].map(p=><button key={p} disabled={!connected||balance===0n} onClick={()=>onChange(amountText(balance*BigInt(p)/100n,decimals))}>{p===100?'Max':p+'%'}</button>)}</div></div></div>;
}

export function Earn({openPanel}:{openPanel:OpenPanel}){
  const {wallet,connected,flags,setWalletDialog,setAction,mode:appMode}=usePreview();
  const [mode,setMode]=useState<'stake'|'unstake'>('stake'),[strategy,setStrategy]=useState<'direct'|'auto'>('direct'),[amount,setAmount]=useState('');
  if(appMode==='live')return <LiveEarn openPanel={openPanel}/>;
  const staked=strategy==='direct'?wallet.staked:wallet.autoStaked,balance=mode==='stake'?wallet.iaero:staked;
  let parsed=0n,error='';try{if(amount)parsed=parseAmount(amount);}catch(e){error=(e as Error).message;}
  if(parsed>balance&&connected)error='This amount exceeds your available balance.';
  const paused=flags.paused&&mode==='stake';
  const actionKind:ActionKind=strategy==='direct'?mode==='stake'?'stake':'unstake':mode==='stake'?'autoStake':'autoUnstake';
  const submit=()=>{
    if(!connected){setWalletDialog(true);return;}
    if(error||!parsed||paused)return;
    setAction({kind:actionKind,amount:parsed,title:mode==='stake'?strategy==='auto'?'Deposit in AutoVault':'Stake iAERO':strategy==='auto'?'Withdraw from AutoVault':'Unstake iAERO',description:mode==='stake'?'Your iAERO starts earning from the USDC stream. You can withdraw your iAERO later.':'Your iAERO returns to your wallet. Earned USDC remains claimable separately.',source:mode==='stake'?'Your demo wallet':strategy==='direct'?'Your staking position':'Your AutoVault position',target:mode==='stake'?strategy==='direct'?'USDC staking stream':'Replacement AutoVault':'Your demo wallet',approval:mode==='stake'});
  };
  return <div className="page-enter"><div className="page-title"><div><p className="eyebrow">PUT YOUR POSITION TO WORK</p><h1>Good things keep flowing.</h1><p>Stake iAERO. Receive USDC. Keep it simple.</p></div><Pill tone="blue" dot>Streaming rewards</Pill></div>
    <div className="earn-grid"><div className="card staking-card"><div className="staking-card-header"><TokenPair/><div><span className="small muted">iAERO → USDC</span><h2>{strategy==='direct'?'iAERO staking':'USDC AutoVault'}</h2></div><span className="apr-badge">22.64%<small>Sample APR</small></span></div>
      <div className="strategy-selector" aria-label="Staking route"><button aria-pressed={strategy==='direct'} onClick={()=>{setStrategy('direct');setAmount('');}}>Direct staking</button><button aria-pressed={strategy==='auto'} onClick={()=>{setStrategy('auto');setAmount('');}}>AutoVault <span>USDC</span></button></div>
      <SegmentedTabs id="staking-action" label="Staking action" className="form-tabs" value={mode} options={[{value:'stake',label:'Stake'},{value:'unstake',label:'Unstake'}]} onChange={m=>{setMode(m);setAmount('');}}/><div className="staking-panel" role="tabpanel" id="staking-action-panel" aria-labelledby={'staking-action-'+mode}>
      {flags.paused&&<Info tone="amber">New staking is paused. You can still unstake and claim your USDC.</Info>}
      <AmountInput value={amount} onChange={setAmount} balance={balance}/>
      {error&&<p role="alert" className="form-error">{error}</p>}
      <div className="receive-row"><span>You receive</span><strong><TokenIcon token={mode==='stake'?'stiAERO':'iAERO'} size={23}/>{parsed?tokenText(parsed):'0.00'} {mode==='stake'?strategy==='direct'?'stiAERO':'vault shares':'iAERO'}</strong></div>
      <div className="form-details"><div><span>Network</span><strong><span className="base-mark"/> Base</strong></div><div><span>Staking fee</span><strong>0%</strong></div><div><span>Withdrawals</span><strong>Available anytime</strong></div><div><span>Rewards paid in</span><strong><TokenIcon token="USDC" size={17}/> USDC</strong></div></div>
      <Button className="full-width" icon="arrow" disabled={connected&&(paused||!!error||parsed<=0n)} onClick={submit}>{!connected?'Connect to get started':paused?'New staking is paused':mode==='stake'?'Review stake':'Review unstake'}</Button>
      <p className="form-footnote"><Icon name="shield" size={13}/>{strategy==='direct'?'Your receipt represents your staked iAERO.':'AutoVault earns from the same USDC stream; it does not auto-compound iAERO.'}</p>
    </div></div><div className="earn-aside"><RewardCard strategy={strategy}/><div className="receipt-card"><span className="receipt-icon"><Icon name="layers" size={23}/></span><div><strong>{strategy==='direct'?'Liquid, even when staked.':'One vault. Your share.'}</strong><p>{strategy==='direct'?'stiAERO represents your staked iAERO. Your already-earned USDC stays yours.':'AutoVault holds the staking receipt. Your internal shares are non-transferable; withdraw them for iAERO. Claim USDC separately.'}</p><button className="text-link" onClick={()=>openPanel('receipt')}>{strategy==='direct'?'Understand your receipt':'How the underlying receipt works'} <Icon name="up-right" size={14}/></button></div></div>
      {flags.rewardsUnavailable&&<Info tone="amber">Reward information is unavailable in this scenario. Your principal is still visible and withdrawable.</Info>}
    </div></div>
    <MigrationBanner openPanel={openPanel}/><div className="earning-steps"><div><span>01</span><strong>Get iAERO</strong><p>Buy or deposit AERO.</p></div><Icon name="arrow"/><div><span>02</span><strong>Stake your position</strong><p>Receive your staking receipt.</p></div><Icon name="arrow"/><div><span>03</span><strong>Receive USDC</strong><p>Claim rewards on your terms.</p></div></div>
  </div>;
}

export function GetIaero({openPanel}:{openPanel:OpenPanel}){
  const {wallet,connected,flags,setWalletDialog,setAction,mode}=usePreview();
  const [route,setRoute]=useState<'buy'|'mint'|'nft'>('buy'),[amount,setAmount]=useState(''),[ack,setAck]=useState(false),[nft,setNft]=useState(''),[inspected,setInspected]=useState(false);
  if(mode==='live')return <LiveGet openPanel={openPanel}/>;
  let parsed=0n,error='',received=0n,fee=0n;
  const balance=route==='buy'?wallet.usdc:wallet.aero,token=route==='buy'?'USDC':'AERO',decimals=route==='buy'?6:18;
  try{if(amount){parsed=parseAmount(amount,decimals);const quote=route==='buy'?sampleBuyPreview(parsed):mintPreview(parsed);received=quote.received;fee=quote.fee;}}catch(e){error=(e as Error).message;}
  if(connected&&parsed>balance)error='This amount exceeds your available balance.';
  const changeRoute=(r:typeof route)=>{setRoute(r);setAmount('');setAck(false);setInspected(false);};
  const submit=()=>{
    if(!connected){setWalletDialog(true);return;}
    if(!parsed||error||route==='mint'&&(!ack||flags.paused))return;
    setAction({kind:route==='buy'?'buy':'mint',amount:parsed,title:route==='buy'?'Buy iAERO':'Deposit AERO',description:route==='buy'?'This sample quote exchanges demo USDC for liquid iAERO. It is not a live market quote.':'Your AERO joins the permanent protocol backing. You receive liquid iAERO after the 5% mint fee. Deposited AERO cannot be redeemed.',source:'Your demo wallet',target:route==='buy'?'Sample market route':'Permanent AERO backing',approval:true});
  };
  return <div className="page-enter"><div className="page-title"><div><p className="eyebrow">YOUR ROUTE TO LIQUIDITY</p><h1>More ways to get iAERO.</h1><p>Buy on the market or add to permanent AERO backing.</p></div><Pill tone="neutral">One liquid token</Pill></div>
    <div className="get-grid"><div className="card get-card"><div className="get-card-title"><h2>Get iAERO</h2><span className="network-label"><span className="base-mark"/>Base</span></div><SegmentedTabs id="get-route" label="Get iAERO route" className="route-tabs" value={route} options={[{value:'buy',label:'Buy iAERO'},{value:'mint',label:'Deposit AERO'},{value:'nft',label:'Deposit NFT'}]} onChange={changeRoute}/><div className="get-panel" role="tabpanel" id="get-route-panel" aria-labelledby={'get-route-'+route}>
      {route!=='nft'?<><AmountInput value={amount} onChange={setAmount} balance={balance} token={token} decimals={decimals}/><div className="conversion-connector"><Icon name="arrow" size={17}/></div><div className="output-box"><span>You receive</span><div><strong>{received?tokenText(received):'0.00'}</strong><span className="input-token"><TokenIcon token="iAERO" size={27}/>iAERO</span></div><p>Liquid and transferable</p></div>{error&&<p role="alert" className="form-error">{error}</p>}
      <div className="form-details"><div><span>{route==='buy'?'Sample price':'Mint rate, before fee'}</span><strong>{route==='buy'?'1 iAERO ≈ $0.6112':'1 AERO → 1 iAERO'}</strong></div><div><span>{route==='buy'?'Sample routing fee (0.35%)':'Protocol mint fee (5%)'}</span><strong>{fee?tokenText(fee,decimals):'0.00'} {token}</strong></div><div><span>Destination</span><strong>Your wallet</strong></div></div>
      {route==='mint'&&<label className="acknowledgement"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/><span>I understand that AERO deposits are permanent. I can trade my iAERO, but cannot redeem it for AERO.</span></label>}
      {route==='mint'&&flags.paused&&<Info tone="amber">New AERO deposits are paused. Existing staking withdrawals and claims remain available.</Info>}
      <Button className="full-width" icon="arrow" disabled={connected&&(!!error||!parsed||route==='mint'&&(!ack||flags.paused))} onClick={submit}>{!connected?'Connect to get started':route==='buy'?'Review sample swap':'Review AERO deposit'}</Button><p className="form-footnote"><Icon name="info" size={13}/>{route==='buy'?'Sample quote for local testing. No live market route is connected.':'Deposit fees support the protocol. LIQ rewards depend on the emissions schedule.'}</p></>:<>
        <div className="nft-illustration"><span className="nft-ticket"><TokenIcon token="AERO" size={54}/><span>sAERO POSITION</span><strong>#{nft||'2048'}</strong><small>A permanent position. A liquid future.</small></span><span className="nft-ticket-back"/></div>
        <Info tone="amber">Public NFT intake is awaiting its verified registration route. Liquid AERO deposits use a separate route.</Info>
        <label className="field-label" htmlFor="nft-id">Your converted sAERO NFT ID</label><div className="nft-input"><span>#</span><input id="nft-id" inputMode="numeric" placeholder="Enter NFT ID" value={nft} onChange={e=>{setNft(e.target.value);setInspected(false);}}/></div>
        {inspected&&<Info tone="blue">{nft==='2048'?'Sample NFT #2048 holds 1,500 AERO. A live quote must verify ownership, voting allocations, registration and all fees.':'Use sample NFT #2048 to inspect the preview. No ownership is claimed for other IDs.'}</Info>}
        <Button variant="secondary" className="full-width" disabled={!/^\d+$/.test(nft)} onClick={()=>setInspected(true)} icon="arrow">Preview NFT checks</Button>
        <div className="nft-requirements"><p><Icon name="check" size={14}/>Convert your veAERO through Aero first.</p><p><Icon name="check" size={14}/>Remove all voting allocations before intake.</p><p><Icon name="check" size={14}/>No blanket NFT approval. The empty source NFT returns to you.</p></div>
      </>}
    </div></div><aside className="get-aside"><div className="how-card"><div className="how-card-top"><span className="eyebrow">THE iAERO WAY</span><Icon name="spark" size={21}/></div><h2>Permanent backing.<br/>Liquid possibilities.</h2><p>One position at the protocol level. More freedom in your wallet.</p><div className="how-flow"><div><TokenIcon token="AERO" size={40}/><span><strong>AERO</strong><small>Permanent protocol backing</small></span><span className="flow-number">01</span></div><span className="flow-vertical"/><div><TokenIcon token="iAERO" size={40}/><span><strong>iAERO</strong><small>Your liquid, transferable token</small></span><span className="flow-number">02</span></div><span className="flow-vertical"/><div><TokenIcon token="USDC" size={40}/><span><strong>USDC</strong><small>Protocol revenue, when you stake</small></span><span className="flow-number">03</span></div></div><button className="text-link" onClick={()=>openPanel('how')}>Explore how it works <Icon name="up-right" size={15}/></button></div>
      <div className="route-advice"><Icon name="info" size={19}/><div><h3>A little clarity goes a long way.</h3><p>Market prices can differ from backing value. Compare the amount of iAERO you receive, including fees, before choosing a route.</p></div></div></aside></div>
  </div>;
}

export function Portfolio({openPanel}:{openPanel:OpenPanel}){
  const {wallet,connected,go,activities,flags,mode}=usePreview();
  if(mode==='live')return <LivePortfolio openPanel={openPanel}/>;
  if(!connected)return <div className="page-enter"><div className="page-title"><div><p className="eyebrow">A SPACE FOR YOUR POSITION</p><h1>See everything, clearly.</h1><p>One view of your tokens, your stake and your USDC rewards.</p></div></div><div className="card portfolio-empty"><EmptyWallet/></div></div>;
  const equivalent=wallet.iaero+wallet.staked+wallet.autoStaked+wallet.legacyStake;
  return <div className="page-enter"><div className="page-title"><div><p className="eyebrow">A SPACE FOR YOUR POSITION</p><h1>Your position, at a glance.</h1><p>A little less complexity. A lot more clarity.</p></div><Pill tone="blue" dot>Demo wallet connected</Pill></div>
    <div className="portfolio-metrics"><article className="card"><span>Your iAERO position</span><h2>{dollarText(equivalent*SAMPLE_IAERO_PRICE/UNIT)}</h2><p>{tokenText(equivalent)} iAERO equivalent <span>· sample valuation</span></p></article><article className="card"><span>USDC rewards to claim</span><h2>{flags.rewardsUnavailable?'—':dollarText(wallet.earned+wallet.autoEarned)}</h2><p>{flags.rewardsUnavailable?'Reward feed unavailable; principal remains accessible.':'From your current staking positions'}</p></article><article className="card"><span>Liquid iAERO in wallet</span><h2>{tokenText(wallet.iaero)}</h2><button className="text-link" onClick={()=>go('earn')}>Put it to work <Icon name="arrow" size={14}/></button></article></div>
    <div className="portfolio-grid"><div className="card positions-card"><div className="card-title-row"><h2>Your positions</h2><Pill tone="neutral">On Base</Pill></div><div className="positions-table"><div className="position-table-head"><span>Position</span><span>Balance</span><span/></div>
      <div className="position-row"><div><TokenIcon token="stiAERO" size={40}/><span><strong>iAERO staking</strong><small>Continuous USDC rewards</small></span></div><span><strong>{tokenText(wallet.staked)}</strong><small>stiAERO</small></span><button className="text-link" onClick={()=>go('earn')}>Manage <Icon name="up-right" size={14}/></button></div>
      <div className="position-row"><div><TokenIcon token="iAERO" size={40}/><span><strong>Liquid iAERO</strong><small>Available in your wallet</small></span></div><span><strong>{tokenText(wallet.iaero)}</strong><small>iAERO</small></span><button className="text-link" onClick={()=>go('earn')}>Stake <Icon name="up-right" size={14}/></button></div>
      <div className="position-row"><div><TokenIcon token="USDC" size={40}/><span><strong>USDC AutoVault</strong><small>The same stream, in a vault</small></span></div><span><strong>{tokenText(wallet.autoStaked)}</strong><small>iAERO shares</small></span><button className="text-link" onClick={()=>go('earn')}>Explore <Icon name="up-right" size={14}/></button></div>
      {(wallet.legacyStake>0n||wallet.legacyRewards>0n)&&<div className="position-row legacy-position"><div><span className="legacy-token"><Icon name="clock" size={20}/></span><span><strong>Previous staking</strong><small>Old rewards remain yours</small></span></div><span><strong>{tokenText(wallet.legacyStake)}</strong><small>iAERO</small></span><button className="text-link" onClick={()=>openPanel('legacy')}>Move <Icon name="arrow" size={14}/></button></div>}
    </div><div className="positions-footer"><Icon name="shield" size={14}/>stiAERO redeems for iAERO. Underlying AERO remains permanently staked.</div></div>
    <div className="card wallet-assets"><div className="card-title-row"><h2>In your wallet</h2><Icon name="wallet" size={19}/></div>{([{token:'AERO',amount:wallet.aero,decimals:18},{token:'USDC',amount:wallet.usdc,decimals:6},{token:'LIQ',amount:wallet.liq,decimals:18}]).map(a=><div className="wallet-asset" key={a.token}><TokenIcon token={a.token} size={34}/><strong>{a.token}</strong><span>{tokenText(a.amount,a.decimals)}</span></div>)}<button className="text-link" onClick={()=>openPanel('liq')}>About your LIQ <Icon name="up-right" size={14}/></button></div></div>
    <div className="card activity-card"><div className="card-title-row"><h2>Your recent activity</h2><span className="small muted">Local simulations</span></div>{activities.length===0?<div className="activity-empty"><span><Icon name="clock" size={22}/></span><p>A little quiet here, for now.</p><small>Your simulated stakes, deposits and claims will appear here.</small></div>:activities.map(a=><div className="activity-row" key={a.id}><span className={'activity-icon '+a.direction}><Icon name={a.direction==='in'?'download':'up-right'} size={17}/></span><div><strong>{a.title}</strong><span>{new Date(a.time).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})} · Demo transaction</span></div><span className="activity-amount">{a.direction==='in'?'+':'−'}{a.amount} <small>{a.token}</small></span><span className="activity-status"><Icon name="check" size={13}/>Complete</span></div>)}</div>
  </div>;
}
