import {formatUnits,getAddress,isAddress,parseAbi,type Address,type Hash} from 'viem';
import type {Action,Activity,RewardLeg} from '../domain';
import type {BaseClient} from './client';

// [VERIFIED: protocol/contracts/EpochStakingDistributor.sol:339-345]
export const CLAIM_MANY_ABI=parseAbi(['function claimMany(address[] tokens,uint256[] epochs)','function previewClaimsForEpoch(address user,address[] tokens,uint256 epoch) view returns(uint256[])']);
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
export async function sendRewardClaims(args:{client:BaseClient;distributor:Address;user:Address;rows:readonly RewardLeg[];send:(address:Address,abi:readonly unknown[],name:string,args:readonly unknown[])=>Promise<Hash>;onProgress?:(text:string)=>void;onConfirmed?:(activity:Activity)=>void}){
  const rows=checkedLegs(args.rows),hashes:Hash[]=[],activities:Activity[]=[];
  for(let start=0;start<rows.length;start+=CLAIM_LIMIT){
    const batch=rows.slice(start,start+CLAIM_LIMIT),number=Math.floor(start/CLAIM_LIMIT)+1,total=Math.ceil(rows.length/CLAIM_LIMIT);
    args.onProgress?.(`Checking claim batch ${number} of ${total}…`);
    // Re-read the exact selection. Failures are not treated as zero and never
    // silently drop a token. claimMany itself is idempotent for a settled leg.
    const values=await Promise.all(batch.map(r=>args.client.readContract({address:args.distributor,abi:parseAbi(['function previewClaim(address,address,uint256) view returns(uint256)']),functionName:'previewClaim',args:[args.user,r.token,r.epoch]})));
    if(!values.some(v=>v>0n)){if(!hashes.length&&start+CLAIM_LIMIT>=rows.length)throw Error('The selected rewards are already settled. Refresh your balances.');continue;}
    args.onProgress?.(`Confirm claim batch ${number} of ${total} in your wallet`);
    const hash=await args.send(args.distributor,CLAIM_MANY_ABI,'claimMany',[batch.map(r=>r.token),batch.map(r=>r.epoch)]);
    hashes.push(hash);
    const groups=groupRewards(batch),activity:Activity={id:hash,hash,title:`Claim legacy rewards${total>1?' · batch '+number:''}`,token:groups.length===1?groups[0].symbol:'tokens',amount:groups.length===1?(groups[0].decimals===null?groups[0].amount.toString()+' raw units':formatUnits(groups[0].amount,groups[0].decimals)):String(groups.length),direction:'in',time:Date.now()};
    activities.push(activity);args.onConfirmed?.(activity);
  }
  if(!hashes.length)throw Error('No selected rewards remain claimable. Refresh your balances.');
  return {hash:hashes.at(-1)!,hashes,activity:activities.at(-1)!,activities};
}
