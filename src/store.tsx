import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {accrued,applyAction,DEMO_STORAGE_KEY,initialWallet,restoreWallet,saveWallet,tokenText,type Action,type ActionKind,type ActionResult,type Activity,type DemoWallet,type Page} from './domain';
import type {LiveState,LiveControls} from './live/types';

export type PreviewFlags={paused:boolean;rewardsUnavailable:boolean;nftEnabled:boolean};
export type Store={
  mode:'demo'|'live';live?:LiveState;liveControls?:LiveControls;disabledReason:(kind:ActionKind)=>string|undefined;
  page:Page;go:(page:Page)=>void;connected:boolean;connect:()=>void;disconnect:()=>void;
  wallet:DemoWallet;activities:Activity[];flags:PreviewFlags;setFlags:(flags:PreviewFlags)=>void;
  walletDialog:boolean;setWalletDialog:(open:boolean)=>void;action:Action|null;setAction:(action:Action|null)=>void;
  execute:(action:Action)=>Promise<ActionResult|void>;notify:(message:string)=>void;toast:string;dismissToast:()=>void;
  reset:()=>void;theme:'light'|'dark';toggleTheme:()=>void;
};
export const Context=createContext<Store|null>(null);
const allowedPages:Page[]=['overview','earn','deposit','get','portfolio'];
export const pageFromHash=():Page=>{const p=window.location.hash.slice(1) as Page;return allowedPages.includes(p)?p:'overview';};

export function PreviewProvider({children}:{children:ReactNode}){
  const [restored]=useState(restoreWallet);
  const [wallet,setWallet]=useState(restored?.wallet??initialWallet()),[activities,setActivities]=useState<Activity[]>(restored?.activities??[]);
  const [connected,setConnected]=useState(!!restored),[page,setPage]=useState<Page>(pageFromHash),[clock,setClock]=useState(Math.floor(Date.now()/1000));
  const [flags,setFlags]=useState<PreviewFlags>({paused:false,rewardsUnavailable:false,nftEnabled:false});
  const [walletDialog,setWalletDialog]=useState(false),[action,setAction]=useState<Action|null>(null);
  const [toast,setToast]=useState('');
  const [theme,setTheme]=useState<'light'|'dark'>(()=>{try{return localStorage.getItem('iaero.preview.theme')==='dark'?'dark':'light';}catch{return 'light';}});
  const current=useRef({wallet,activities,flags,connected});current.current={wallet,activities,flags,connected};
  const pending=useRef(false),generation=useRef(0);
  useEffect(()=>{const tick=setInterval(()=>setClock(Math.floor(Date.now()/1000)),1000);return()=>clearInterval(tick);},[]);
  useEffect(()=>{const onHash=()=>setPage(pageFromHash());window.addEventListener('hashchange',onHash);return()=>window.removeEventListener('hashchange',onHash);},[]);
  useEffect(()=>{document.documentElement.dataset.theme=theme;try{localStorage.setItem('iaero.preview.theme',theme);}catch{}},[theme]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),5000);return()=>clearTimeout(timer);},[toast]);
  const go=(p:Page)=>{setPage(p);window.location.hash=p;window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});};
  const connect=()=>{setConnected(true);setWalletDialog(false);saveWallet(wallet,activities);setToast('Demo wallet loaded. All balances and actions are local.');};
  const disconnect=()=>{if(pending.current)return;setConnected(false);setAction(null);try{localStorage.removeItem(DEMO_STORAGE_KEY);}catch{}setToast('Demo wallet disconnected.');};
  const reset=()=>{
    if(pending.current){setToast('Wait for the current simulation to finish.');return;}
    generation.current++;const fresh=initialWallet();setWallet(fresh);setActivities([]);setAction(null);
    setFlags({paused:false,rewardsUnavailable:false,nftEnabled:false});
    try{localStorage.removeItem(DEMO_STORAGE_KEY);}catch{}
    if(connected)saveWallet(fresh,[]);setToast('Sample balances restored.');
  };
  const execute=async(request:Action)=>{
    if(pending.current)throw Error('A simulation is already in progress.');
    if(!current.current.connected)throw Error('Load a demo wallet first.');
    pending.current=true;const ticket=generation.current;
    try{
      await new Promise(resolve=>setTimeout(resolve,850));
      if(ticket!==generation.current)throw Error('The preview changed. Review this action again.');
      const snapshot=current.current;
      if(snapshot.flags.paused&&['stake','autoStake','mint','nft'].includes(request.kind))throw Error('New deposits are paused. Withdrawals and claims remain available.');
      if(snapshot.flags.rewardsUnavailable&&['claim','autoClaim'].includes(request.kind))throw Error('Reward information is unavailable. Your principal is still withdrawable.');
      const next=applyAction(snapshot.wallet,request);
      const amount=['claim','legacyClaim','autoClaim'].includes(request.kind)?request.kind==='claim'?accrued(snapshot.wallet).earned:request.kind==='legacyClaim'?snapshot.wallet.legacyRewards:accrued(snapshot.wallet).autoEarned:request.amount;
      const token=['claim','legacyClaim','autoClaim','buy'].includes(request.kind)?'USDC':request.kind==='mint'?'AERO':'iAERO';
      const activity:Activity={id:crypto.randomUUID(),title:request.title,token,amount:tokenText(amount,token==='USDC'?6:18),direction:['claim','autoClaim','legacyClaim','unstake','autoUnstake','legacyWithdraw'].includes(request.kind)?'in':'out',time:Date.now()};
      const nextActivities=[activity,...snapshot.activities].slice(0,30);
      current.current={...snapshot,wallet:next,activities:nextActivities};setWallet(next);setActivities(nextActivities);saveWallet(next,nextActivities);
    }finally{pending.current=false;}
  };
  const value:Store={mode:'demo',disabledReason:()=>undefined,page,go,connected,connect,disconnect,wallet:accrued(wallet,clock),activities,flags,setFlags,
    walletDialog,setWalletDialog,action,setAction,execute,notify:setToast,toast,dismissToast:()=>setToast(''),reset,theme,toggleTheme:()=>setTheme(t=>t==='light'?'dark':'light')};
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function usePreview(){const store=useContext(Context);if(!store)throw Error('PreviewProvider is required.');return store;}
