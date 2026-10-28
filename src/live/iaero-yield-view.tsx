import {useEffect,useState} from 'react';
import {formatUnits} from 'viem';
import {usePreview} from '../store';
import {formatYieldPercent} from '../protocol-data/yield-display';
import {observedIaeroYield} from './iaero-yield';
import type {ProtocolYieldReport} from './use-protocol-yield';
const money=(n:string|null)=>n===null?'—':Number(formatUnits(BigInt(n),18)).toLocaleString('en-GB',{maximumFractionDigits:4})+' USDC';
export function IaeroYieldEstimate({data,unknown}:{data:ProtocolYieldReport|undefined;unknown:boolean}){
 const {live}=usePreview(),[clock,setClock]=useState(Date.now);
 useEffect(()=>{const tick=()=>setClock(Date.now()),timer=setInterval(tick,5000);window.addEventListener('focus',tick);return()=>{clearInterval(timer);window.removeEventListener('focus',tick);};},[]);
 const rate=observedIaeroYield(unknown?undefined:data,live?.boot,Math.max(clock,Date.now()));
 return <div className="iaero-observed-yield" aria-label="iAERO market-price yield estimate"><span className="rate-basis">Estimated iAERO APY · {rate.label}</span><strong>{formatYieldPercent(rate.apy)}</strong><p>{rate.reason??'80% staker share · current iAERO market price'}</p><details className="yield-details"><summary>iAERO yield calculation</summary><div><p>The 80% staker share of income earned across all observed chains is divided by the market value of currently staked iAERO. The exact observed period is compounded to an annual estimate: (1 + period return)<sup>365/N</sup> − 1.</p><dl><div><dt>iAERO market price</dt><dd>{money(rate.priceUsdcWad)}</dd></div><div><dt>Current staked value</dt><dd>{money(rate.capitalUsdcWad)}</dd></div><div><dt>Estimated staker income · observed period</dt><dd>{money(rate.netIncomeUsdcWad)}</dd></div></dl><p>This estimates yield at today’s price and staking total. Rewards may still await claim, conversion and distribution; costs reduce the payout. Annualisation assumes the observed return repeats, and does not imply automatic compounding.</p></div></details></div>;
}
