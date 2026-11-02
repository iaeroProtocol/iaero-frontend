import {decodeErrorResult,getAddress,isAddress,type Abi,type Address,type Hash} from 'viem';
import abi from '../../config/aero-deposit.abi.json' with {type:'json'};

// [VERIFIED: aero-stake-deposit contracts/src/AeroStakeDeposit.sol, v2 ce6469d;
// Sourcify exact creation/runtime match, 2026-11-02. Addresses live in config.]
export const DEPOSIT_ABI=abi as Abi;
export const DEPOSIT_MIN=10n**18n,DEPOSIT_MAX=10_000_000n*DEPOSIT_MIN;
export const DEPOSIT_MAX_AGE_MS=120_000;
export const DEPOSIT_GLOBAL_CODES=new Set([1,2,3,4,21]);
export const DEPOSIT_REFUSALS=['None','DepositsPaused','DepositsClosed','DepositContractReplaced','MintingNotEnabled','AmountTooSmall','AmountTooLarge','AeroBalanceTooLow','AeroAllowanceTooLow','StakeNotFound','StakeAlreadyInVault','NotStakeOwner','PrimaryStake','AlreadyCredited','StakeTooSmall','StakeHasExpired','ExpiredStakeHasVotes','VoterRecordMismatch','VotesOnUnreachableChain','BaseOperatorSet','StakeNotApproved','LiqCapReached','LiqBelowMinimum','StakeInVaultNotCredited','StakeSentToDepositContract','SafeCannotDeposit','ProtocolStakeBlocked','StakeIsEmpty','StakeBelowStakeMinimum'] as const;
// The only issue a user clears by approving (REASONS_VERSION 4 howToUse item 10, review P2-L1).
export const DEPOSIT_APPROVAL_CODE={aero:8,stake:20} as const;
export type DepositIssue={reason:number;tokenId:bigint;chainId:bigint;amount:bigint;limit:bigint;time:bigint;readyAt:bigint;account:Address;chainStatus:number};
export type DepositConnection={verified:boolean;reason:string;address?:Address;vault?:Address;escrow?:Address;aero?:Address;iaero?:Address;liq?:Address;predecessor?:Address;treasury?:Address;reasonsVersion?:number;runtimeHash?:Hash;open?:boolean;issues?:DepositIssue[]};
export type DepositQuote={iaero:bigint;fee:bigint;liq:bigint;treasuryLiq:bigint};
export function depositAmount(amount:bigint){if(typeof amount!=='bigint'||amount<DEPOSIT_MIN||amount>DEPOSIT_MAX)throw Error('Deposit between 1 and 10,000,000 new AERO.');return amount;}
export function depositTokenId(id:bigint){if(typeof id!=='bigint'||id<=0n||id>=2n**256n)throw Error('Enter a valid stake number.');return id;}
export function uint256(value:unknown){if(typeof value!=='bigint'&&!(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)&&!(typeof value==='string'&&/^\d+$/.test(value)))throw Error('Deposit read is incomplete. Refresh and retry.');const n=BigInt(value);if(n<0n||n>=2n**256n)throw Error('Deposit read is invalid. Refresh and retry.');return n;}
export function depositIssues(rows:unknown):DepositIssue[]{
 if(!Array.isArray(rows)||rows.length>1024)throw Error('Deposit checks are unavailable.');
 return rows.map((r:any)=>{const reason=Number(r?.reason),status=Number(r?.chainStatus);if(!Number.isInteger(reason)||reason<1||reason>=DEPOSIT_REFUSALS.length||!Number.isInteger(status)||status<0||status>4||!isAddress(r?.account??'',{strict:false}))throw Error('Unsupported deposit refusal. Refresh before continuing.');return {reason,chainStatus:status,account:getAddress(r.account),tokenId:uint256(r.tokenId),chainId:uint256(r.chainId),amount:uint256(r.amount),limit:uint256(r.limit),time:uint256(r.time),readyAt:uint256(r.readyAt)};});
}
export function depositQuote(value:unknown):DepositQuote{if(!Array.isArray(value)||value.length!==4)throw Error('Deposit preview is unavailable.');const [iaero,fee,liq,treasuryLiq]=value.map(uint256);return {iaero,fee,liq,treasuryLiq};}
export function depositsOpen(issues:readonly DepositIssue[]){return !issues.some(i=>DEPOSIT_GLOBAL_CODES.has(i.reason));}
export function depositBlockingIssues(issues:readonly DepositIssue[],mode:'aero'|'stake'){return issues.filter(i=>i.reason!==DEPOSIT_APPROVAL_CODE[mode]);}
// Approve is offered only when the approval code is the sole issue; Deposit only when there is none.
export function depositNeedsApproval(issues:readonly DepositIssue[],mode:'aero'|'stake'){return issues.length>0&&!depositBlockingIssues(issues,mode).length;}
export function decodedDepositFailure(error:unknown):{name:string;code?:number;args?:readonly unknown[]}|undefined{
 for(let e:any=error,n=0;e&&n<12;e=e.cause,n++){
  const raw=[e.data,e.error?.data,e.cause?.data].find(v=>typeof v==='string'&&/^0x[0-9a-f]{8,}$/i.test(v));
  if(raw)try{const decoded=decodeErrorResult({abi:DEPOSIT_ABI,data:raw}),index=DEPOSIT_REFUSALS.indexOf(decoded.errorName as any);return {name:decoded.errorName,code:index>0?index:undefined,args:decoded.args};}catch{/* Never infer missing refusal fields. */}
  if(e.depositFailure&&typeof e.depositFailure.name==='string')return e.depositFailure;
 }
}
