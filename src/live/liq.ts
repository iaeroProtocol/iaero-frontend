import {ContractFunctionRevertedError,getAddress,isAddress,parseAbi,type Address} from 'viem';
import type {BaseClient,ExecutionContext} from './client';
import type {Bootstrap} from './types';
import {STAKING_ERC20_ABI} from '../protocol/streamingClient';
import {accountReadClient} from './account-read-client';
export const LIQ_STAKING_ABI=parseAbi([
 'error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)',
 'function LIQ() view returns(address)','function LOCK_PERIOD() view returns(uint256)',
 'function totalLIQStaked() view returns(uint256)','function balanceOf(address) view returns(uint256)',
 'function unlockTime(address) view returns(uint256)','function paused() view returns(bool)',
 'function maxStakePerUser() view returns(uint256)','function maxTotalStaked() view returns(uint256)',
 'function getPendingRewards(address) view returns(address[],uint256[])','function creditOf(address,address) view returns(uint256)',
 'function accRewardPerShare(address) view returns(uint256)','function rewardDebt(address,address) view returns(uint256)','function PRECISION() view returns(uint256)',
 'function stake(uint256)','function unstake(uint256)','function claimMany(address[])','function claimReward(address)',
 'function withdrawCredit(address,uint256,address)'
]);
const meta=parseAbi(['function symbol() view returns(string)','function decimals() view returns(uint8)']);
export type LiqReward={token:Address;amount:bigint;credit?:bigint;symbol:string;decimals:number|null;retired?:boolean};
export type LiqPosition={balance?:bigint;wallet?:bigint;unlockTime?:number;timestamp:number;readAtMs:number;total?:bigint;paused?:boolean;maxUser?:bigint;maxTotal?:bigint;enumeratedTokens?:number;checkedRewardTokens?:Address[];rewards:LiqReward[];errors:string[]};
type Options={additionalTokens?:readonly Address[];rewards?:boolean;stakeSummaryOnly?:boolean;metadata?:boolean};
const uint=(v:unknown):v is bigint=>typeof v==='bigint'&&v>=0n&&v<2n**256n;
async function mapBounded<T,R>(items:readonly T[],run:(item:T)=>Promise<R>){
 const rows:R[]=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(items.length,4)},async()=>{while(next<items.length){const i=next++;rows[i]=await run(items[i]);}}));return rows;
}
export async function readLiq(client:BaseClient,boot:Bootstrap,user:Address,options:Options={}):Promise<LiqPosition>{
 const address=boot.registry.liqStaking?.distributor;if(!address||!boot.liqStakingReady)throw Error('LIQ staking contract links are unavailable.');
 const block=await client.getBlock(),position:LiqPosition={timestamp:Number(block.timestamp),readAtMs:Date.now(),rewards:[],errors:[]};
 const read=(functionName:string,args:unknown[]=[]):Promise<any>=>client.readContract({address,abi:LIQ_STAKING_ABI,functionName,args,blockNumber:block.number} as any);
 const jobs=[['balance',()=>read('balanceOf',[user])],['wallet',()=>client.readContract({address:boot.registry.legacy.LIQ,abi:STAKING_ERC20_ABI,functionName:'balanceOf',args:[user],blockNumber:block.number})],['unlockTime',()=>read('unlockTime',[user]).then(Number)],['total',()=>read('totalLIQStaked')],['paused',()=>read('paused')],['maxUser',()=>read('maxStakePerUser')],['maxTotal',()=>read('maxTotalStaked')]] as const;
 await Promise.all(jobs.filter(([key])=>!options.stakeSummaryOnly||['balance','unlockTime','paused'].includes(key)).map(async([key,run])=>{try{(position as any)[key]=await run();}catch{position.errors.push('LIQ '+key+' unavailable.');}}));
 if(options.rewards===false)return position;
 const amounts=new Map<Address,bigint>();
 try{
  const result=await read('getPendingRewards',[user]);if(!Array.isArray(result)||result.length!==2)throw Error();
  const [tokens,values]=result;
  // [VERIFIED: LIQStakingDistributorV2.setMaxRewardTokens] The contract permits
  // up to 1,000 registered tokens. Its 50-token claim limit is a separate bound.
  if(!Array.isArray(tokens)||!Array.isArray(values)||tokens.length!==values.length||tokens.length>1000||!tokens.every((t:unknown)=>typeof t==='string'&&isAddress(t))||!values.every(uint))throw Error();
  for(let i=0;i<tokens.length;i++){const token=getAddress(tokens[i]);if(amounts.has(token))throw Error();amounts.set(token,values[i]);}
  position.enumeratedTokens=tokens.length;
 }catch{position.errors.push('LIQ rewards unavailable. Known principal is preserved.');}
 const registered=new Set(amounts.keys()),extra=[...new Set((options.additionalTokens??[]).map(t=>{if(!isAddress(t))throw Error('Enter a valid reward token address.');return getAddress(t);}))];
 if(extra.length>1050||extra.filter(t=>!registered.has(t)).length>50)throw Error('Check at most 50 unlisted LIQ reward tokens at once.');
 // Retired tokens retain their accumulator/debt and withdrawal-credit mappings.
 // They are intentionally absent from getPendingRewards enumeration.
 await mapBounded(extra.filter(t=>!registered.has(t)),async token=>{
  try{const [acc,debt,precision,credit]=await Promise.all([read('accRewardPerShare',[token]),read('rewardDebt',[user,token]),read('PRECISION'),read('creditOf',[user,token])]);if(![acc,debt,precision,credit].every(uint)||precision<=0n||position.balance===undefined)throw Error();const pending=acc>debt?position.balance*(BigInt(acc)-BigInt(debt))/BigInt(precision):0n;if(!uint(pending+credit))throw Error();amounts.set(token,pending+credit);}catch{position.errors.push('Reward or credit read unavailable for '+token+'.');}
 });
 const positive=[...amounts].filter(([,amount])=>amount>0n);
 const rows=await mapBounded(positive,async([token,amount]):Promise<LiqReward>=>{
  let decimals:number|null=null,symbol=token.slice(0,6)+'…'+token.slice(-4),credit:bigint|undefined;
  if(BigInt(token)===0n){decimals=18;symbol='ETH';}
  else if(options.metadata!==false){const values=await Promise.allSettled([client.readContract({address:token,abi:meta,functionName:'decimals',blockNumber:block.number}),client.readContract({address:token,abi:meta,functionName:'symbol',blockNumber:block.number})]);
   if(values[0].status==='fulfilled'){const d=Number(values[0].value);if(Number.isInteger(d)&&d>=0&&d<=36)decimals=d;}
   if(values[1].status==='fulfilled')symbol=String(values[1].value).replace(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,32)||symbol;
  }
  try{const value=await read('creditOf',[user,token]);if(!uint(value)||value>amount)throw Error();credit=value;}catch{position.errors.push('Withdrawal credit preview unavailable for '+token+'.');}
  return {token,amount,credit,decimals,symbol,retired:extra.includes(token)&&!registered.has(token)};
 });
 position.rewards=rows;position.checkedRewardTokens=[...amounts.keys()];return position;
}
export type LiqClaimPreview={eligible:LiqReward[];blocked:{token:Address;reason:string}[];groups:Address[][];checkedAt:number};
export async function previewLiqClaims(client:BaseClient,boot:Bootstrap,user:Address,rows:readonly LiqReward[]):Promise<LiqClaimPreview>{
 const address=boot.registry.liqStaking?.distributor;if(!address||!boot.liqStakingReady)throw Error('LIQ staking is not verified.');
 if(rows.length>1050||rows.some(r=>!isAddress(r.token)||!uint(r.amount)||r.amount<=0n)||new Set(rows.map(r=>r.token.toLowerCase())).size!==rows.length)throw Error('Select valid LIQ reward tokens.');
 const block=await client.getBlock(),groups:Address[][]=[],blocked:LiqClaimPreview['blocked']=[];
 const simulate=(functionName:'claimMany'|'withdrawCredit',args:readonly unknown[])=>client.simulateContract({address,abi:LIQ_STAKING_ABI,functionName,args,account:user,blockNumber:block.number} as any);
 const reason=(error:unknown)=>{
  for(let e:any=error,n=0;e&&n<12;e=e.cause,n++)if(e instanceof ContractFunctionRevertedError)return e.data?.errorName==='ERC20InsufficientBalance'?'The distributor has insufficient balance for this reward. It remains unclaimed.':'This reward transfer does not pass simulation. It remains unclaimed.';
  // An RPC outage or HTTP 401 is not evidence that a token cannot be claimed.
  throw Error('LIQ claim simulation is unavailable. Refresh to retry; no reward is marked unclaimable.');
 };
 // [VERIFIED: LIQStakingDistributorV2.withdrawCredit] Existing credits are
 // separate transfers. Check them before including the token in a claim.
 for(const row of rows)if(row.credit!==undefined&&row.credit>0n){try{await simulate('withdrawCredit',[row.token,row.credit,user]);}catch(e){blocked.push({token:row.token,reason:reason(e)});}}
 const pending=rows.filter(r=>!blocked.some(b=>b.token===r.token)&&(r.credit===undefined||r.amount>r.credit)).map(r=>r.token);
 async function check(tokens:Address[]):Promise<void>{
  try{await simulate('claimMany',[tokens]);groups.push(tokens);}
  catch(e){const failure=reason(e);if(tokens.length===1){blocked.push({token:tokens[0],reason:failure});return;}const middle=Math.floor(tokens.length/2);await check(tokens.slice(0,middle));await check(tokens.slice(middle));}
 }
 // [VERIFIED: LIQStakingDistributorV2.claimMany] A single failed ERC20
 // transfer reverts its entire batch. Split simulations before any signature.
 for(let i=0;i<pending.length;i+=50)await check(pending.slice(i,i+50));
 if(blocked.length&&groups.length>1){const healthy=pending.filter(t=>!blocked.some(b=>b.token===t));groups.length=0;for(let i=0;i<healthy.length;i+=50)await check(healthy.slice(i,i+50));}
 return {eligible:rows.filter(r=>!blocked.some(b=>b.token===r.token)),blocked,groups,checkedAt:Date.now()};
}
export async function executeLiq(context:ExecutionContext,action:import('../domain').Action,send:(address:Address,abi:readonly unknown[],fn:string,args?:readonly unknown[])=>Promise<`0x${string}`>){
 const {client,state}=context,boot=state.boot!,user=state.address!,address=boot.registry.liqStaking?.distributor;if(!address||!boot.liqStakingReady)throw Error('LIQ staking is not verified.');
 const isClaim=action.kind==='liqClaim'||action.kind==='liqClaimMany';
 const wanted=isClaim?(action.kind==='liqClaim'?[action.tokenAddress]:action.rewardLegs?.map(r=>r.token)):[];
 if(isClaim&&(!wanted?.length||wanted.length>1050||wanted.some(t=>!t||!isAddress(t))))throw Error('Select valid LIQ reward tokens.');
 const tokens=[...new Set((wanted??[]).map(t=>getAddress(t!)))];
 // Claim-all selections already came from the registry. A direct single-token
 // claim also checks retired token mappings, without requiring enumeration.
 const fresh=await readLiq(accountReadClient(client,boot),boot,user,{rewards:isClaim||!!action.rewardLegs?.length,additionalTokens:isClaim?tokens:(action.rewardLegs??[]).map(r=>r.token),metadata:false,stakeSummaryOnly:isClaim}),hashes:`0x${string}`[]=[];
 if(fresh.paused!==false)throw Error('LIQ staking is paused or its status is unavailable.');
 if(!isClaim&&(action.rewardLegs??[]).some(r=>!fresh.checkedRewardTokens?.includes(getAddress(r.token))))throw Error('A listed retired-token reward could not be checked. Refresh or claim it before changing your LIQ stake.');
 if(!isClaim&&fresh.rewards.some(r=>r.retired&&r.amount>(r.credit??0n)))throw Error('Claim the listed retired-token rewards before changing your LIQ stake.');
 if(action.kind==='liqStake'){
  if(action.amount<=0n||fresh.wallet===undefined||action.amount>fresh.wallet||fresh.balance===undefined||fresh.total===undefined||fresh.maxUser===undefined||fresh.maxTotal===undefined||fresh.balance+action.amount>fresh.maxUser||fresh.total+action.amount>fresh.maxTotal)throw Error('The LIQ balance or staking caps changed. Refresh the amount.');
  const allowance=await client.readContract({address:boot.registry.legacy.LIQ,abi:STAKING_ERC20_ABI,functionName:'allowance',args:[user,address]});if(allowance<action.amount)hashes.push(await send(boot.registry.legacy.LIQ,STAKING_ERC20_ABI,'approve',[address,action.amount]));
  hashes.push(await send(address,LIQ_STAKING_ABI,'stake',[action.amount]));
 }else if(action.kind==='liqWithdraw'){
  if(action.amount<=0n||fresh.balance===undefined||action.amount>fresh.balance||fresh.unlockTime===undefined||fresh.timestamp<fresh.unlockTime)throw Error('LIQ is still locked, or the withdrawal balance changed.');hashes.push(await send(address,LIQ_STAKING_ABI,'unstake',[action.amount]));
 }else if(isClaim){
  if(tokens.some(t=>!fresh.checkedRewardTokens?.includes(t)))throw Error('Some selected LIQ rewards could not be read. Refresh or claim a healthy token individually.');
  const rows=fresh.rewards.filter(r=>tokens.includes(r.token));if(!rows.length)throw Error('No selected LIQ rewards remain, or their preview is unavailable. Refresh before claiming.');
  context.onProgress?.('Rechecking selected LIQ reward transfers…');
  const plan=await previewLiqClaims(client,boot,user,rows);
  if(plan.blocked.length)throw Error('Some selected LIQ rewards no longer pass simulation. Refresh and review the available rewards before claiming.');
  for(let i=0;i<plan.groups.length;i++){context.onProgress?.('Confirm LIQ claim batch '+(i+1)+' of '+plan.groups.length+' in your wallet');hashes.push(await send(address,LIQ_STAKING_ABI,'claimMany',[plan.groups[i]]));}
  for(const r of rows){const credit=await client.readContract({address,abi:LIQ_STAKING_ABI,functionName:'creditOf',args:[user,r.token]});if(credit>0n)hashes.push(await send(address,LIQ_STAKING_ABI,'withdrawCredit',[r.token,credit,user]));}
  if(!hashes.length)throw Error('The selected LIQ rewards are already settled. Refresh your balances.');
 }else throw Error('Unsupported LIQ action.');
 return hashes;
}
