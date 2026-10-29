import config from '../../config/wallet.public.json';
import {isAddress,type EIP1193Provider} from 'viem';
type MobileProvider=EIP1193Provider&{session?:unknown;connect:()=>Promise<void>;disconnect:()=>Promise<void>;on:(event:string,listener:(...args:any[])=>void)=>void;removeListener:(event:string,listener:(...args:any[])=>void)=>void};
let pending:Promise<MobileProvider>|undefined;
let pairing:Promise<MobileProvider>|undefined;
let scope=0;
const hasAccount=async(provider:MobileProvider)=>{try{const accounts=await provider.request({method:'eth_accounts'});return Array.isArray(accounts)&&accounts.some(a=>typeof a==='string'&&isAddress(a,{strict:false}));}catch{return false;}};
export async function mobileWalletProvider(pair?:true):Promise<MobileProvider>;
export async function mobileWalletProvider(pair:false):Promise<MobileProvider|undefined>;
export async function mobileWalletProvider(pair=true){
 const id=config.walletConnectProjectId;if(!/^[a-f0-9]{32}$/i.test(id??''))throw Error('Mobile wallet connection is not configured.');
 if(!pending){const init=import('@walletconnect/ethereum-provider').then(async({EthereumProvider})=>EthereumProvider.init({projectId:id,chains:[8453],optionalChains:[1,42161],showQrModal:true,metadata:{name:'iAERO',description:'Liquid AERO and USDC rewards',url:window.location.origin,icons:[new URL('/favicon.svg',window.location.origin).href]},rpcMap:{8453:'https://base-rpc.publicnode.com',1:'https://ethereum-rpc.publicnode.com',42161:'https://arb1.arbitrum.io/rpc'}}) as unknown as Promise<MobileProvider>).catch(()=>{if(pending===init)pending=undefined;throw Error('Mobile wallet connection could not initialize. Please retry.');});pending=init;}
 const initialization=pending,beganIn=scope,provider=await initialization,current=()=>pending===initialization&&scope===beganIn;
 const requireCurrent=()=>{if(!current())throw Error('The wallet connection changed. Please reconnect.');};
 if(!pair){const valid=provider.session&&await hasAccount(provider);return current()&&valid?provider:undefined;}
 requireCurrent();
 if(pairing)return pairing;
 const job=(async()=>{
  // [VERIFIED: @walletconnect/ethereum-provider 2.26.0, EthereumProvider.ts
  // loadPersistedSession/setAccounts/reset] A session object can outlive its
  // active-chain accounts. Never reuse that object as proof of authorization.
  const authorized=provider.session&&await hasAccount(provider);requireCurrent();if(authorized)return provider;
  if(provider.session){try{await provider.disconnect();}catch{throw Error('The saved wallet session could not be reset. Remove iAERO from your wallet’s connected apps, then reconnect.');}}
  requireCurrent();await provider.connect();requireCurrent();const valid=await hasAccount(provider);requireCurrent();if(!valid)throw Error('Wallet connection returned no account. Approve Base and an account in your wallet, then reconnect.');return provider;
 })().catch(error=>{if(current())pending=undefined;throw error;}).finally(()=>{if(pairing===job)pairing=undefined;});pairing=job;return job;
}
export async function disconnectMobileWallet(){const previous=pending;scope++;pending=undefined;pairing=undefined;const p=await previous;await p?.disconnect();}
