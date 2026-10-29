import {useEffect,useRef,useState} from 'react';
import {formatUnits,isAddress,type Address,type Hash} from 'viem';
import {Button,Dialog,Info,Pill} from '../components';
import {Icon,TokenIcon} from '../icons';
import {parseAmount} from '../domain';
import {usePreview} from '../store';
import {publicBaseClient,publicError} from './client';
import {claimAction,groupRewards} from './rewards';
import {readLiq,previewLiqClaims,type LiqReward} from './liq';
import {accountReadClient} from './account-read-client';
import {claimedTokenAmounts} from './claim-receipts';
import {LiveLegacyStakeDialog} from './views';
import {RewardSummary} from './reward-list';
import {ExactAmount} from './exact-amount';
import {retrySlippage,SWEEP_MAX_RETRIES,type SweepRetryEvent} from './sweep-retries';
import {priceRewards,valueText,type RewardValuation} from './reward-value';
import {buildSweepPreview,scanSweepWallet,orderSweepTokens,sweepOutput,SWEEP_BATCH_LIMIT,sweepGroups,type SweepMode,type SweepPreview,type SweepResult,type SweepToken,type SweepSkipped,type HiddenSweepToken} from './sweep';

export type SweepIntent={mode:SweepMode;claimFirst:boolean;source?:'legacy'|'liq'|'all'};
const short=(a:string)=>a.slice(0,6)+'…'+a.slice(-4);
const units=(value:bigint,decimals:number|null)=>decimals===null?value.toString():formatUnits(value,decimals);

