import config from '../../config/wallet.public.json';
import type {EIP1193Provider} from 'viem';
type MobileProvider=EIP1193Provider&{session?:unknown;connect:()=>Promise<void>;disconnect:()=>Promise<void>;on:(event:string,listener:(...args:any[])=>void)=>void;removeListener:(event:string,listener:(...args:any[])=>void)=>void};
let pending:Promise<MobileProvider>|undefined;
export async function mobileWalletProvider(pair?:true):Promise<MobileProvider>;
export async function mobileWalletProvider(pair:false):Promise<MobileProvider|undefined>;
export async function mobileWalletProvider(pair=true){
 const id=config.walletConnectProjectId;if(!/^[a-f0-9]{32}$/i.test(id??''))throw Error('Mobile wallet connection is not configured.');
 pending??=import('@walletconnect/ethereum-provider').then(async({EthereumProvider})=>EthereumProvider.init({projectId:id,chains:[8453],optionalChains:[1,42161],showQrModal:true,metadata:{name:'iAERO',description:'Liquid AERO and USDC rewards',url:window.location.origin,icons:[new URL('/favicon.svg',window.location.origin).href]},rpcMap:{8453:'https://base-rpc.publicnode.com',1:'https://ethereum-rpc.publicnode.com',42161:'https://arb1.arbitrum.io/rpc'}}) as unknown as Promise<MobileProvider>).catch(()=>{pending=undefined;throw Error('Mobile wallet connection could not initialize. Please retry.');});
 const provider=await pending;if(!provider.session){if(!pair)return;await provider.connect();}return provider;
}
export async function disconnectMobileWallet(){const previous=pending;pending=undefined;const p=await previous;await p?.disconnect();}
