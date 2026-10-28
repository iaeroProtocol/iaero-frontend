import {useEffect,useState} from 'react';
import {formatUnits} from 'viem';
import {TokenIcon} from '../icons';
import {acceptedReadCoverage} from '../protocol-data/read-coverage';
import type {Bootstrap} from './types';
const positive=(v:unknown):v is string=>typeof v==='string'&&/^\d{1,78}$/.test(v)&&BigInt(v)>0n&&BigInt(v)<2n**256n;
const priceLabel=(v:string|null)=>{
 if(v===null)return '—';const n=Number(formatUnits(BigInt(v),18));
 return n<.0001||n>=100000?n.toExponential(2):n.toLocaleString('en-GB',{minimumFractionDigits:n>=1?2:4,maximumFractionDigits:n>=.1?4:5});
};
export function StatusPrices({boot}:{boot:Bootstrap|undefined}){
 const market=boot?.metrics.market,at=market?.readAtMs,[clock,setClock]=useState(Date.now);
 useEffect(()=>{const tick=()=>setClock(Date.now()),timer=at===undefined?undefined:setTimeout(tick,Math.max(1,at+120001-Date.now()));window.addEventListener('focus',tick);return()=>{clearTimeout(timer);window.removeEventListener('focus',tick);};},[at]);
 const now=Math.max(clock,Date.now()),fresh=!!market&&typeof at==='number'&&Number.isSafeInteger(at)&&at<=now+5000&&now-at<=120000&&market.asOfBlock===boot?.snapshot.block&&market.blockTimestamp===boot.snapshot.timestamp&&acceptedReadCoverage(market.readProviders,boot.readCoverage);
 const direct=market?.iaeroPriceUsdcWad,iaero=direct===undefined&&positive(market?.aeroPriceUsdcWad)&&positive(market?.iaeroPegWad)?(BigInt(market.aeroPriceUsdcWad)*BigInt(market.iaeroPegWad)/10n**18n).toString():direct;
 return <div className="connection-prices" role="group" aria-label="Token prices in USDC">{([{token:'iAERO',value:iaero},{token:'LIQ',value:market?.liqPriceUsdcWad}] as const).map(({token,value})=>{
  const price=fresh&&positive(value)?value:null;
  return <span className="connection-price" key={token} aria-label={token+' price'} title={price===null?'Current '+token+' price unavailable':formatUnits(BigInt(price),18)+' USDC per '+token}><TokenIcon token={token} size={17}/><span className="connection-price-copy"><span>{token}</span><strong>{priceLabel(price)} <small>USDC</small></strong></span></span>;
 })}</div>;
}
