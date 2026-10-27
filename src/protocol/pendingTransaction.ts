import type {Address,Hash} from 'viem';
import type {ReadClient} from './streamingClient';
export type PendingTransaction={version:1;attempt:string;chainId:number;user:Address;to:Address;action:string;hash?:Hash;replaced?:boolean};
const key=(chainId:number,user:Address)=>`saero:pending:${chainId}:${user.toLowerCase()}`;
const changed=()=>window.dispatchEvent(new Event('saero:pending-changed'));
export function pendingTransaction(chainId:number,user:Address):PendingTransaction|null{
 const raw=window.localStorage.getItem(key(chainId,user));if(!raw)return null;const p=JSON.parse(raw);
 if(p.version!==1||p.chainId!==chainId||p.user?.toLowerCase()!==user.toLowerCase()||typeof p.attempt!=='string'||typeof p.action!=='string'||p.hash!==undefined&&!/^0x[0-9a-fA-F]{64}$/.test(p.hash))throw Error('The saved transaction record needs wallet review.');return p;
}
function write(p:PendingTransaction){window.localStorage.setItem(key(p.chainId,p.user),JSON.stringify(p));changed();}
function clear(p:PendingTransaction){if(pendingTransaction(p.chainId,p.user)?.attempt!==p.attempt)throw Error('The pending transaction changed. Review wallet activity.');window.localStorage.removeItem(key(p.chainId,p.user));changed();}
async function locked<T>(chainId:number,user:Address,run:()=>Promise<T>):Promise<T>{
 if(!navigator.locks)throw Error('Update your browser before sending a wallet transaction.');
 return navigator.locks.request(key(chainId,user),{ifAvailable:true},async lock=>{if(!lock)throw Error('Another wallet transaction is being confirmed.');return run();});
}
async function exactReceipt(client:ReadClient,p:PendingTransaction){
 if(!p.hash||p.replaced||!client.getTransactionReceipt)return false;
 try{const r=await client.getTransactionReceipt({hash:p.hash});return r.transactionHash?.toLowerCase()===p.hash.toLowerCase()&&['success','reverted'].includes(r.status);}catch{return false;}
}
// Shared across components, tabs and reloads. A thrown wallet request may have broadcast;
// only explicit user rejection or an exact terminal receipt permits automatic clearance.
export async function trackBrowserTransaction<T>(client:ReadClient,request:Omit<PendingTransaction,'version'|'attempt'>,run:(journal:{broadcast(hash:Hash):void;replaced():void;complete():void})=>Promise<T>):Promise<T>{
 if(typeof window==='undefined')throw Error('Wallet transactions require a browser.');
 return locked(request.chainId,request.user,async()=>{
  const previous=pendingTransaction(request.chainId,request.user);
  if(previous){if(await exactReceipt(client,previous)){clear(previous);throw Error(`Your previous transaction has a receipt. Refresh and review your balances before starting another: ${previous.hash}`);}throw Error('A previous transaction is unresolved. Review the pending transaction notice and your wallet activity.');}
  const record:PendingTransaction={...request,version:1,attempt:crypto.randomUUID()};write(record);
  try{return await run({broadcast(hash){if(!/^0x[0-9a-fA-F]{64}$/.test(hash))throw Error('The wallet returned an invalid transaction hash.');record.hash=hash;write(record);},replaced(){record.replaced=true;write(record);},complete(){clear(record);}});}
  catch(error){let e:any=error;for(let i=0;i<8&&e;i++,e=e.cause){if(e.code===4001&&!record.hash){clear(record);break;}}throw error;}
 });
}
export async function reviewPendingTransaction(client:ReadClient,chainId:number,user:Address,attestWalletStopped=false){
 return locked(chainId,user,async()=>{
  if(await client.getChainId()!==chainId)throw Error('Switch back to the transaction network.');
  const p=pendingTransaction(chainId,user);if(!p)return;
  if(await exactReceipt(client,p)||attestWalletStopped){clear(p);return;}
  throw Error('No exact final receipt is available. Check your wallet, including pending and replacement transactions.');
 });
}
