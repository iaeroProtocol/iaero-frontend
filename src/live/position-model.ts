import {formatUnits} from 'viem';
import {streamingApr,type StreamingSnapshot} from '../protocol/streamingClient';
import type {LiveState,Bootstrap} from './types';
import type {DemoWallet} from '../domain';
export function connectionLabel(boot:Bootstrap|undefined){
 if(boot?.newStackReady)return {active:true,label:'Contracts verified',message:'The new USDC staking stream is connected.'};
 if(boot?.newStack?.configured)return {active:false,label:'Verification unavailable',message:boot.newStackReason};
 return {active:false,label:'Awaiting deployment',message:boot?.newStackReason??'Waiting for deployment readback.'};
}
export function positionSummary(live:LiveState,wallet:DemoWallet){
 const p=live.newPosition,boot=live.boot,c=boot?.newStack?.addresses;
 const optionalUnknown=(key:string)=>boot?.newStack?.optionalErrors.some(s=>s.startsWith(key));
 const required:(bigint|undefined)[]=[live.known.iaero?wallet.iaero:undefined,live.known.legacyStake?wallet.legacyStake:undefined,live.oldAutoShares];
 if(boot?.newStackReady){required.push(p?.stream?.balance);if(c?.streamAutoVault||optionalUnknown('streamAutoVault'))required.push(p?.auto?.shares);if(c?.stakedCollateral||optionalUnknown('stakedCollateral'))required.push(p?.collateral?.principal);}
 if(boot?.newStack?.configured&&!boot.newStackReady)required.push(undefined);
 const known=required.filter((n):n is bigint=>n!==undefined),complete=known.length===required.length;
 return {complete,total:known.length?known.reduce((n,a)=>n+a,0n):undefined,wrappedPrincipal:p?.collateral?.principal};
}

export function liqPositionNote(live:Pick<LiveState,'boot'|'liqPosition'|'loading'>){
 const p=live.liqPosition;if(!live.boot?.liqStakingReady)return 'Verification unavailable';if(p?.balance===undefined)return live.loading?'Reading staked balance…':'Staked balance unavailable';if(p.balance===0n)return 'No LIQ currently staked';
 if(p.unlockTime===undefined||!Number.isSafeInteger(p.unlockTime)||p.unlockTime<0||p.unlockTime>8640000000000)return 'Unlock status unavailable';
 if(p.unlockTime>p.timestamp)return 'Locked until '+new Date(p.unlockTime*1000).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'UTC'})+' UTC';
 return p.paused===true?'Unlocked · contract paused':p.paused===false?'Unlocked · withdrawals available':'Unlocked · contract status unavailable';
}

// Shared with Earn so Portfolio never invents a second staking-rate calculation.
export function fundedIaeroYield(live:LiveState){
 const stream=live.newPosition?.stream,market=live.boot?.metrics.market;
 if(!live.boot?.newStackReady)return {apr:null,reason:connectionLabel(live.boot).message};
 const price=market?.aeroPriceUsdcWad&&market?.iaeroPegWad?Number(formatUnits(BigInt(market.aeroPriceUsdcWad)*BigInt(market.iaeroPegWad)/10n**18n,18)):undefined;
 const apr=stream&&stream.totalStaked!==undefined&&price?streamingApr(stream as StreamingSnapshot,{iaeroUsd:price,usdcUsd:1,asOf:market!.blockTimestamp}):null;
 const reason=apr===null?'Current stream funding or pricing is unavailable.':stream!.timestamp>=(stream!.periodFinish??0)?'The funded stream has ended.':stream!.totalStaked===0n?'No iAERO is currently staked in this stream.':'Calculated from funded USDC and eligible iAERO stake.';
 return {apr,reason};
}
