import config from '../../config/wallet.public.json';
import type {EIP1193Provider} from 'viem';
import {selectApprovedSessionChain} from './walletconnect-session';
type MobileProvider=EIP1193Provider&{session?:unknown;connect:()=>Promise<void>;disconnect:()=>Promise<void>;on:(event:string,listener:(...args:any[])=>void)=>void;removeListener:(event:string,listener:(...args:any[])=>void)=>void};
let pending:Promise<MobileProvider>|undefined;
let pairing:Promise<MobileProvider>|undefined;
let scope=0;
const hasBaseAccount=async(provider:MobileProvider)=>{try{return !!provider.session&&await selectApprovedSessionChain(provider,8453);}catch{return false;}};
export async function mobileWalletProvider(pair?:true):Promise<MobileProvider>;
export async function mobileWalletProvider(pair:false):Promise<MobileProvider|undefined>;
export async function mobileWalletProvider(pair=true){
 const id=config.walletConnectProjectId;if(!/^[a-f0-9]{32}$/i.test(id??''))throw Error('Mobile wallet connection is not configured.');
 // Match the previous Wagmi connector's Base-first optional proposal. In SDK
 // 2.26.0, mixing required Base with optional [1,42161] overwrites Base when
 // UniversalProvider merges deprecated required namespaces into optional ones.
 if(!pending){const init=import('@walletconnect/ethereum-provider').then(async({EthereumProvider})=>EthereumProvider.init({projectId:id,optionalChains:[8453,1,42161],showQrModal:true,metadata:{name:'iAERO',description:'Liquid AERO and USDC rewards',url:window.location.origin,icons:[new URL('/favicon.svg',window.location.origin).href]},rpcMap:{8453:new URL('/api/base',window.location.origin).href,1:'https://ethereum-rpc.publicnode.com',42161:'https://arb1.arbitrum.io/rpc'}}) as unknown as Promise<MobileProvider>).catch(()=>{if(pending===init)pending=undefined;throw Error('Mobile wallet connection could not initialize. Please retry.');});pending=init;}
 const initialization=pending,beganIn=scope,provider=await initialization,current=()=>pending===initialization&&scope===beganIn;
 const requireCurrent=()=>{if(!current())throw Error('The wallet connection changed. Please reconnect.');};
 if(!pair){const valid=await hasBaseAccount(provider);return current()&&valid?provider:undefined;}
 requireCurrent();
 if(pairing)return pairing;
 const job=(async()=>{
  // [VERIFIED: @walletconnect/ethereum-provider 2.26.0, EthereumProvider.ts
  // loadPersistedSession/setAccounts/reset] A session object can outlive its
  // active-chain accounts. Never reuse that object as proof of authorization.
  const authorized=await hasBaseAccount(provider);requireCurrent();if(authorized)return provider;
  if(provider.session){try{await provider.disconnect();}catch{throw Error('The saved wallet session could not be reset. Remove iAERO from your wallet’s connected apps, then reconnect.');}}
  requireCurrent();await provider.connect();requireCurrent();const valid=await hasBaseAccount(provider);requireCurrent();if(!valid)throw Error('WalletConnect did not approve a Base account for transactions. Reconnect and select Base in your wallet.');return provider;
 })().catch(error=>{if(current())pending=undefined;throw error;}).finally(()=>{if(pairing===job)pairing=undefined;});pairing=job;return job;
}
export async function disconnectMobileWallet(){const previous=pending;scope++;pending=undefined;pairing=undefined;const p=await previous;await p?.disconnect();}
