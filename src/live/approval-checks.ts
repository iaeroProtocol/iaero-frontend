import {parseAbi,type Address} from 'viem';
import type {BaseClient} from './client';
import type {Bootstrap} from './types';
import {mapReadBatches} from './read-concurrency';
export type ApprovalCheck={token:Address;spender:Address;balance?:bigint;allowance?:bigint;error?:string};
export type ApprovalRequest={token:Address;spender:Address;policy?:{router:Address;selector:`0x${string}`;amount:bigint}};
const abi=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function agg0x() view returns(address)','function allowedSelectors(address,bytes4) view returns(bool)','function dustFloor(address) view returns(uint256)']);
export const approvalKey=(token:Address,spender:Address)=>token.toLowerCase()+':'+spender.toLowerCase();
// Balance, approval and swapper-policy checks share one current pinned snapshot.
// Unknown results stay unknown; an RPC failure never becomes a zero allowance.
export async function readApprovalChecks(client:BaseClient,boot:Bootstrap,user:Address,requests:readonly ApprovalRequest[]){
 const unique=[...new Map(requests.map(r=>[approvalKey(r.token,r.spender),r])).values()],checks=new Map<string,ApprovalCheck>();
 if(!unique.length)return checks;
 const block=await client.getBlock(),tokens=[...new Map(unique.map(r=>[r.token.toLowerCase(),r.token])).values()];
 const jobs:any[]=[...tokens.map(token=>({address:token,abi,functionName:'balanceOf',args:[user]})),...unique.map(r=>({address:r.token,abi,functionName:'allowance',args:[user,r.spender]}))];
 const policies=new Map<string,{router:number;allowed:number;floor:number}>();let routerIndex:number|undefined;
 for(const r of unique)if(r.policy){
  if(routerIndex===undefined){routerIndex=jobs.length;jobs.push({address:boot.registry.sweep.swapper,abi,functionName:'agg0x'});}
  const allowed=jobs.length;jobs.push({address:boot.registry.sweep.swapper,abi,functionName:'allowedSelectors',args:[r.policy.router,r.policy.selector]});
  const floor=jobs.length;jobs.push({address:boot.registry.sweep.swapper,abi,functionName:'dustFloor',args:[r.token]});
  policies.set(approvalKey(r.token,r.spender),{router:routerIndex,allowed,floor});
 }
 let results:({status:'success';result:unknown}|{status:'failure'})[];
 if(boot.contracts?.multicall3?.deployed&&typeof client.multicall==='function')results=await client.multicall({multicallAddress:boot.registry.sweep.multicall3,contracts:jobs,allowFailure:true,blockNumber:block.number,batchSize:16384}) as any;
 else{results=new Array(jobs.length);await mapReadBatches(jobs,async(job,index)=>{try{results[index]={status:'success',result:await client.readContract({...job,blockNumber:block.number})};}catch{results[index]={status:'failure'};}});}
 if(results.length!==jobs.length)throw Error('The grouped approval check response is incomplete. Refresh before continuing.');
 const result=(index:number)=>results[index]?.status==='success'?(results[index] as {result:unknown}).result:undefined;
 const uint=(v:unknown):v is bigint=>typeof v==='bigint'&&v>=0n&&v<2n**256n;
 const balances=new Map(tokens.map((token,i)=>[token.toLowerCase(),result(i)]));
 unique.forEach((r,i)=>{
  const balance=balances.get(r.token.toLowerCase()),allowance=result(tokens.length+i),policy=policies.get(approvalKey(r.token,r.spender));let error:string|undefined;
  if(!uint(balance)||!uint(allowance))error='This token’s balance or allowance could not be read. Retry its checks before approving.';
  if(policy&&r.policy){const router=result(policy.router),floor=result(policy.floor),allowed=result(policy.allowed);
   if(typeof router!=='string'||allowed!==true||router.toLowerCase()!==r.policy.router.toLowerCase())error='The deployed swapper does not permit this quote router or selector.';
   else if(!uint(floor))error='The swapper minimum could not be read. Retry the checks.';
   else if(r.policy.amount<floor)error='This amount is below the swapper’s on-chain minimum. It remains in your wallet.';
  }
  checks.set(approvalKey(r.token,r.spender),{token:r.token,spender:r.spender,...(uint(balance)&&uint(allowance)?{balance,allowance}:{}),...(error?{error}:{})});
 });
 return checks;
}
