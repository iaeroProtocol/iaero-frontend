import {decodeEventLog,parseAbi,type Address,type Hash} from 'viem';
import type {BaseClient} from './client';
const TRANSFER=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
// Selection derives from tokens actually paid, not a stale preview or all of a
// user's existing wallet balance. Native ETH is deliberately left unswept.
// Net debits are retained until all sources finish, so transfer taxes/burns
// cannot make pre-existing wallet tokens look newly received.
export async function claimedTokenAmounts(client:BaseClient,user:Address,source:Address,tokens:readonly Address[],hashes:readonly Hash[]){
 const wanted=new Set(tokens.filter(t=>BigInt(t)!==0n).map(t=>t.toLowerCase())),amounts=new Map<Address,bigint>();
 for(const hash of [...new Set(hashes)]){
  const receipt=await client.getTransactionReceipt({hash});
  if(receipt.status!=='success'||!same(receipt.transactionHash,hash)||!same(receipt.from,user)||!receipt.to||!same(receipt.to,source))throw Error('A claim receipt could not be verified. Select wallet amounts explicitly before converting.');
  for(const log of receipt.logs){if(!wanted.has(log.address.toLowerCase()))continue;try{const event=decodeEventLog({abi:TRANSFER,data:log.data,topics:log.topics});const token=log.address.toLowerCase() as Address;let delta=0n;if(same(event.args.from,source)&&same(event.args.to,user))delta+=event.args.value;if(same(event.args.from,user)&&!same(event.args.to,user))delta-=event.args.value;if(delta)amounts.set(token,(amounts.get(token)??0n)+delta);}catch{}}
 }
 return amounts;
}
