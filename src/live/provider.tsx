import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {getAddress,type Address,type EIP1193Provider} from 'viem';
import {Context,pageFromHash,type Store} from '../store';
import type {Action,Activity,DemoWallet,Page} from '../domain';
import {pendingTransaction,reviewPendingTransaction} from '../protocol/pendingTransaction';
import type {ReadClient} from '../protocol/streamingClient';
import {executeLiveAction,fetchBootstrap,publicBaseClient,publicError,readAccount,walletIdentity,type ExecutionContext} from './client';
import {emptyWallet,initialLiveState,liveReason,type LiveState,type WalletChoice} from './types';
import {readLiq} from './liq';
import {accountReadScope} from './account-read-client';
import {readNewPosition} from './new-stack';
import {readFundedHistory} from './legacy-history';
import {walletWorkflow} from './session';
import {runSweep,type SweepPreview,type SweepHooks} from './sweep';
import {liveValueKey,priceRewards} from './reward-value';
import {mobileWalletProvider,disconnectMobileWallet} from './walletconnect';

type EventProvider=EIP1193Provider&{on?:(event:string,listener:(...args:any[])=>void)=>void;removeListener?:(event:string,listener:(...args:any[])=>void)=>void;providers?:EventProvider[];isMetaMask?:boolean;isRabby?:boolean};
const historyKey=(address:Address)=>'iaero.live.activity.8453.'+address.toLowerCase();
function history(address:Address):Activity[]{try{return JSON.parse(localStorage.getItem(historyKey(address))??'[]').filter((a:Activity)=>a&&/^0x[0-9a-f]{64}$/i.test(a.hash??'')&&typeof a.title==='string').slice(0,30);}catch{return [];}}