export function SweepWizard({intent,onClose}:{intent:SweepIntent;onClose:()=>void}){
  const s=usePreview(),l=s.live!,boot=l.boot!,[client]=useState(()=>s.liveControls?.readClient?.()??publicBaseClient());
  const [mode,setMode]=useState<SweepMode>(intent.mode),[phase,setPhase]=useState<'claim'|'claiming'|'scanning'|'select'|'quoting'|'review'|'running'|'done'>(intent.claimFirst?'claim':'scanning');
  const [tokens,setTokens]=useState<SweepToken[]>([]),[hidden,setHidden]=useState<HiddenSweepToken[]>([]),[selected,setSelected]=useState<Set<string>>(new Set()),[amounts,setAmounts]=useState<Record<string,string>>({}),[notices,setNotices]=useState<string[]>([]);
  const [extra,setExtra]=useState(l.customToken),[slippage,setSlippage]=useState(100),[preview,setPreview]=useState<SweepPreview>(),[result,setResult]=useState<SweepResult>(),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [automaticRetries,setAutomaticRetries]=useState(true),[retryEvents,setRetryEvents]=useState<SweepRetryEvent[]>([]);
  const lock=useRef(false),stop=useRef(false),alive=useRef(true),scanTicket=useRef(0),claimed=useRef<Map<string,bigint>|undefined>(undefined),claimNotices=useRef<string[]>([]),unreconciled=useRef(new Set<string>());
  const [stopping,setStopping]=useState(false),[walletValues,setWalletValues]=useState<RewardValuation>(),[pricing,setPricing]=useState(false);
  const [claimSources,setClaimSources]=useState({legacy:intent.source!=='liq',liq:intent.source!=='legacy'&&!!boot.liqStakingReady}),[liqClaims,setLiqClaims]=useState<{reading:boolean;rows:LiqReward[];blocked:number;error?:string}>({reading:intent.claimFirst&&intent.source!=='legacy',rows:[],blocked:0}),[confirmed,setConfirmed]=useState<Hash[]>([]),[stakeReview,setStakeReview]=useState(false);
  const claimsDone=useRef(new Set<Hash>()),identity=useRef(l.address?.toLowerCase());
  useEffect(()=>{if(identity.current!==l.address?.toLowerCase()||l.chainId!==8453){stop.current=true;scanTicket.current++;claimed.current=undefined;setSelected(new Set());setPreview(undefined);setError('Wallet or network changed. Reopen this flow for the connected account.');}},[l.address,l.chainId]);
  useEffect(()=>{let current=true;if(!intent.claimFirst||intent.source==='legacy')return;
    if(!boot.liqStakingReady||!l.address){setLiqClaims({reading:false,rows:[],blocked:0,error:'LIQ staking is not verified.'});return;}
    void (async()=>{try{const position=await readLiq(accountReadClient(client,boot),boot,l.address!,{stakeSummaryOnly:true});if(position.paused!==false||position.errors.length)throw Error(position.errors.join(' ')||'LIQ staking is paused.');const plan=await previewLiqClaims(client,boot,l.address!,position.rewards);if(current)setLiqClaims({reading:false,rows:plan.eligible,blocked:plan.blocked.length});}catch(error){if(current)setLiqClaims({reading:false,rows:[],blocked:0,error:publicError(error)});}})();return()=>{current=false;};
  },[]);
  const walletValueKey=JSON.stringify([l.address?.toLowerCase(),l.chainId,tokens.map(t=>[t.token.toLowerCase(),t.balance.toString(),t.decimals])]);
  const values=walletValues?.key===walletValueKey?walletValues.values:{};
  const orderedTokens=orderSweepTokens(tokens,values);
  useEffect(()=>{
    const controller=new AbortController();setWalletValues(undefined);setPricing(!!tokens.length);
    if(tokens.length){
      // Display-only wallet balances reuse the valuation reader; these synthetic
      // rows are never passed to a claim or transaction builder.
      const rows=tokens.map(t=>({token:t.token,symbol:t.symbol,decimals:t.decimals,amount:t.balance,epoch:0n}));
      void priceRewards(walletValueKey,rows,boot.registry.legacy.USDC,value=>{
        if(controller.signal.aborted)return;
        if(!value.loading){setWalletValues(value);setPricing(false);}
      },controller.signal).catch(()=>{if(!controller.signal.aborted)setPricing(false);});
    }
    return()=>controller.abort();
  },[tokens,walletValueKey,boot.registry.legacy.USDC]);
  const busy=phase==='claiming'||phase==='running',reading=phase==='scanning'||phase==='quoting';
  const walletBlocked=l.chainId!==8453||!l.address||!!l.pending||!!l.error;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;scanTicket.current++;stop.current=true;};},[]);
  const scan=async()=>{
    const ticket=++scanTicket.current;setError('');setPhase('scanning');
    try{
      if(!l.address)throw Error('Connect your wallet first.');
      if(extra&&!isAddress(extra))throw Error('Enter a valid additional token address.');
      if(claimed.current)claimed.current=new Map([...claimed.current].filter(([token,amount])=>amount>0n&&!unreconciled.current.has(token)));
      const data=await scanSweepWallet(client,boot,l.address,[...(extra?[extra as Address]:[]),...[...(claimed.current?.keys()??[])].filter(a=>isAddress(a)) as Address[]]);
      if(!alive.current||ticket!==scanTicket.current)return;
      setTokens(data.tokens);setHidden(data.hidden);setNotices([...claimNotices.current,...data.errors]);
      const next=new Set<string>(),values:Record<string,string>={};
      for(const token of data.tokens){
        const key=token.token.toLowerCase(),usdc=key===boot.registry.legacy.USDC.toLowerCase(),received=claimed.current?.get(key)??0n,amount=claimed.current?(received<token.balance?received:token.balance):token.balance;
        values[key]=units(amount>0n?amount:token.balance,token.decimals);
        if(amount>0n&&(!usdc||mode!=='USDC'))next.add(key);
      }
      setAmounts(values);setSelected(next);setMessage(claimed.current?'Only amounts received by this flow are selected. Other wallet balances stay unselected.':`Read ${data.tokenCount} token addresses. Only positive wallet balances are shown.`);setPhase('select');
    }catch(e){if(alive.current&&ticket===scanTicket.current){setError(publicError(e));setPhase('select');}}
  };
  useEffect(()=>{if(!intent.claimFirst)void scan();},[]);
  const claim=async()=>{
    if(lock.current)return;lock.current=true;setError('');setPhase('claiming');claimed.current??=new Map();
    let confirmedAny=false;
    try{
    const sources=[...(claimSources.legacy&&l.rewards.length?[{address:boot.registry.legacy.epochDistributor,rows:l.rewards,action:claimAction(l.rewards,true)}]:[]),...(claimSources.liq&&liqClaims.rows.length?[{address:boot.registry.liqStaking!.distributor,rows:liqClaims.rows,action:{kind:'liqClaimMany' as const,amount:0n,title:'Claim LIQ rewards before conversion',description:'Claim the simulated LIQ rewards, then review only the tokens actually received for conversion.',source:'LIQ staking',target:'Your wallet',approval:false,rewardLegs:liqClaims.rows.map(r=>({...r,epoch:0n}))}}]:[])];
      for(const source of sources){
        let hashes:Hash[]=[],failure:unknown;
        try{const execution=await s.execute(source.action);hashes=execution?.hashes??[];}catch(error){hashes=(error as any)?.confirmedHashes??[];failure=error;}
        if(!alive.current||stop.current)return;
        if(hashes.length){confirmedAny=true;setConfirmed(old=>[...new Set([...old,...hashes])]);
          const unprocessed=hashes.filter(hash=>!claimsDone.current.has(hash));
          try{const amounts=await claimedTokenAmounts(client,l.address!,source.address,source.rows.map(r=>r.token),unprocessed);for(const [token,amount] of amounts)if(!unreconciled.current.has(token))claimed.current.set(token,(claimed.current.get(token)??0n)+amount);for(const hash of unprocessed)claimsDone.current.add(hash);}
          catch{for(const row of source.rows){const token=row.token.toLowerCase();unreconciled.current.add(token);claimed.current.delete(token);}claimNotices.current.push('Claims confirmed, but part of the received amount could not be reconciled. Those tokens remain unselected; choose their amounts explicitly if needed.');}
        }
        if(failure)throw failure;
      }
      if(!sources.length)throw Error('No rewards selected. Use tokens already in your wallet instead.');
      claimed.current=new Map([...claimed.current].filter(([,amount])=>amount>0n));
      const usdc=claimed.current.get(boot.registry.legacy.USDC.toLowerCase())??0n;
      if(mode==='USDC'&&claimed.current.size===1&&usdc>0n){setResult({hashes:[...claimsDone.current],outToken:boot.registry.legacy.USDC,outputAmount:usdc,iaero:0n,staked:0n,swapped:0,batches:0,skipped:[]});setPhase('done');return;}
      await scan();
    }catch(error){if(alive.current){if(confirmedAny||claimsDone.current.size){claimNotices.current.push(publicError(error)+' Some claims completed. Only their received tokens are selected; remaining rewards can be claimed later.');await scan();}else{setError(publicError(error));setPhase('claim');}}}finally{lock.current=false;}
  };
  const continueConversion=async()=>{
    if(!result||lock.current)return;lock.current=true;
    try{claimed.current=new Map([[boot.registry.aero.token.toLowerCase(),result.outputAmount]]);setPreview(undefined);setResult(undefined);await scan();}finally{lock.current=false;}
  };
  const quote=async()=>{
    if(lock.current)return;lock.current=true;stop.current=false;setError('');setPreview(undefined);setMessage('Checking selected tokens…');setPhase('quoting');
    try{
      if(!l.address)throw Error('Connect your wallet first.');
      const inputs=orderedTokens.filter(t=>selected.has(t.token.toLowerCase())).map(t=>{
        const text=amounts[t.token.toLowerCase()]??'',amount=t.decimals===null?(/^\d+$/.test(text)?BigInt(text):0n):parseAmount(text,t.decimals);
        if(amount<=0n||amount>t.balance)throw Error('Choose an amount within your '+t.symbol+' wallet balance.');return {token:t.token,symbol:t.symbol,decimals:t.decimals,amount};
      });
      const data=await buildSweepPreview(client,boot,l.address,inputs,mode,slippage,fetch,(checked,total)=>{if(alive.current)setMessage('Checked '+checked+' of '+total+' tokens…');},automaticRetries,()=>!alive.current||stop.current);if(!alive.current)return;setPreview(data);setPhase('review');
    }catch(e){if(alive.current){setError(publicError(e));setPhase('select');}}finally{lock.current=false;}
  };
  const execute=async()=>{
    if(lock.current||!preview)return;lock.current=true;stop.current=false;setStopping(false);setError('');setPhase('running');setRetryEvents([]);
    try{const completed=await s.liveControls!.sweep(preview,{shouldStop:()=>stop.current,onConfirmed:activity=>{if(activity.hash)setConfirmed(old=>[...new Set([...old,activity.hash!])]);},onProgress:text=>{if(alive.current)setMessage(text);},onRetry:event=>{if(alive.current)setRetryEvents(old=>[...old,event]);}});if(alive.current){setResult(mode==='USDC'&&claimed.current?{...completed,outputAmount:completed.outputAmount+(claimed.current.get(boot.registry.legacy.USDC.toLowerCase())??0n)}:completed);setPhase('done');}}
    catch(e){if(alive.current){
      const failure=publicError(e);setPreview(undefined);
      // Swaps are not idempotent. A completed partial-amount sale may leave
      // enough balance to sell that amount again, so never offer the same
      // executable preview after any failure or an ambiguous receipt.
      await scan();
      if(alive.current){setSelected(new Set());setError(failure+' Choose the remaining tokens and review fresh balances before starting another sweep.');setStopping(false);stop.current=false;}
    }}
    finally{lock.current=false;}
  };
  const changeMode=(value:SweepMode)=>{setMode(value);setPreview(undefined);if(value==='USDC')setSelected(old=>new Set([...old].filter(a=>a!==boot.registry.legacy.USDC.toLowerCase())));};
  const count=tokens.filter(t=>selected.has(t.token.toLowerCase())).length;
  const label=mode==='USDC'?'USDC':mode==='iAERO'?'liquid iAERO':'iAERO + previous staking';
  const output=sweepOutput(boot,mode),executable=!!preview?.inputs.length&&preview.minimumOutput>0n;
  let selectionValue=0n,unpricedSelection=0;
  for(const t of tokens.filter(t=>selected.has(t.token.toLowerCase()))){
    const key=t.token.toLowerCase(),text=amounts[key]??'',value=values[key]?.valueWad;
    try{
      const amount=t.decimals===null?(/^\d+$/.test(text)?BigInt(text):0n):parseAmount(text,t.decimals);
      if(amount<=0n||amount>t.balance||value==null||!walletValues||Date.now()-walletValues.asOf>120000){unpricedSelection++;continue;}
      selectionValue+=value*amount/t.balance;
    }catch{unpricedSelection++;}
  }
  const step=phase==='done'?'done':phase==='review'||phase==='running'?'review':phase==='claim'||phase==='claiming'?'claim':'select';
  const claimCount=(claimSources.legacy?l.rewards.length:0)+(claimSources.liq?liqClaims.rows.length:0),claimBlocked=walletBlocked||claimSources.legacy&&!!s.disabledReason('legacyClaimMany')||claimSources.liq&&(liqClaims.reading||!!liqClaims.error);
  if(stakeReview&&result)return <LiveLegacyStakeDialog maximum={result.iaero} onClose={()=>setStakeReview(false)}/>;
  return <Dialog title={phase==='done'?'Your rewards, put to work.':phase==='claim'||phase==='claiming'?'Claim, then make your next move.':'A little less dust. More possibility.'} subtitle={phase==='done'?(result?.hashes.length?'Confirmed steps on Base. Your actual outputs are below.':'No transactions were sent. Your tokens remain in your wallet.'):'Convert selected wallet tokens into USDC or iAERO, with every amount reviewed.'} onClose={onClose} busy={busy} className="sweep-dialog" stepKey={step}>
    <div className="sweep-context"><Pill tone="blue">Base mainnet</Pill><span>{short(l.address??'')} · Your wallet receives the output</span></div>
    {!busy&&l.chainId!==8453&&<Info tone="blue">Switch your wallet to Base before claiming or converting.<Button variant="secondary" onClick={()=>void s.liveControls!.switchToBase()}>Switch to Base</Button></Info>}
    {!busy&&l.pending&&<Info tone="amber">A wallet request is still pending. Close this dialog to review the pending-request notice before starting another transaction.</Info>}
    {!busy&&l.error&&<Info tone="amber">Base reads need a refresh before continuing. Your completed steps remain in your wallet.<Button variant="secondary" onClick={()=>void s.liveControls!.refresh()}>Retry Base reads</Button></Info>}

    {(phase==='claim'||phase==='claiming')?<>
      <p className="dialog-body-copy">Claim rewards, then convert the tokens actually received. You will review exact amounts and quotes before any swap. Principal stays in place.</p>
      {intent.source!=='liq'&&<section className="sweep-claim-source"><label><input type="checkbox" checked={claimSources.legacy} disabled={busy} onChange={e=>setClaimSources(old=>({...old,legacy:e.target.checked}))}/><strong>Previous iAERO staking</strong><span>{groupRewards(l.rewards).length} reward tokens · {l.rewards.length} token/week entries · {l.historyMode==='all'?'all loaded weeks':'currently loaded weeks'}</span></label>{claimSources.legacy&&<RewardSummary rows={l.rewards}/>}</section>}
      {intent.source!=='legacy'&&<section className="sweep-claim-source"><label><input type="checkbox" checked={claimSources.liq} disabled={busy||!boot.liqStakingReady} onChange={e=>setClaimSources(old=>({...old,liq:e.target.checked}))}/><strong>LIQ staking</strong><span>{liqClaims.reading?'Checking available rewards…':liqClaims.error?'Reward checks unavailable':liqClaims.rows.length+' available reward tokens'}</span></label>{claimSources.liq&&liqClaims.rows.length>0&&<RewardSummary rows={liqClaims.rows.map(r=>({...r,epoch:0n}))}/>} {!!liqClaims.blocked&&<p className="small muted">{liqClaims.blocked} unavailable LIQ token(s) stay unclaimed.</p>}{claimSources.liq&&liqClaims.error&&<p className="form-error">{liqClaims.error}</p>}</section>}
      <p className="small muted">Claims are grouped up to 50 entries per transaction. Each source confirms in order. Native ETH stays in your wallet.</p>{error&&<p className="form-error" role="alert">{error}</p>}
      <Button className="full-width" disabled={busy||claimBlocked||!claimCount} onClick={()=>void claim()}>{phase==='claiming'?<><span className="spinner"/>{l.progress??'Confirm the claims in your wallet…'}</>:claimSources.liq&&liqClaims.reading?'Checking rewards…':'Claim selected rewards in wallet'}</Button>
      <button className="text-link sweep-skip-claims" disabled={busy} onClick={()=>{claimed.current=undefined;void scan();}}>Use tokens already in my wallet <Icon name="arrow" size={14}/></button>
    </>:
    phase==='select'||phase==='scanning'||phase==='quoting'?<>
      <div className="sweep-mode-picker" aria-label="Sweep destination">{([{key:'USDC',label:'USDC'},{key:'iAERO',label:'Liquid iAERO'},{key:'stake',label:'iAERO + stake'}] as const).map(item=><button aria-pressed={mode===item.key} key={item.key} disabled={reading||item.key!=='USDC'&&!boot.aeroCompoundReady} onClick={()=>changeMode(item.key)}>{item.label}</button>)}</div>
      {mode==='stake'&&<Info tone="blue">Only the iAERO received from this sweep is staked, using previous staking. Existing liquid iAERO is excluded. The new USDC stream is not deployed.</Info>}
      {mode==='USDC'&&(claimed.current?.get(boot.registry.legacy.USDC.toLowerCase())??0n)>0n&&<Info tone="blue">{formatUnits(claimed.current!.get(boot.registry.legacy.USDC.toLowerCase())!,6)} USDC was received by your claims and is already ready in your wallet. It needs no swap.</Info>}
      <div className="sweep-selection-heading"><div><strong>Choose your wallet tokens</strong><span>Estimated wallet value · highest first{pricing?' · valuing…':''}</span></div><button className="text-link" disabled={reading} onClick={()=>setSelected(count?new Set():new Set(tokens.filter(t=>mode!=='USDC'||t.token.toLowerCase()!==boot.registry.legacy.USDC.toLowerCase()).map(t=>t.token.toLowerCase())))}>{count?'Clear selection':'Select all'}</button></div>
      <div className="sweep-token-list">{phase==='scanning'?<div className="sweep-loading"><span className="spinner"/><p>Reading your reward-token balances…</p></div>:tokens.length?orderedTokens.map(t=>{const key=t.token.toLowerCase(),alreadyUsdc=mode==='USDC'&&key===boot.registry.legacy.USDC.toLowerCase();return <div className={'sweep-token-row '+(selected.has(key)?'selected':'')} key={key}><label><input type="checkbox" aria-label={'Select '+t.symbol+' '+short(t.token)} disabled={reading||alreadyUsdc} checked={selected.has(key)} onChange={e=>setSelected(old=>{const next=new Set(old);if(e.target.checked)next.add(key);else next.delete(key);return next;})}/><TokenIcon token={t.symbol} size={30}/><span><strong>{t.symbol}</strong><small><a title={t.token} href={'https://basescan.org/address/'+t.token} target="_blank" rel="noreferrer">{short(t.token)} ↗</a>{alreadyUsdc?' · already USDC':''}</small></span></label><div className="sweep-row-details"><span className="sweep-row-balance">Balance {units(t.balance,t.decimals)}{t.decimals===null?' raw units':''}<small className="sweep-wallet-value" title="Estimated USDC value of the scanned wallet balance, before gas. Rescan refreshes these estimates.">{values[key]?.valueWad!=null?'≈ '+valueText(values[key].valueWad,true)+' USDC'+(values[key].source==='reference'?' · indicative':''):pricing?'Valuing…':'Unpriced'}</small></span><div className="sweep-row-amount"><input aria-label={'Amount of '+t.symbol+' '+short(t.token)} inputMode="decimal" disabled={!selected.has(key)||reading} value={amounts[key]??''} onChange={e=>setAmounts(old=>({...old,[key]:e.target.value}))}/><button disabled={!selected.has(key)||reading} onClick={()=>setAmounts(old=>({...old,[key]:units(t.balance,t.decimals)}))}>MAX</button></div></div></div>;}):<div className="legacy-no-rewards"><Icon name="wallet" size={25}/><p>No positive reward-token balances were found in successful reads.</p><small>Try another token address, or claim your rewards first.</small></div>}</div>
      {hidden.length>0&&<details className="sweep-filtered-tokens"><summary>{hidden.length} known spam token{hidden.length===1?'':'s'} hidden <Icon name="chevron" size={11}/></summary><p>Excluded from selection and approvals by the protocol token filter.</p>{hidden.map(t=><div key={t.token}><span><strong>{t.symbol}</strong><small>{t.reason}</small></span><a href={'https://basescan.org/address/'+t.token} title={t.token} target="_blank" rel="noreferrer">{short(t.token)} ↗</a></div>)}</details>}
      <form className="sweep-extra-token" onSubmit={e=>{e.preventDefault();void scan();}}><label>Additional token address<input value={extra} placeholder="0x…" aria-label="Additional sweep token" onChange={e=>setExtra(e.target.value.trim())} disabled={reading}/></label><Button variant="secondary" iconLeft="refresh" disabled={reading} type="submit">Rescan</Button></form>
      <div className="sweep-slippage"><label htmlFor="sweep-slippage">Slippage per swap stage</label><select id="sweep-slippage" value={slippage} disabled={reading} onChange={e=>setSlippage(Number(e.target.value))}>{[50,100,300,500].map(bps=><option value={bps} key={bps}>{bps/100}%</option>)}</select></div>
      <label className="sweep-retry-option"><input type="checkbox" aria-label="Automatic gas and slippage retries" checked={automaticRetries} disabled={reading} onChange={e=>setAutomaticRetries(e.target.checked)}/><span><strong>Automatically retry failed swaps</strong><small>Up to 2 retries per step · gas allowance +50% each retry · slippage up to {retrySlippage(slippage,SWEEP_MAX_RETRIES)/100}%.</small></span></label>
      {error&&<p className="form-error" role="alert">{error}</p>}<div className="sweep-actionbar"><div className="sweep-selection-total" aria-live="polite"><strong>{count} selected</strong><span>{pricing?'Valuing selection…':count?unpricedSelection===count?'USDC estimate unavailable':'≈ '+valueText(selectionValue,true)+' USDC'+(unpricedSelection?' · partial estimate':' · estimated'):'Choose tokens to continue'}</span></div><Button className="full-width" icon={reading?undefined:'arrow'} disabled={reading||!count||walletBlocked} onClick={()=>void quote()}>{reading?<><span className="spinner"/>{phase==='quoting'?message||'Simulating selected swaps…':'Reading balances…'}</>:'Review '+count+' token'+(count===1?'':'s')+' → '+label}</Button></div><p className="form-footnote"><Icon name="shield" size={13}/>Native ETH and iAERO principal/receipts are excluded. USDC already in your wallet is used only if selected.</p><p className="small muted sweep-read-caption">{message}</p>
    </>:phase==='review'||phase==='running'?<>
      <div className={'sweep-check-status '+(!executable?'none':'')} role="status"><Icon name={executable?'check':'shield'} size={17}/><span>{executable?preview!.inputs.length+' eligible token'+(preview!.inputs.length===1?'':'s')+' included':'No tokens passed the checks'}{preview!.skipped.length>0&&' · '+preview!.skipped.length+' skipped'}</span></div>
      {executable&&<div className="sweep-output"><TokenIcon token={mode==='USDC'?'USDC':'iAERO'} size={46}/><span>{mode==='stake'?'iAERO to stake in previous staking':'Expected '+label}</span><strong>{mode==='USDC'?formatUnits(preview!.expectedOutput,6):formatUnits(preview!.expectedIaero!,18)}</strong><small>Minimum: {mode==='USDC'?formatUnits(preview!.minimumOutput,6)+' USDC':formatUnits(preview!.minimumIaero!,18)+' iAERO'}</small></div>}
      {executable&&<><div className="sweep-review-inputs">{preview!.inputs.map(t=><div key={t.token}><TokenIcon token={t.symbol} size={25}/><span>{t.symbol}<small>{short(t.token)}</small></span><ExactAmount value={t.amount} decimals={t.decimals}/></div>)}</div>{preview!.quotes.some(q=>q.native)&&<Info tone="blue">Native Aero pool routes are included. Their fees and price impact are capped at 5%; exact minimum outputs are enforced on chain. Approve the verified MetaRouter only for those routes.</Info>}<div className="transaction-summary"><div><span>Recipient</span><strong>Your connected wallet</strong></div><div><span>{output.symbol} minimum{mode!=='USDC'?' before conversion':' received'}</span><strong>{formatUnits(preview!.minimumOutput,output.decimals)} {output.symbol}</strong></div><div><span>Slippage per stage</span><strong>{preview!.slippageBps/100}%</strong></div><div><span>Approvals</span><strong>Exact amounts, when needed</strong></div>{preview!.quotes.length>0&&<div><span>Swap batches</span><strong>{sweepGroups(preview!.quotes).length} planned · up to {SWEEP_BATCH_LIMIT} tokens each</strong></div>}{preview!.quotes.some(q=>!q.native)&&<div><span>0x swapper</span><a className="contract-link" href={'https://basescan.org/address/'+boot.registry.sweep.swapper} target="_blank" rel="noreferrer">{short(boot.registry.sweep.swapper)} ↗</a></div>}{(preview!.quotes.some(q=>q.native)||mode!=='USDC')&&<div><span>Aero router</span><a className="contract-link" href={'https://basescan.org/address/'+boot.registry.sweep.metarouter} target="_blank" rel="noreferrer">{short(boot.registry.sweep.metarouter)} ↗</a></div>}{mode!=='USDC'&&<div><span>iAERO market route</span><strong>Rewards → AERO → iAERO · CL</strong></div>}{mode!=='USDC'&&<div><span>Conversion cost limit</span><strong>2% · pool fees + price impact</strong></div>}{mode==='stake'&&<div><span>Staking destination</span><a className="contract-link" href={'https://basescan.org/address/'+boot.registry.legacy.epochDistributor} target="_blank" rel="noreferrer">Previous staking · {short(boot.registry.legacy.epochDistributor)}</a></div>}</div>
      </>}
      {executable&&preview!.retry&&<div className="sweep-retry-review" aria-label="Automatic retry limits"><strong>Up to 2 automatic retry rounds per step</strong><p>Gas allowance increases by 50% per retry, capped at 16 million. Slippage may rise from {preview!.slippageBps/100}% to {preview!.retry!.maxSlippageBps/100}%.</p><p><strong>Minimum including retries: {mode==='USDC'?formatUnits(preview!.retry!.minimumOutputByAttempt[2],6)+' USDC':formatUnits(preview!.retry!.minimumIaeroByAttempt![2],18)+' iAERO'}</strong></p><small>The final retry round may use separate token transactions. Every submission needs a wallet confirmation. A reverted transaction still costs network gas. Pending, replaced or uncertain transactions stop the flow.</small></div>}
      <SkippedSweeps rows={preview!.skipped} forceOpen={!executable}/>
      <p className="small muted live-exact-amount">{executable?'Each reward swap passed simulation, including any required approval. Eligible swaps are grouped in batches of up to 10, with one confirmation per swap batch. Token approvals are separate. Batches are rechecked and split when needed; tokens that stop passing are skipped.':'All requested tokens were checked. Nothing will be approved or swapped from this selection.'} Completed transactions remain complete. Conversion uses the reviewed retry minimum when retries are enabled, and pauses if tokens are skipped.</p>{error&&<p className="form-error" role="alert">{error}</p>}
      <div className="sweep-actionbar">{executable&&<div className="sweep-confirm-context"><span>{preview!.inputs.length} included · {preview!.skipped.length} skipped</span><strong>Minimum received: {mode==='USDC'?formatUnits(preview!.retry?.minimumOutputByAttempt[2]??preview!.minimumOutput,6)+' USDC':formatUnits(preview!.retry?.minimumIaeroByAttempt?.[2]??preview!.minimumIaero!,18)+' iAERO'}</strong></div>}<Button className="full-width" disabled={!executable||busy||walletBlocked||stopping} onClick={()=>void execute()} icon={busy?undefined:'arrow'}>{busy?<><span className="spinner"/>{stopping?'Stopping after the current transaction…':message||'Confirm in your wallet…'}</>:executable?'Confirm sweep in wallet':'No eligible tokens to sweep'}</Button></div>
      {busy?<button className="text-link sweep-skip-claims" disabled={stopping} onClick={()=>{stop.current=true;setStopping(true);}}>Stop after current transaction</button>:<button className="text-link sweep-skip-claims" onClick={()=>{setPreview(undefined);void scan();}}>Rescan wallet and refresh quotes <Icon name="arrow" size={14}/></button>}
    </>:<><div className="transaction-success"><span><Icon name="check" size={34}/></span><h3>{result?.conversionDeferred?output.symbol+' remains in your wallet':!result?.swapped&&!result?.iaero?(result?.outputAmount?'Claimed USDC is ready':'No tokens were swapped'):result?.staked?'Sweep output staked':mode==='USDC'?'USDC received':'Liquid iAERO received'}</h3><p>{result?.conversionDeferred?formatUnits(result.outputAmount,output.decimals)+' '+output.symbol+' available':result?.staked?formatUnits(result.staked,18)+' iAERO in previous staking':mode==='USDC'?formatUnits(result!.outputAmount,6)+' USDC':formatUnits(result!.iaero,18)+' iAERO'}</p></div>{result?.conversionDeferred&&<Info tone="blue">{result.conversionDeferred}</Info>}{result?.stakingDeferred&&<Info tone="blue">{result.stakingDeferred}</Info>}{result?.conversionDeferred&&result.outputAmount>0n&&<Button className="full-width" disabled={walletBlocked} onClick={()=>void continueConversion()}>Review conversion of available AERO</Button>}{result?.stakingDeferred&&result.iaero>0n&&<Button className="full-width" disabled={walletBlocked} onClick={()=>setStakeReview(true)}>Review staking received iAERO</Button>}<SkippedSweeps rows={result?.skipped??[]}/>{!!result?.swapped&&<p className="sweep-batch-result">{result.swapped} token{result.swapped===1?'':'s'} swapped in {result.batches} batch transaction{result.batches===1?'':'s'}.</p>}<Button className="full-width" onClick={onClose} icon="arrow">Back to your rewards</Button></>}
    {retryEvents.length>0&&<details className="sweep-retry-history" open><summary>Retry history · {retryEvents.length} checks</summary>{retryEvents.map((event,i)=><p key={i}><span>{event.exhausted?'Retry limit reached':'Retry '+event.attempt+' of 2'} · {event.stage}{event.stage==='stake'?' · gas boost only':' · '+event.slippageBps/100+'% slippage'}</span>{event.hash&&<a href={'https://basescan.org/tx/'+event.hash} target="_blank" rel="noreferrer">Confirmed failed attempt <Icon name="up-right" size={12}/></a>}</p>)}</details>}
    {confirmed.length>0&&<div className="sweep-receipts"><strong>Confirmed steps</strong>{confirmed.map((hash,i)=><a key={hash} href={'https://basescan.org/tx/'+hash} target="_blank" rel="noreferrer">{i+1}. {short(hash)} <Icon name="up-right" size={12}/></a>)}</div>}
    {notices.length>0&&<details className="live-read-errors"><summary>{notices.length} read notices</summary>{notices.map((n,i)=><p key={i}>{n}</p>)}</details>}
  </Dialog>;
}

