import {formatUnits, parseUnits} from 'viem';

export const UNIT = 10n ** 18n;
export const USDC_UNIT = 10n ** 6n;
export const SAMPLE_IAERO_PRICE = 611_200n;
export const SAMPLE_AERO_PRICE = 644_000n;
export const SAMPLE_APR_BPS = 2264n;
export const DEMO_STORAGE_KEY = 'iaero.saero.design-preview.v1';

export type Page = 'overview' | 'earn' | 'get' | 'portfolio';
export type Activity = {id:string; title:string; token:string; amount:string; direction:'in'|'out'; time:number;hash?:`0x${string}`};
export type DemoWallet = {
  aero:bigint; iaero:bigint; staked:bigint; autoStaked:bigint; usdc:bigint;
  earned:bigint; autoEarned:bigint; legacyStake:bigint; legacyRewards:bigint;
  liq:bigint; checkpoint:number;
};
export type RewardLeg={token:`0x${string}`;symbol:string;decimals:number|null;epoch:bigint;amount:bigint};
export type ActionResult={noAction?:string;hashes:`0x${string}`[];received?:{token:`0x${string}`;amount:bigint}[]};
export type ActionKind = 'stake'|'unstake'|'autoStake'|'autoUnstake'|'claim'|'autoClaim'|'mint'|'nft'|'buy'|'legacyClaim'|'legacyClaimMany'|'legacyWithdraw'|'legacyStake'|'oldAutoClaim'|'oldAutoWithdraw'|'liqStake'|'liqWithdraw'|'liqClaim'|'liqClaimMany'|'collateralWrap'|'collateralRedeem'|'collateralClaim';
export type Action = {kind:ActionKind; amount:bigint; title:string; description:string; source:string; target:string; approval:boolean; nftId?:string;tokenAddress?:`0x${string}`;tokenSymbol?:string;tokenDecimals?:number|null;epoch?:bigint;epochs?:bigint[];minNetOut?:bigint;rewardLegs?:RewardLeg[];minShares?:bigint;maxUSDC?:bigint;minPrincipal?:bigint;minUSDC?:bigint;previewIaeroOut?:bigint;previewLiqOut?:bigint};

export function initialWallet(now = Math.floor(Date.now()/1000)):DemoWallet {
  return {aero:2500n*UNIT, iaero:86505n*UNIT/10n, staked:42500n*UNIT,
    autoStaked:0n, usdc:382490000n, earned:124831200n, autoEarned:0n,
    legacyStake:1250n*UNIT, legacyRewards:18760000n, liq:320n*UNIT, checkpoint:now};
}

