import {ContractFunctionRevertedError,formatUnits,getAddress,isAddress,parseAbi,type Address,type Hash} from 'viem';
import type {Action,Activity,RewardLeg} from '../domain';
import type {BaseClient} from './client';
import type {Bootstrap} from './types';
import {mapReadBatches} from './read-concurrency';

// [VERIFIED: protocol/contracts/EpochStakingDistributor.sol:339-345]
export const CLAIM_MANY_ABI=parseAbi(['function claimMany(address[] tokens,uint256[] epochs)','function previewClaimsForEpoch(address user,address[] tokens,uint256 epoch) view returns(uint256[])','error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)','error SafeERC20FailedOperation(address token)']);
export const CLAIM_LIMIT=50;
export type RewardGroup={token:Address;symbol:string;decimals:number|null;amount:bigint;legs:RewardLeg[]};
export function groupRewards(rows:readonly RewardLeg[]):RewardGroup[]{
  const groups=new Map<string,RewardGroup>();
  for(const r of rows){
    const key=r.token.toLowerCase();let group=groups.get(key);
    if(!group){group={token:r.token,symbol:r.symbol,decimals:r.decimals,amount:0n,legs:[]};groups.set(key,group);}
    if(group.decimals!==r.decimals)group.decimals=null;
    group.amount+=r.amount;group.legs.push(r);
  }
  return [...groups.values()].sort((a,b)=>a.symbol.localeCompare(b.symbol)||a.token.localeCompare(b.token));
}
export function checkedLegs(rows:readonly RewardLeg[]|undefined):RewardLeg[]{
  if(!rows?.length||rows.length>4096)throw Error('Choose a non-empty reward selection of at most 4,096 token/week entries.');
  const seen=new Set<string>();
  return rows.map(r=>{
    if(!isAddress(r.token)||r.epoch<0n||r.epoch%604800n!==0n||r.amount<=0n||r.amount>=2n**256n)throw Error('A selected reward token, amount or week is invalid.');
    const key=r.token.toLowerCase()+':'+r.epoch;
    if(seen.has(key))throw Error('A reward token/week was selected more than once.');seen.add(key);
    return {...r,token:getAddress(r.token)};
  });
}
export function claimAction(rows:readonly RewardLeg[],all=false):Action{
  const legs=checkedLegs(rows),groups=groupRewards(legs),single=groups.length===1?groups[0]:undefined;
  return {kind:'legacyClaimMany',amount:single?.amount??0n,title:all?'Claim all selected rewards':'Claim '+(single?.symbol??'selected rewards'),
    description:`Claim ${groups.length} token${groups.length===1?'':'s'} across ${new Set(legs.map(r=>r.epoch)).size} selected reward weeks. Each batch contains up to 50 entries. Your principal stays in place.`,
    source:'Previous reward selection',target:'Your connected wallet',approval:false,rewardLegs:legs,tokenAddress:single?.token,tokenSymbol:single?.symbol,tokenDecimals:single?.decimals};
}
export type BlockedReward=RewardGroup&{balance?:bigint;reason:'insufficient-balance'|'transfer-reverted'};
export type RewardClaimPlan={user:Address;distributor:Address;eligible:RewardLeg[];settled:RewardLeg[];blocked:BlockedReward[];groups:RewardLeg[][];block:bigint;checkedAt:number};
const rewardBalanceAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function paused() view returns(bool)','function totalStaked() view returns(uint256)']);
const uint=(value:unknown):value is bigint=>typeof value==='bigint'&&value>=0n&&value<2n**256n;
const reverted=(error:unknown)=>{for(let e:any=error,n=0;e&&n<12;e=e.cause,n++)if(e instanceof ContractFunctionRevertedError)return true;return false;};
// [VERIFIED: EpochStakingDistributor.sol:339-370] A failed transfer reverts the
// entire batch. Preview entitlement and the distributor's ability to pay are
// separate facts. Sum all selected weeks of a token before checking its funds.
export async function previewRewardClaims(client:BaseClient,distributor:Address,user:Address,selection:readonly RewardLeg[],boot?:Bootstrap):Promise<RewardClaimPlan>{
 const rows=checkedLegs(selection);if(!isAddress(distributor)||!isAddress(user))throw Error('The claim account or contract is invalid.');
 const block=await client.getBlock();if(typeof block.number!=='bigint'||block.number<0n)throw Error('Fresh Base reward reads are unavailable.');
 const epochs=new Map<bigint,RewardLeg[]>();for(const r of rows){const list=epochs.get(r.epoch)??[];list.push(r);epochs.set(r.epoch,list);}
 const jobs:any[]=[{address:distributor,abi:rewardBalanceAbi,functionName:'paused',args:[]}],previews:{index:number;rows:RewardLeg[]}[]=[],balances=new Map<string,number>(),groups=groupRewards(rows);
 for(const [epoch,legs]of epochs)for(let i=0;i<legs.length;i+=64){const part=legs.slice(i,i+64);previews.push({index:jobs.length,rows:part});jobs.push({address:distributor,abi:CLAIM_MANY_ABI,functionName:'previewClaimsForEpoch',args:[user,part.map(r=>r.token),epoch]});}
 for(const g of groups)if(BigInt(g.token)!==0n){balances.set(g.token.toLowerCase(),jobs.length);jobs.push({address:g.token,abi:rewardBalanceAbi,functionName:'balanceOf',args:[distributor]});}
 const principalIndex=boot&&groups.some(g=>g.token.toLowerCase()===boot.registry.legacy.iAERO.toLowerCase())?jobs.length:undefined;
 if(principalIndex!==undefined)jobs.push({address:distributor,abi:rewardBalanceAbi,functionName:'totalStaked',args:[]});
 let native:bigint|undefined;const nativeRead=groups.some(g=>BigInt(g.token)===0n)?Promise.resolve().then(()=>client.getBalance({address:distributor,blockNumber:block.number})).then(v=>{if(uint(v))native=v;}).catch(()=>{}):Promise.resolve();
 let results:any[];
 if(boot?.contracts?.multicall3?.deployed&&typeof client.multicall==='function')results=await client.multicall({multicallAddress:boot.registry.sweep.multicall3,contracts:jobs,allowFailure:true,blockNumber:block.number,batchSize:16384}) as any;
 else results=await mapReadBatches(jobs,async job=>{try{return {status:'success',result:await client.readContract({...job,blockNumber:block.number})};}catch(error){return {status:'failure',error};}});
 await nativeRead;if(results.length!==jobs.length)throw Error('Grouped reward reads are incomplete. Recheck availability before claiming.');
 const result=(i:number)=>results[i]?.status==='success'?results[i].result:undefined;
 if(result(0)!==false)throw Error('Previous rewards are paused or their status is unavailable. Recheck before claiming.');
 const current=new Map<string,bigint>();for(const p of previews){const values=result(p.index);if(!Array.isArray(values)||values.length!==p.rows.length||!values.every(uint))throw Error('Reward previews are unavailable. Recheck availability; no token is marked unpayable.');p.rows.forEach((r,i)=>current.set(r.token.toLowerCase()+':'+r.epoch,values[i]));}
 const positive=rows.flatMap(r=>{const amount=current.get(r.token.toLowerCase()+':'+r.epoch)!;return amount>0n?[{...r,amount}]:[];}),settled=rows.filter(r=>current.get(r.token.toLowerCase()+':'+r.epoch)===0n),blocked:BlockedReward[]=[];
 for(const g of groupRewards(positive)){let value=BigInt(g.token)===0n?native:result(balances.get(g.token.toLowerCase())!);
  // [VERIFIED: EpochStakingDistributor.sol:45-58,196-215] iAERO held for
  // principal is a separate liability and is never reward funding.
  if(boot&&g.token.toLowerCase()===boot.registry.legacy.iAERO.toLowerCase()){const principal=principalIndex===undefined?undefined:result(principalIndex);if(!uint(value)||!uint(principal))throw Error('Reward funding and staked principal could not be checked. Recheck before claiming.');value=value>principal?value-principal:0n;}
  if(uint(value)&&value<g.amount)blocked.push({...g,balance:value,reason:'insufficient-balance'});
 }
 let eligible=positive.filter(r=>!blocked.some(b=>b.token.toLowerCase()===r.token.toLowerCase())),planned:RewardLeg[][]=[];
 const check=async(batch:RewardLeg[]):Promise<void>=>{
  if(!batch.length)return;
  try{await client.simulateContract({address:distributor,abi:CLAIM_MANY_ABI,functionName:'claimMany',args:[batch.map(r=>r.token),batch.map(r=>r.epoch)],account:user,blockNumber:block.number});planned.push(batch);}
  catch(error){if(!reverted(error))throw Error('Reward transfer simulation is unavailable. Recheck availability; no token is marked unpayable.');const tokens=[...new Set(batch.map(r=>r.token.toLowerCase()))];if(tokens.length===1){const group=groupRewards(positive.filter(r=>r.token.toLowerCase()===tokens[0]))[0];if(!blocked.some(b=>b.token.toLowerCase()===tokens[0]))blocked.push({...group,reason:'transfer-reverted'});return;}const half=new Set(tokens.slice(0,Math.floor(tokens.length/2)));await check(batch.filter(r=>half.has(r.token.toLowerCase())));await check(batch.filter(r=>!half.has(r.token.toLowerCase())));}
 };
 for(let i=0;i<eligible.length;i+=CLAIM_LIMIT)await check(eligible.slice(i,i+CLAIM_LIMIT));
 if(blocked.some(b=>b.reason==='transfer-reverted')){
  // A token can span chunks. Remove all its selected weeks, then simulate the
  // final combined healthy groups instead of assuming isolated calls compose.
  for(let pass=0;pass<=groups.length;pass++){const count=blocked.length;eligible=positive.filter(r=>!blocked.some(b=>b.token.toLowerCase()===r.token.toLowerCase()));planned=[];for(let i=0;i<eligible.length;i+=CLAIM_LIMIT)await check(eligible.slice(i,i+CLAIM_LIMIT));if(blocked.length===count)break;}
 }
 eligible=positive.filter(r=>!blocked.some(b=>b.token.toLowerCase()===r.token.toLowerCase()));
 return {user,distributor,eligible,settled,blocked,groups:planned,block:block.number,checkedAt:Date.now()};
}
export async function sendRewardClaims(args:{client:BaseClient;distributor:Address;user:Address;rows:readonly RewardLeg[];boot?:Bootstrap;send:(address:Address,abi:readonly unknown[],name:string,args:readonly unknown[])=>Promise<Hash>;onBatch?:(number:number,total:number)=>void;onProgress?:(text:string)=>void;onConfirmed?:(activity:Activity)=>void}){
  const rows=checkedLegs(args.rows),hashes:Hash[]=[],activities:Activity[]=[];
  args.onProgress?.('Rechecking selected reward payouts…');
  const initial=await previewRewardClaims(args.client,args.distributor,args.user,rows,args.boot);
  if(initial.blocked.length)throw Error('Some selected rewards cannot currently be paid. Recheck availability and review the payable rewards before claiming.');
  for(let start=0;start<rows.length;start+=CLAIM_LIMIT){
    const selected=rows.slice(start,start+CLAIM_LIMIT),number=Math.floor(start/CLAIM_LIMIT)+1,total=Math.ceil(rows.length/CLAIM_LIMIT);
    args.onBatch?.(number,total);
    args.onProgress?.(`Checking claim batch ${number} of ${total}…`);
    // Re-read the exact selection. Failures are not treated as zero and never
    // silently drop a token. claimMany itself is idempotent for a settled leg.
    const plan=start===0?{...initial,eligible:initial.eligible.filter(r=>selected.some(s=>s.token.toLowerCase()===r.token.toLowerCase()&&s.epoch===r.epoch))}:await previewRewardClaims(args.client,args.distributor,args.user,selected,args.boot);
    if(plan.blocked.length)throw Error('Some selected rewards cannot currently be paid. Recheck availability and review the payable rewards before claiming.');
    if(!plan.eligible.length)continue;
    const batch=plan.eligible;
    args.onProgress?.(`Preparing claim batch ${number} of ${total}…`);
    const hash=await args.send(args.distributor,CLAIM_MANY_ABI,'claimMany',[batch.map(r=>r.token),batch.map(r=>r.epoch)]);
    hashes.push(hash);
    const groups=groupRewards(batch),activity:Activity={id:hash,hash,title:`Claim legacy rewards${total>1?' · batch '+number:''}`,token:groups.length===1?groups[0].symbol:'tokens',amount:groups.length===1?(groups[0].decimals===null?groups[0].amount.toString()+' raw units':formatUnits(groups[0].amount,groups[0].decimals)):String(groups.length),direction:'in',time:Date.now()};
    activities.push(activity);args.onConfirmed?.(activity);
  }
  if(!hashes.length)throw Error('No selected rewards remain claimable. Refresh your balances.');
  return {hash:hashes.at(-1)!,hashes,activity:activities.at(-1)!,activities};
}
