import {decodeEventLog,formatUnits,keccak256,parseAbi,zeroAddress,type Address,type Hash} from 'viem';
import type {Activity} from '../domain';
import {createGuardedSender,type BaseClient,type ExecutionContext} from './client';
import type {Bootstrap} from './types';
import {accountReadClient} from './account-read-client';
import manifest from '../../config/aero-deposit.json';
import {DEPOSIT_ABI,DEPOSIT_MAX_AGE_MS,DEPOSIT_MIN,decodedDepositFailure,depositAmount,depositBlockingIssues,depositIssues,depositQuote,depositTokenId,depositsOpen,uint256,type DepositIssue,type DepositQuote} from './deposit-contract';

export const DEPOSIT_TOKEN_ABI=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)']);
export const DEPOSIT_ESCROW_ABI=parseAbi(['function balanceOf(address) view returns(uint256)','function tokenOfOwnerByIndex(address,uint256) view returns(uint256)','function staked(uint256) view returns((uint128 amount,uint48 end,bool isPermanent))','function ownerOf(uint256) view returns(address)','function approve(address,uint256)']);
export type DepositMode='aero'|'stake';
export type DepositReview={user:Address;mode:DepositMode;amount:bigint;tokenId?:bigint;permanent?:boolean;end?:bigint;quote:DepositQuote;previewAvailable:boolean;issues:DepositIssue[];block:bigint;readAt:number;reasonsVersion:number};
export type DepositResult={hash:Hash;approvalHashes:Hash[];tokenId?:bigint;amount?:bigint;iaero?:bigint;fee?:bigint;liq?:bigint;treasuryLiq?:bigint;upgraded?:boolean;receiptUnavailable?:boolean};
export type DepositHooks={shouldStop?:()=>boolean;onProgress?:(text:string)=>void;onRefusal?:(failure:{name:string;code?:number;issues?:DepositIssue[];refreshedQuote?:DepositQuote})=>void};
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function depositConnection(boot:Bootstrap){const c=boot.deposit;if(!c?.verified||!c.address||!c.aero||!c.escrow||!c.iaero||!c.liq||!c.vault||c.reasonsVersion!==manifest.reasonsVersion||!same(c.address,manifest.address)||c.runtimeHash!==manifest.runtimeHash||boot.registry.chainId!==8453||!same(c.aero,boot.registry.aero.token)||!same(c.escrow,boot.registry.aero.votingEscrow)||!same(c.iaero,boot.registry.legacy.iAERO)||!same(c.liq,boot.registry.legacy.LIQ)||!same(c.vault,manifest.vault))throw Error(c?.reason??'The deposit contract is not verified yet.');return c as typeof c&{address:Address;aero:Address;escrow:Address;iaero:Address;liq:Address;vault:Address};}
async function snapshot(client:BaseClient){
 const [chain,block]=await Promise.all([client.getChainId(),client.getBlock()]),now=Date.now();
 if(chain!==8453||typeof block.number!=='bigint'||block.number<0n||typeof block.timestamp!=='bigint'||block.timestamp>BigInt(Math.floor(now/1000)+60)||BigInt(Math.floor(now/1000))-block.timestamp>BigInt(DEPOSIT_MAX_AGE_MS/1000))throw Error('Fresh Base reads are required before depositing. Refresh and retry.');
 return block;
}
export async function readDepositStatus(client:BaseClient,boot:Bootstrap,user:Address=zeroAddress){
 const c=depositConnection(boot),block=await snapshot(client),reader=accountReadClient(client,boot),read=(at:Address,abi:readonly unknown[],functionName:string,args:readonly unknown[]=[])=>reader.readContract({address:at,abi,functionName,args,blockNumber:block.number} as any) as Promise<any>;
 const [raw,version,rate,halvings,total,oldAero,newAero]=await Promise.all([read(c.address,DEPOSIT_ABI,'checkAeroDeposit',[user,DEPOSIT_MIN]),read(c.address,DEPOSIT_ABI,'REASONS_VERSION'),read(c.address,DEPOSIT_ABI,'getCurrentEmissionRate'),read(c.address,DEPOSIT_ABI,'halvings'),read(c.address,DEPOSIT_ABI,'totalLIQMinted'),user===zeroAddress?0n:read(manifest.oldAero as Address,DEPOSIT_TOKEN_ABI,'balanceOf',[user]),user===zeroAddress?0n:read(c.aero,DEPOSIT_TOKEN_ABI,'balanceOf',[user])]);
 if(version!==BigInt(manifest.reasonsVersion))throw Error('Deposit refusal messages have changed. Refresh before continuing.');const issues=depositIssues(raw);return {open:depositsOpen(issues),issues,reasonsVersion:Number(version),rate:uint256(rate),halvings:uint256(halvings),total:uint256(total),oldAero:uint256(oldAero),newAero:uint256(newAero),block:block.number,readAt:Date.now()};
}
export async function readDepositReview(client:BaseClient,boot:Bootstrap,user:Address,mode:DepositMode,input:bigint):Promise<DepositReview>{
 if(mode==='aero')depositAmount(input);else depositTokenId(input);
 const c=depositConnection(boot),block=await snapshot(client),reader=accountReadClient(client,boot),read=(at:Address,abi:readonly unknown[],functionName:string,args:readonly unknown[]=[])=>reader.readContract({address:at,abi,functionName,args,blockNumber:block.number} as any) as Promise<any>;
 const [raw,version,stake]=await Promise.all([read(c.address,DEPOSIT_ABI,mode==='aero'?'checkAeroDeposit':'checkStake',mode==='aero'?[user,input]:[input,user]),read(c.address,DEPOSIT_ABI,'REASONS_VERSION'),mode==='aero'?undefined:read(c.escrow,DEPOSIT_ESCROW_ABI,'staked',[input])]);
 if(version!==BigInt(manifest.reasonsVersion))throw Error('Deposit refusal messages have changed. Refresh before continuing.');
 const issues=depositIssues(raw),amount=mode==='aero'?input:uint256(stake?.amount);
 let quote:DepositQuote={iaero:0n,fee:0n,liq:0n,treasuryLiq:0n};
 if(amount>0n&&!issues.some(i=>i.reason===21))quote=depositQuote(await read(c.address,DEPOSIT_ABI,'previewDeposit',[amount]));

 const previewAvailable=amount>0n&&!issues.some(i=>i.reason===21);
 if(previewAvailable&&quote.iaero+quote.fee!==amount)throw Error('The deposit preview is inconsistent. Refresh before continuing.');
 return {user,mode,amount,tokenId:mode==='stake'?input:undefined,permanent:mode==='stake'?stake?.isPermanent:undefined,end:mode==='stake'?uint256(stake?.end):undefined,quote,previewAvailable,issues,block:block.number,readAt:Date.now(),reasonsVersion:Number(version)};
}
export async function listDepositStakes(client:BaseClient,boot:Bootstrap,user:Address,offset=0n){
 if(offset<0n||offset>=2n**256n)throw Error('Invalid stake page.');const c=depositConnection(boot),block=await snapshot(client),reader=accountReadClient(client,boot),read=(functionName:string,args:readonly unknown[])=>reader.readContract({address:c.escrow,abi:DEPOSIT_ESCROW_ABI,functionName,args,blockNumber:block.number} as any) as Promise<any>,total=uint256(await read('balanceOf',[user])),count=Number(total>offset?total-offset<20n?total-offset:20n:0n);
 const ids=await Promise.all(Array.from({length:count},(_,i)=>read('tokenOfOwnerByIndex',[user,offset+BigInt(i)]))),stakes=await Promise.all(ids.map(async id=>{const tokenId=uint256(id),s=await read('staked',[tokenId]);return {tokenId,amount:uint256(s.amount),end:uint256(s.end),permanent:s.isPermanent===true};}));
 return {stakes,total,next:offset+BigInt(count),block:block.number};
}
function requireFresh(review:DepositReview,user:Address){if(!same(review.user,user)||!Number.isSafeInteger(review.readAt)||review.readAt>Date.now()+5000||Date.now()-review.readAt>DEPOSIT_MAX_AGE_MS||review.reasonsVersion!==manifest.reasonsVersion)throw Error('The deposit review expired or your wallet changed. Review a fresh preview.');if(!review.previewAvailable||review.quote.liq<=0n)throw Error('This preview gives no LIQ. Depositing through the app is unavailable until this is reviewed.');}
export function receiptDeposit(receipt:any,c:ReturnType<typeof depositConnection>,review:DepositReview,hash:Hash){
 if(receipt.status!=='success'||!same(receipt.transactionHash,hash)||!same(receipt.from,review.user)||!receipt.to||!same(receipt.to,c.address))throw Error('The deposit receipt could not be verified.');
 const events=receipt.logs.filter((l:any)=>same(l.address,c.address)).flatMap((log:any)=>{try{const e=decodeEventLog({abi:DEPOSIT_ABI,data:log.data,topics:log.topics});return e.eventName===(review.mode==='aero'?'AeroDeposited':'StakeDeposited')?[e.args as any]:[];}catch{return [];}});
 if(events.length!==1)throw Error('The confirmed deposit event is unavailable.');const e=events[0];if(!same(e.user,review.user)||uint256(e.amount)!==review.amount||(review.mode==='stake'&&uint256(e.tokenId)!==review.tokenId)||uint256(e.iAeroToUser)!==review.quote.iaero||uint256(e.iAeroToTreasury)!==review.quote.fee||uint256(e.liqToUser)<review.quote.liq||uint256(e.liqToTreasury)!==uint256(e.liqToUser)*2000n/10000n)throw Error('The confirmed deposit amounts could not be verified.');
 return {tokenId:uint256(e.tokenId),amount:uint256(e.amount),iaero:uint256(e.iAeroToUser),fee:uint256(e.iAeroToTreasury),liq:uint256(e.liqToUser),treasuryLiq:uint256(e.liqToTreasury),upgraded:review.mode==='stake'?e.upgraded===true:undefined};
}
export async function runDeposit(context:ExecutionContext,review:DepositReview,hooks:DepositHooks={}):Promise<DepositResult>{
 const {client,state}=context,user=state.address!,boot=state.boot!,c=depositConnection(boot),approvalHashes:Hash[]=[];let confirmedDeposit:Hash|undefined,gas:bigint|undefined;
 const active=()=>{if(state.chainId!==8453||state.pending||!user||hooks.shouldStop?.()||context.canContinue?.()===false)throw Error('Wallet, network or pending request changed. Stop and review before continuing.');};
 const progress=(text:string)=>{hooks.onProgress?.(text);context.onProgress?.(text);};
 const record=(hash:Hash,title:string,approval=false)=>context.onConfirmed?.({id:hash,hash,title,token:'',amount:approval?'Exact approval':'Confirmed · receipt details pending',direction:approval?'out':'in',time:Date.now()} satisfies Activity);
 active();requireFresh(review,user);
 const runtime=await client.getCode({address:c.address});if(!runtime||keccak256(runtime)!==manifest.runtimeHash)throw Error('The deposit runtime changed. No deposit was sent.');
 const send=await createGuardedSender(context,()=>!hooks.shouldStop?.(),()=>gas);
 const checkedSend=async(address:Address,abi:readonly unknown[],functionName:string,args:readonly unknown[])=>{active();gas=undefined;const estimate=await client.estimateContractGas({address,abi,functionName,args,account:user} as any);gas=(estimate*125n+99n)/100n;if(gas<=0n||gas>16_000_000n)throw Error('The deposit exceeds the supported Base gas budget.');active();return send(address,abi,functionName,args);};
 try{
  let fresh=await readDepositReview(client,boot,user,review.mode,review.mode==='aero'?review.amount:depositTokenId(review.tokenId!));
  const accept=(q:DepositReview)=>{requireFresh(q,user);if(q.amount!==review.amount||q.permanent!==review.permanent||q.quote.iaero!==review.quote.iaero||q.quote.fee!==review.quote.fee)throw Error('Your stake or deposit quote changed. Review it again.');const blocked=depositBlockingIssues(q.issues,review.mode);if(blocked.length)throw Object.assign(Error('Deposit refused. Refresh the checks for instructions.'),{depositFailure:{name:'DepositRefused',issues:q.issues}});if(q.quote.liq<review.quote.liq)throw Object.assign(Error('The LIQ amount changed. Review and accept the new quote before depositing.'),{depositFailure:{name:'LiqBelowMinimum',code:22,issues:q.issues,refreshedQuote:q.quote}});};
  accept(fresh);
  if(fresh.issues.some(i=>i.reason===(review.mode==='aero'?8:20))){
   if(review.mode==='aero'){
    const allowance=uint256(await client.readContract({address:c.aero,abi:DEPOSIT_TOKEN_ABI,functionName:'allowance',args:[user,c.address]}));
    if(allowance>0n){progress('Resetting the new AERO allowance…');const hash=await checkedSend(c.aero,DEPOSIT_TOKEN_ABI,'approve',[c.address,0n]);approvalHashes.push(hash);record(hash,'Reset new AERO approval',true);}
    progress('Approve the exact new AERO amount in your wallet.');const hash=await checkedSend(c.aero,DEPOSIT_TOKEN_ABI,'approve',[c.address,review.amount]);approvalHashes.push(hash);record(hash,'Approve exact new AERO amount',true);
   }else{progress('Approve this stake only in your wallet.');const hash=await checkedSend(c.escrow,DEPOSIT_ESCROW_ABI,'approve',[c.address,review.tokenId!]);approvalHashes.push(hash);record(hash,'Approve stake #'+review.tokenId,true);}
  }
  // Always re-read after the approval, even if the allowance already sufficed.
  fresh=await readDepositReview(client,boot,user,review.mode,review.mode==='aero'?review.amount:review.tokenId!);accept(fresh);if(fresh.issues.length)throw Error('The approval or deposit checks changed. Refresh before continuing.');
  active();progress('Confirm the permanent deposit in your wallet.');const hash=await checkedSend(c.address,DEPOSIT_ABI,review.mode==='aero'?'depositAero':'depositStake',[review.mode==='aero'?review.amount:review.tokenId!,fresh.quote.liq]);confirmedDeposit=hash;record(hash,review.mode==='aero'?'Deposited new AERO':'Deposited stake #'+review.tokenId);
  try{const receipt=await client.getTransactionReceipt({hash}),received=receiptDeposit(receipt,c,fresh,hash);context.onConfirmed?.({id:hash,hash,title:review.mode==='aero'?'Deposited new AERO':'Deposited stake #'+review.tokenId,token:'',amount:formatUnits(received.iaero,18)+' iAERO + '+formatUnits(received.liq,18)+' LIQ',direction:'in',time:Date.now()});return {hash,approvalHashes,...received};}catch{return {hash,approvalHashes,receiptUnavailable:true};}
 }catch(error){
  if(confirmedDeposit)return {hash:confirmedDeposit,approvalHashes,receiptUnavailable:true};
  const decoded=decodedDepositFailure(error)??(error as any)?.depositFailure;
  if(!hooks.shouldStop?.()&&context.canContinue?.()!==false){try{const fresh=await readDepositReview(client,boot,user,review.mode,review.mode==='aero'?review.amount:review.tokenId!);hooks.onRefusal?.({name:decoded?.name??'Deposit check failed',code:decoded?.code,issues:fresh.issues,refreshedQuote:fresh.quote});}catch{hooks.onRefusal?.({name:decoded?.name??'Deposit check unavailable',code:decoded?.code});}}
  throw error;
 }
}