export function parseAmount(value:string, decimals=18):bigint {
  if(!Number.isInteger(decimals)||decimals<0||decimals>36||!(decimals===0?/^\d+$/:new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`)).test(value))throw Error(`Enter an amount with up to ${decimals} decimal places.`);
  const amount=parseUnits(value,decimals);
  if(amount<=0n||amount>=2n**256n)throw Error('Enter an amount greater than zero.');
  return amount;
}

export function amountText(amount:bigint,decimals=18){return formatUnits(amount,decimals);}
export function numberText(value:number,digits=2){return new Intl.NumberFormat('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value);}
export function tokenText(amount:bigint,decimals=18,digits=2){
  if(!Number.isInteger(decimals)||decimals<0||decimals>36||!Number.isInteger(digits)||digits<0||digits>36)throw Error('Unsupported display precision.');
  const negative=amount<0n,absolute=negative?-amount:amount,scale=10n**BigInt(decimals),precision=10n**BigInt(digits);
  if(absolute>0n&&absolute*precision<scale)return (negative?'> -':'< ')+(digits?'0.'+'0'.repeat(digits-1)+'1':'1');
  // Round only the human-readable summary, using integer arithmetic even for
  // amounts above JavaScript's safe integer range. Inputs keep their bigints.
  const rounded=digits>=decimals?absolute*10n**BigInt(digits-decimals):(absolute+10n**BigInt(decimals-digits)/2n)/10n**BigInt(decimals-digits);
  const whole=(rounded/precision).toLocaleString('en-US'),fraction=digits?(rounded%precision).toString().padStart(digits,'0'):'';
  return (negative?'-':'')+whole+(digits?'.'+fraction:'');
}
export function dollarText(amount:bigint,decimals=6){return '$'+tokenText(amount,decimals);}
export function compactNumber(n:number){return new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(n);}

// [VERIFIED: reviewed SVault.sol:75, 77-78, 550] Deposits use integer fee
// rounding, a 1 AERO minimum and 10,000,000 AERO maximum. The demo never writes.
export function mintPreview(amount:bigint){
  if(amount<UNIT||amount>10_000_000n*UNIT)throw Error('Deposit between 1 and 10,000,000 AERO.');
  const fee=amount*500n/10_000n;
  return {gross:amount,fee,received:amount-fee};
}

export function sampleBuyPreview(usdc:bigint){
  if(usdc<=0n)throw Error('Enter an amount greater than zero.');
  const fee=usdc*35n/10_000n;
  return {fee,received:(usdc-fee)*UNIT/SAMPLE_IAERO_PRICE};
}

export function accrued(wallet:DemoWallet,now=Math.floor(Date.now()/1000)):DemoWallet {
  const elapsed=BigInt(Math.max(0,Math.min(now-wallet.checkpoint,604800)));
  const reward=(stake:bigint)=>stake*SAMPLE_IAERO_PRICE*SAMPLE_APR_BPS*elapsed/UNIT/10_000n/31_536_000n;
  return {...wallet,earned:wallet.earned+reward(wallet.staked),autoEarned:wallet.autoEarned+reward(wallet.autoStaked),checkpoint:now};
}

export function availableFor(action:ActionKind,w:DemoWallet){
  if(action==='stake'||action==='autoStake')return w.iaero;
  if(action==='unstake')return w.staked;
  if(action==='autoUnstake')return w.autoStaked;
  if(action==='mint')return w.aero;
  if(action==='buy')return w.usdc;
  return 0n;
}

export function applyAction(wallet:DemoWallet,action:Action,now=Math.floor(Date.now()/1000)):DemoWallet {
  const w=accrued(wallet,now),n=action.amount;
  if(['stake','unstake','autoStake','autoUnstake','mint','buy'].includes(action.kind)){
    if(n<=0n||n>=2n**256n)throw Error('Enter a valid amount.');
    if(n>availableFor(action.kind,w))throw Error('Your balance changed. Review the amount and try again.');
  }
  switch(action.kind){
    case 'collateralWrap':case 'collateralRedeem':case 'collateralClaim':case 'liqStake':case 'liqWithdraw':case 'liqClaim':case 'liqClaimMany':throw Error('This position action is available in the live contract app.');
    case 'stake':return {...w,iaero:w.iaero-n,staked:w.staked+n};
    case 'unstake':return {...w,iaero:w.iaero+n,staked:w.staked-n};
    case 'autoStake':return {...w,iaero:w.iaero-n,autoStaked:w.autoStaked+n};
    case 'autoUnstake':return {...w,iaero:w.iaero+n,autoStaked:w.autoStaked-n};
    case 'claim':if(w.earned<=0n)throw Error('No USDC rewards to claim.');return {...w,usdc:w.usdc+w.earned,earned:0n};
    case 'autoClaim':if(w.autoEarned<=0n)throw Error('No AutoVault rewards to claim.');return {...w,usdc:w.usdc+w.autoEarned,autoEarned:0n};
    case 'mint':return {...w,aero:w.aero-n,iaero:w.iaero+mintPreview(n).received};
    case 'buy':return {...w,usdc:w.usdc-n,iaero:w.iaero+sampleBuyPreview(n).received};
    case 'legacyClaim':if(w.legacyRewards<=0n)throw Error('No selected legacy rewards to claim.');return {...w,usdc:w.usdc+w.legacyRewards,legacyRewards:0n};
    case 'legacyWithdraw':if(w.legacyStake<=0n)throw Error('No legacy stake to withdraw.');return {...w,iaero:w.iaero+w.legacyStake,legacyStake:0n};
    case 'nft':throw Error('Public NFT intake is awaiting its verified VPM registration route.');
    case 'legacyClaimMany':throw Error('Batch claims require the live contract adapter.');
    case 'legacyStake':throw Error('Previous staking transactions require the live contract adapter.');
    case 'oldAutoClaim':case 'oldAutoWithdraw':throw Error('Old AutoVault transactions require the live contract adapter.');
  }
}

export function saveWallet(wallet:DemoWallet,activities:Activity[]){
  try{localStorage.setItem(DEMO_STORAGE_KEY,JSON.stringify({version:1,wallet,activities},(_,v)=>typeof v==='bigint'?v.toString():v));}catch{/* Local storage may be unavailable. */}
}

export function restoreWallet():{wallet:DemoWallet;activities:Activity[]}|null {
  try{
    const raw=localStorage.getItem(DEMO_STORAGE_KEY);if(!raw)return null;
    const stored=JSON.parse(raw);if(stored.version!==1||!stored.wallet)return null;
    const fresh=initialWallet(),wallet={...fresh};
    for(const k of Object.keys(fresh) as (keyof DemoWallet)[]){
      if(k==='checkpoint'){
        if(!Number.isSafeInteger(stored.wallet[k])||stored.wallet[k]<0||stored.wallet[k]>Date.now()/1000+60)return null;
        wallet.checkpoint=stored.wallet[k];
      }else{
        const value=stored.wallet[k];if(typeof value!=='string'||!/^\d+$/.test(value)||BigInt(value)>=2n**256n)return null;
        wallet[k]=BigInt(value);
      }
    }
    const activities=Array.isArray(stored.activities)?stored.activities.filter((a:Activity)=>a&&typeof a.id==='string'&&typeof a.title==='string'&&typeof a.amount==='string'&&typeof a.token==='string'&&(a.direction==='in'||a.direction==='out')&&Number.isFinite(a.time)).slice(0,30):[];
    return {wallet:accrued(wallet),activities};
  }catch{return null;}
}