export function LiveProvider({children}:{children:ReactNode}){
  const [live,setLive]=useState<LiveState>(initialLiveState),[wallet,setWallet]=useState<DemoWallet>(emptyWallet),[activities,setActivities]=useState<Activity[]>([]);
  const [page,setPage]=useState<Page>(pageFromHash),[walletDialog,setWalletDialog]=useState(false),[action,setAction]=useState<Action|null>(null),[toast,setToast]=useState('');
  const [theme,setTheme]=useState<'light'|'dark'>(()=>{try{return localStorage.getItem('iaero.preview.theme')==='dark'?'dark':'light';}catch{return 'light';}});
  const [client]=useState(publicBaseClient),[provider,setProvider]=useState<EventProvider>();
  const [valueRefresh,setValueRefresh]=useState(0),valueKey=liveValueKey(live);
  const current=useRef({live,wallet,provider}),generation=useRef(0),readTicket=useRef(0),sending=useRef(false),connecting=useRef(false);
  const activeRead=useRef<number|null>(null),requestedSelection=useRef<{date:string;customToken:string;scope:'recent'|'all'}|undefined>(undefined);
  current.current={live,wallet,provider};
  useEffect(()=>()=>{generation.current++;readTicket.current++;activeRead.current=null;requestedSelection.current=undefined;},[]);
  const update=(patch:Partial<LiveState>)=>setLive(s=>({...s,...patch}));
  const clearAccount=useCallback((patch:Partial<LiveState>={})=>{
    generation.current++;readTicket.current++;activeRead.current=null;requestedSelection.current=undefined;setWallet(emptyWallet());setActivities([]);setAction(null);
    setLive(s=>({...initialLiveState(),boot:s.boot,wallets:s.wallets,...patch}));
  },[]);
  const refresh=useCallback(async(date?:string,customToken?:string,historyMode?:'recent'|'all')=>{
    const ticket=++readTicket.current,old=current.current.live,previous=requestedSelection.current;
    // Keep explicit discovery/filter intent even if a user requests another
    // refresh before it commits. Automatic polling never replaces an active read.
    const selection={date:date??previous?.date??old.selectedDate,customToken:customToken??previous?.customToken??old.customToken,scope:historyMode??previous?.scope??old.historyMode??'recent'};
    requestedSelection.current=selection;activeRead.current=ticket;
    setLive(s=>({...s,loading:true,error:undefined}));
    try{
      const boot=await fetchBootstrap();if(ticket!==readTicket.current)return;
      setLive(s=>({...s,boot,error:undefined}));
      if(!old.address)return;
      const pinned=await accountReadScope(client,boot);
      const liqRead=boot.liqStakingReady?readLiq(pinned,boot,old.address,{rewards:false,stakeSummaryOnly:true}).catch(()=>undefined):Promise.resolve(undefined);
      const newRead=boot.newStackReady?readNewPosition(pinned,boot,old.address).then(data=>({data,error:false})).catch(()=>({data:undefined,error:true})):Promise.resolve({data:undefined,error:false});
      const historyRead=selection.scope==='all'?readFundedHistory(pinned,boot,old.address).then(data=>({data,error:undefined as unknown})).catch(error=>({data:undefined,error})):Promise.resolve({data:undefined,error:undefined as unknown});
      const result={...await readAccount(pinned,boot,old.address,selection.date,selection.customToken,pinned),newPosition:undefined as LiveState['newPosition'],liqPosition:undefined as LiveState['liqPosition']},scope=selection.scope;
      const currentPosition=await newRead;if(currentPosition.error)result.errors.push('New position reads unavailable; no zero balance is inferred.');if(currentPosition.data){const fresh=currentPosition.data;result.newPosition=fresh;if(fresh.stream?.balance!==undefined){result.wallet.staked=fresh.stream.balance;result.known.staked=true;if(fresh.stream.earned!==undefined){result.wallet.earned=fresh.stream.earned;result.known.earned=true;}}if(fresh.auto?.shares!==undefined){result.wallet.autoStaked=fresh.auto.shares;result.known.autoStaked=true;}if(fresh.auto?.earned!==undefined){result.wallet.autoEarned=fresh.auto.earned;result.known.autoEarned=true;}}
      if(boot.liqStakingReady){result.liqPosition=await liqRead;if(!result.liqPosition)result.errors.push('LIQ staking balance unavailable; no zero is inferred.');}
      const funded=await historyRead;if(funded.error)result.errors.push(publicError(funded.error));if(funded.data)Object.assign(result,funded.data);
      if(ticket!==readTicket.current||current.current.live.address?.toLowerCase()!==old.address.toLowerCase())return;
      setWallet(result.wallet);
      setLive(s=>({...s,...result,historyMode:scope,legacyDiscovery:scope==='all'?(result as any).legacyDiscovery:undefined,selectedDate:selection.date,customToken:selection.customToken,error:undefined}));
    }catch(error){if(ticket===readTicket.current){
      // Failed reads invalidate displayed balances and the write gates. Never replace
      // a failed balance read with a successful-looking zero or demo fallback.
      setWallet(emptyWallet());setLive(s=>({...s,known:{},legacyReceipts:undefined,legacyPaused:undefined,oldAutoShares:undefined,oldAutoEarned:undefined,rewards:[],newPosition:undefined,liqPosition:undefined,legacyDiscovery:undefined,rewardValuation:undefined,ethBalance:undefined,readAt:undefined,error:publicError(error)}));
    }}finally{if(activeRead.current===ticket)activeRead.current=null;if(ticket===readTicket.current)setLive(s=>({...s,loading:false}));}
  },[client]);

  useEffect(()=>{
    // Poll read-only displays only while visible. Sender receipt reconciliation
    // and the persistent pending journal keep their independent lifecycle.
    const tick=()=>{if(!document.hidden&&!sending.current&&activeRead.current===null)void refresh();};
    tick();const timer=setInterval(tick,30000);document.addEventListener('visibilitychange',tick);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',tick);};
  },[refresh]);
  useEffect(()=>{
    const snapshot=current.current.live;
    if(!snapshot.address||!snapshot.boot||!snapshot.readAt||snapshot.error){update({rewardValuation:undefined});return;}
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const run=async()=>{
      await priceRewards(valueKey,snapshot.rewards,snapshot.boot!.registry.legacy.USDC,value=>{
        if(!controller.signal.aborted&&liveValueKey(current.current.live)===valueKey)update({rewardValuation:value});
      },controller.signal);
      if(!controller.signal.aborted)timer=setTimeout(()=>void run(),60000);
    };
    void run();return()=>{controller.abort();clearTimeout(timer);};
  },[valueKey,valueRefresh]);
  useEffect(()=>{const changed=()=>setPage(pageFromHash());window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
  useEffect(()=>{document.documentElement.dataset.theme=theme;try{localStorage.setItem('iaero.preview.theme',theme);}catch{}},[theme]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),6500);return()=>clearTimeout(timer);},[toast]);

  useEffect(()=>{
    const announce=(event:Event)=>{
      const detail=(event as CustomEvent).detail;
      if(!detail?.info?.uuid||typeof detail.info.name!=='string'||typeof detail.provider?.request!=='function')return;
      const choice:WalletChoice={id:detail.info.uuid,name:detail.info.name.slice(0,60),rdns:String(detail.info.rdns??''),provider:detail.provider};
      setLive(s=>s.wallets.some(w=>w.id===choice.id||w.provider===choice.provider)?s:{...s,wallets:[...s.wallets,choice]});
    };
    window.addEventListener('eip6963:announceProvider',announce);window.dispatchEvent(new Event('eip6963:requestProvider'));
    const timer=setTimeout(()=>{
      const injected=(window as unknown as {ethereum?:EventProvider}).ethereum;
      for(const [i,p] of (injected?.providers??(injected?[injected]:[])).entries()){
        setLive(s=>s.wallets.some(w=>w.provider===p)?s:{...s,wallets:[...s.wallets,{id:'injected-'+i,name:p.isRabby?'Rabby':p.isMetaMask?'MetaMask':'Browser wallet',rdns:'',provider:p}]});
      }
    },600);
    return()=>{clearTimeout(timer);window.removeEventListener('eip6963:announceProvider',announce);};
  },[]);

  useEffect(()=>{
    if(!provider)return;
    let active=true;
    const change=async()=>{
      if(!active)return;
      const walletName=current.current.live.walletName;
      clearAccount({loading:true,walletName});
      const ticket=generation.current;
      try{const identity=await walletIdentity(provider);if(!active||ticket!==generation.current)return;
        setLive(s=>({...s,...identity,walletName:s.wallets.find(w=>w.provider===provider)?.name??walletName,loading:!!identity.address}));
        if(identity.address)setActivities(history(identity.address));
      }catch(error){if(active&&ticket===generation.current)update({loading:false,error:publicError(error)});}
    };
    const disconnected=()=>{if(!active)return;clearAccount();setProvider(undefined);};
    provider.on?.('accountsChanged',change);provider.on?.('chainChanged',change);provider.on?.('disconnect',disconnected);
    return()=>{active=false;provider.removeListener?.('accountsChanged',change);provider.removeListener?.('chainChanged',change);provider.removeListener?.('disconnect',disconnected);};
  },[provider,clearAccount]);
  useEffect(()=>{if(live.address)void refresh();},[live.address,live.chainId,refresh]);
  useEffect(()=>{
    const sync=()=>{
      const address=current.current.live.address;if(!address)return;
      try{update({pending:pendingTransaction(8453,address)});}catch(error){update({error:publicError(error)});}
    };
    sync();window.addEventListener('saero:pending-changed',sync);window.addEventListener('storage',sync);
    return()=>{window.removeEventListener('saero:pending-changed',sync);window.removeEventListener('storage',sync);};
  },[live.address]);

  const connectMobile=async()=>{if(connecting.current)return;connecting.current=true;update({connecting:true,error:undefined});try{const p=await mobileWalletProvider(),accounts=await p.request({method:'eth_requestAccounts'});if(!accounts[0])throw Error('No wallet account was selected.');const address=getAddress(accounts[0]),chainId=Number(BigInt(await p.request({method:'eth_chainId'})));clearAccount({address,chainId,walletName:'WalletConnect',loading:true});setProvider(p);setActivities(history(address));setWalletDialog(false);try{localStorage.setItem('iaero.wallet.connector.v1','walletconnect');}catch{}}catch(error){update({error:publicError(error)});}finally{connecting.current=false;update({connecting:false});}};
  useEffect(()=>{let active=true;try{if(localStorage.getItem('iaero.wallet.connector.v1')==='walletconnect')void mobileWalletProvider(false).then(async p=>{if(!p||!active)return;const accounts=await p.request({method:'eth_accounts'});if(!accounts[0]||!active)return;const address=getAddress(accounts[0]),chainId=Number(BigInt(await p.request({method:'eth_chainId'})));if(active){clearAccount({address,chainId,walletName:'WalletConnect',loading:true});setProvider(p);setActivities(history(address));}}).catch(()=>{});}catch{}return()=>{active=false;};},[clearAccount]);
  const connectWallet=async(id:string)=>{
    if(connecting.current)return;connecting.current=true;update({connecting:true,error:undefined});
    try{
      const choice=current.current.live.wallets.find(w=>w.id===id);if(!choice)throw Error('Choose an available browser wallet.');
      const p=choice.provider as EventProvider;
      const accounts=await p.request({method:'eth_requestAccounts'});if(!accounts[0])throw Error('No wallet account was selected.');
      const address=getAddress(accounts[0]),chainId=Number(BigInt(await p.request({method:'eth_chainId'})));
      try{localStorage.setItem('iaero.wallet.connector.v1','injected');}catch{}clearAccount({address,chainId,walletName:choice.name,loading:true});setProvider(p);setActivities(history(address));setWalletDialog(false);
    }catch(error){update({error:publicError(error)});}finally{connecting.current=false;update({connecting:false});}
  };
  const switchToBase=async()=>{
    try{if(!provider)throw Error('Connect a browser wallet first.');await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x2105'}]});
      const identity=await walletIdentity(provider);clearAccount({...identity,walletName:live.walletName,loading:!!identity.address});
    }catch(error){update({error:publicError(error)});setToast('Choose Base (chain 8453) in your wallet, then reconnect if needed.');}
  };
  const guarded=async<T,>(run:(context:ExecutionContext)=>Promise<T>)=>{
    if(sending.current)throw Error('A wallet request is already in progress.');
    const snapshot=current.current,ticket=generation.current;
    if(!snapshot.provider||!snapshot.live.address)throw Error('Connect a wallet first.');
    if(snapshot.live.chainId!==8453||snapshot.live.pending)throw Error('Switch to Base and resolve any pending request first.');
    sending.current=true;update({lastHash:undefined,progress:undefined,confirmedHashes:[]});
    const onConfirmed=(activity:Activity)=>{
      const address=snapshot.live.address!,records=[activity,...history(address).filter(a=>a.hash!==activity.hash)].slice(0,30);
      try{localStorage.setItem(historyKey(address),JSON.stringify(records));}catch{}
      if(ticket===generation.current){setActivities(records);setLive(s=>({...s,confirmedHashes:[...(s.confirmedHashes??[]).filter(h=>h!==activity.hash),activity.hash!]}));}
    };
    try{
      return await walletWorkflow(snapshot.live.address,()=>run({client,provider:snapshot.provider!,state:snapshot.live,canContinue:()=>ticket===generation.current,onConfirmed,onProgress:progress=>{if(ticket===generation.current)update({progress,lastHash:undefined});},onBroadcast:hash=>{
        if(ticket===generation.current)update({lastHash:hash});
      }}));
    }catch(error){throw Error(publicError(error));}finally{sending.current=false;if(ticket===generation.current)void refresh();}
  };
  const execute=async(request:Action)=>{
    const reason=liveReason(request.kind,current.current.live,!!current.current.live.address);if(reason)throw Error(reason);
    return guarded(async context=>{
      const result=await executeLiveAction({...context,action:request});
      if(!('activities' in result))context.onConfirmed?.(result.activity);
      const noAction='noAction' in result?result.noAction:undefined;
      setToast(noAction??'Confirmed on Base. Refreshing your balances.');
      const hashes=result.hashes??('hash' in result&&result.hash?[result.hash]:[]);
      if(!hashes.length&&!noAction)throw Error('No transaction was confirmed. Refresh the position before trying again.');
      return {hashes,noAction};
    });
  };
  const go=(p:Page)=>{setPage(p);window.location.hash=p;window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});};
  const value:Store={mode:'live',live,liveControls:{activeProvider:()=>current.current.provider,connectMobile,connectWallet,switchToBase,refresh:()=>refresh(),loadAllLegacy:()=>refresh(undefined,undefined,'all'),loadLegacy:(date,custom)=>refresh(date,custom,'recent'),reviewPending:async(attest=false)=>{
    if(!live.address)throw Error('Connect the originating wallet first.');
    await reviewPendingTransaction(client as unknown as ReadClient,8453,live.address,attest);void refresh();
  },refreshRewardValues:()=>setValueRefresh(n=>n+1),sweep:(preview:SweepPreview,hooks?:SweepHooks)=>guarded(context=>runSweep(context,preview,hooks)),approve:async()=>{throw Error('This route has no accepted deployed approval target.');}},
    disabledReason:kind=>liveReason(kind,live,!!live.address),page,go,connected:!!live.address,connect:()=>setWalletDialog(true),
    disconnect:()=>{if(sending.current){setToast('Finish the wallet request before disconnecting.');return;}try{localStorage.removeItem('iaero.wallet.connector.v1');}catch{}if(current.current.live.walletName==='WalletConnect')void disconnectMobileWallet().catch(()=>{});clearAccount();setProvider(undefined);setWalletDialog(false);},
    wallet,activities,flags:{paused:!live.boot?.newStackReady,rewardsUnavailable:true,nftEnabled:false},setFlags:()=>{},
    walletDialog,setWalletDialog,action,setAction,execute,notify:setToast,toast,dismissToast:()=>setToast(''),reset:()=>void refresh(),theme,toggleTheme:()=>setTheme(t=>t==='light'?'dark':'light')};
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