function SkippedSweeps({rows,forceOpen=false}:{rows:readonly SweepSkipped[];forceOpen?:boolean}){
  if(!rows.length)return null;
  const label=(reason:string)=>/rate.limit/i.test(reason)?'Quote service limit':/simulation|revert/i.test(reason)?'Simulation did not pass':/no .*quote|no executable|liquidity|route/i.test(reason)?'No route for this amount':'Other unavailable tokens';
  const groups=new Map<string,SweepSkipped[]>();
  for(const row of rows){const key=label(row.reason);groups.set(key,[...(groups.get(key)??[]),row]);}
  const open=forceOpen||rows.length<=3;
  return <section className="sweep-skipped-tokens" aria-label="Skipped sweep tokens"><details open={open}><summary>{rows.length} token{rows.length===1?'':'s'} left in your wallet <Icon name="chevron" size={16}/></summary><p>Excluded from this sweep. Change an amount and check again.</p>{[...groups].map(([name,items])=><details className="sweep-skipped-group" key={name} open={open}><summary>{name} · {items.length} token{items.length===1?'':'s'}</summary>{items.map(({input,reason})=><article key={input.token}><TokenIcon token={input.symbol} size={26}/><div><strong>{input.symbol} <a href={'https://basescan.org/address/'+input.token} title={input.token} target="_blank" rel="noreferrer">{short(input.token)} ↗</a></strong><small className="sweep-skipped-amount">Selected: {units(input.amount,input.decimals)} {input.symbol}{input.decimals===null?' raw units':''}</small><p>{reason}</p></div></article>)}</details>)}</details></section>;
}
