import type {LiveState} from './types';
import {portfolioRewardValue} from './reward-value';
// Only personal claim routes enter this subtotal. Protocol NFT income and LIQ
// rewards not yet read by the LIQ controls are never silently added as zero.
export function overviewRewards(live:LiveState){
 const legacy=portfolioRewardValue(live),configured=live.boot?.newStackReady?live.boot.newStack?.addresses:undefined,p=live.newPosition;
 const funded:(bigint|undefined)[]=configured?[p?.stream?.earned,...(configured.streamAutoVault?[p?.auto?.earned]:[]),...(configured.stakedCollateral?[p?.collateral?.earned]:[])]:[];
 const known=funded.filter((n):n is bigint=>n!==undefined),fundedUsdc=known.length?known.reduce((n,a)=>n+a,0n):null;
 const totalWad=legacy.valueWad!==null||fundedUsdc!==null?(legacy.valueWad??0n)+(fundedUsdc??0n)*10n**12n:null;
 return {legacyWad:legacy.valueWad,fundedUsdc,totalWad,partial:legacy.partial||known.length!==funded.length,includesFunded:!!configured,scope:configured?'Selected legacy rewards + new-position USDC':'Selected legacy rewards + AutoVault'};
}
