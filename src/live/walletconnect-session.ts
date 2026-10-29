import {getAddress,isAddress,type Address,type EIP1193Provider} from 'viem';

type SessionProvider=EIP1193Provider&{isWalletConnect?:boolean;chainId?:number;session?:any;signer?:{setDefaultChain:(chain:string)=>void|Promise<void>}};
// [VERIFIED: WalletConnect v2 SessionTypes.Namespace] A chain-scoped account
// and transaction method are approvals; an RPC URL or SDK chainId is not.
export function approvedSessionAccounts(provider:unknown,chainId:number):Address[]{
 const p=provider as SessionProvider,ns=p?.session?.namespaces,target='eip155:'+chainId,accounts:Address[]=[];
 if(!ns||typeof ns!=='object'||Array.isArray(ns)||!Number.isSafeInteger(chainId)||chainId<=0)return accounts;
 for(const [key,value]of Object.entries(ns)){const row=value as any;if(key!=='eip155'&&key!==target||!row||!Array.isArray(row.accounts)||!Array.isArray(row.methods)||!row.methods.includes('eth_sendTransaction'))continue;
  if(row.chains!==undefined&&(!Array.isArray(row.chains)||!row.chains.includes(target)))continue;
  for(const account of row.accounts){if(typeof account!=='string')continue;const [namespace,chain,address,...extra]=account.split(':');if(namespace==='eip155'&&chain===String(chainId)&&!extra.length&&isAddress(address??'',{strict:false})&&BigInt(address)!==0n)accounts.push(getAddress(address));}
 }
 return [...new Set(accounts)];
}
// [VERIFIED: @walletconnect/universal-provider 2.26.0 setDefaultChain and
// providers/eip155.ts] Select an already approved route locally. Fireblocks
// sessions must not receive a request to switch to an unapproved chain.
export async function selectApprovedSessionChain(provider:EIP1193Provider,chainId:number,expected?:Address):Promise<boolean>{
 const p=provider as SessionProvider;if(p.isWalletConnect!==true)return false;
 const accounts=approvedSessionAccounts(p,chainId),chosen=accounts[0],topic=p.session?.topic;
 if(!chosen)throw Error('Base is not approved for this account in the WalletConnect session. Reconnect WalletConnect and approve Base.');
 if(expected&&chosen.toLowerCase()!==expected.toLowerCase())throw Error('The approved Base account differs from this wallet. Reconnect and select the same Base account.');
 if(typeof p.signer?.setDefaultChain!=='function'||typeof topic!=='string'||!topic)throw Error('This WalletConnect session cannot select its approved Base network. Reconnect WalletConnect.');
 const valid=async()=>{
  if(p.session?.topic!==topic||!approvedSessionAccounts(p,chainId).some(a=>a.toLowerCase()===chosen.toLowerCase()))throw Error('The WalletConnect account or session changed. Reconnect before continuing.');
  let chain:unknown,rows:unknown;try{[chain,rows]=await Promise.all([p.request({method:'eth_chainId'}),p.request({method:'eth_accounts'})]);}catch{return false;}
  if(p.session?.topic!==topic||!approvedSessionAccounts(p,chainId).some(a=>a.toLowerCase()===chosen.toLowerCase()))throw Error('The WalletConnect account or session changed. Reconnect before continuing.');
  // EthereumProvider.request routes writes through its own chainId property.
  // Verify that field too; the inner provider's eth_chainId alone can disagree.
  try{return p.chainId===chainId&&Number(BigInt(chain as any))===chainId&&Array.isArray(rows)&&typeof rows[0]==='string'&&rows[0].toLowerCase()===chosen.toLowerCase();}catch{return false;}
 };
 if(await valid())return true;
 await p.signer.setDefaultChain('eip155:'+chainId);
 for(let i=0;i<4;i++){if(await valid())return true;if(i<3)await new Promise(r=>setTimeout(r,250*(i+1)));}
 throw Error('WalletConnect has not selected its approved Base account yet. Reconnect and approve Base before continuing.');
}
