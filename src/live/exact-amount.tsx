import {formatUnits} from 'viem';
import {tokenText} from '../domain';

// Presentation only. Transaction inputs and minima always retain their bigints.
export function readableAmount(value:bigint,decimals:number|null,places=6){
  const exact=decimals===null?value.toString():formatUnits(value,decimals);
  if(decimals===null)return {exact,summary:exact,reduced:false};
  const [whole,fraction='']=exact.split('.');
  const reduced=fraction.length>places;
  if(!reduced)return {exact,summary:exact,reduced:false};
  const shown=fraction.slice(0,places).replace(/0+$/,'');
  const summary=whole==='0'&&!shown&&value>0n?'< '+(places?'0.'+'0'.repeat(places-1)+'1':'1'):'≈ '+whole+(shown?'.'+shown:'');
  return {exact,summary,reduced:true};
}

export function ExactAmount({value,decimals=18,symbol}:{value:bigint;decimals?:number|null;symbol?:string}){
  const {exact,summary,reduced}=readableAmount(value,decimals);
  return <div className="exact-amount"><strong>{summary}{symbol&&' '+symbol}{decimals===null&&' raw units'}</strong>{reduced&&<details><summary>Exact amount</summary><span className="exact-full">{exact}{symbol&&' '+symbol}</span></details>}</div>;
}

const hiddenExact={position:'absolute',width:1,height:1,padding:0,margin:-1,overflow:'hidden',clipPath:'inset(50%)',whiteSpace:'nowrap',border:0} as const;
// Inline numeric summary. Surrounding rows display their unit; symbol belongs
// to the exact accessible label and hover title, without repeating it visually.
export function BalanceAmount({value,decimals=18,digits=2,symbol}:{value:bigint|undefined;decimals?:number|null;digits?:number;symbol?:string}){
  if(value===undefined)return <>—</>;
  const exact=decimals===null?value.toString()+' raw units':formatUnits(value,decimals),label=exact+(symbol?' '+symbol:'');
  return <span className="balance-amount" title={label} data-exact-amount={exact}><span aria-hidden="true">{decimals===null?value.toString():tokenText(value,decimals,digits)}</span><span style={hiddenExact}>{label}</span></span>;
}
