import {isAddress,type Address} from 'viem';

export const VALUE_SCALE=10n**12n; // USDC's six decimals -> 18-decimal display value.
type ValueConfig={usdc:Address;weth:Address};
type Quote=(token:Address,amount:bigint)=>Promise<{sellToken?:unknown;buyToken?:unknown;sellAmount?:unknown;buyAmount?:unknown;liquidityAvailable?:unknown}>;
export type TokenValue={token:Address;amount:string;valueWad:string|null;source:'usdc'|'quote'|'reference'|'unavailable';quotedAt:number};
export function valueInput(params:URLSearchParams){
  const token=params.get('token')??'',raw=params.get('amount')??'',decimal=params.get('decimals');
  if(!isAddress(token)||!/^\d{1,78}$/.test(raw)||BigInt(raw)<=0n||BigInt(raw)>=2n**256n||decimal!==null&&(!/^\d{1,2}$/.test(decimal)||Number(decimal)>36))throw Error('Invalid reward valuation request.');
  return {token,amount:BigInt(raw),decimals:decimal===null?null:Number(decimal)};
}
export async function estimateTokenValue(input:ReturnType<typeof valueInput>,config:ValueConfig,quote:Quote,now=Date.now()):Promise<TokenValue>{
  const {token,amount,decimals}=input,base={token,amount:amount.toString(),quotedAt:now};
  if(token.toLowerCase()===config.usdc.toLowerCase())return {...base,valueWad:(amount*VALUE_SCALE).toString(),source:'usdc'};
  // ETH and canonical WETH have the same units. This prices ETH; it does not
  // wrap it, spend gas balances, or create an executable sweep instruction.
  const pricedToken=BigInt(token)===0n?config.weth:token;
  const read=async(size:bigint)=>{
    const q=await quote(pricedToken,size);
    if(q.sellToken!==undefined&&String(q.sellToken).toLowerCase()!==pricedToken.toLowerCase()||q.buyToken!==undefined&&String(q.buyToken).toLowerCase()!==config.usdc.toLowerCase())throw Error('Quote token mismatch.');
    if(q.liquidityAvailable===false||String(q.sellAmount)!==size.toString()||!/^\d{1,78}$/.test(String(q.buyAmount))||BigInt(String(q.buyAmount))<=0n||BigInt(String(q.buyAmount))>=2n**256n)throw Error('No matching USDC quote.');
    return BigInt(String(q.buyAmount))*VALUE_SCALE*amount/size;
  };
  try{return {...base,valueWad:(await read(amount)).toString(),source:'quote'};}catch{/* An untradeable dust amount can still have an indicative value. */}
  const d=BigInt(token)===0n?18:decimals,reference=d===null?null:10n**BigInt(d);
  if(reference!==null&&reference!==amount){try{return {...base,valueWad:(await read(reference)).toString(),source:'reference'};}catch{}}
  return {...base,valueWad:null,source:'unavailable'};
}
