import type {CSSProperties} from 'react';

export type IconName='arrow'|'up-right'|'chevron'|'plus'|'minus'|'check'|'close'|'wallet'|'chart'|'layers'|'gift'|'shield'|'spark'|'clock'|'copy'|'info'|'sun'|'moon'|'menu'|'external'|'swap'|'globe'|'book'|'refresh'|'coin'|'download';
const paths:Record<IconName,React.ReactNode>={
  arrow:<><path d="M4 12h15M13 6l6 6-6 6"/></>,
  'up-right':<><path d="M6 18 18 6M6 6h12v12"/></>,
  chevron:<path d="m8 5 7 7-7 7"/>,
  plus:<path d="M12 5v14M5 12h14"/>,minus:<path d="M5 12h14"/>,
  check:<path d="m5 12 4 4L19 6"/>,close:<path d="m6 6 12 12M18 6 6 18"/>,
  wallet:<><path d="M19 7V5a2 2 0 0 0-2-2L5 6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5"/><path d="M21 11h-6v5h6M17 13.5h.01"/></>,
  chart:<><path d="M4 4v16h17M7 15l4-5 4 3 6-8"/></>,
  layers:<><path d="m12 3 10 5-10 5L2 8l10-5ZM2 13l10 5 10-5M2 18l10 5 10-5"/></>,
  gift:<><path d="M3 8h18v5H3zM5 13v8h14v-8M12 8v13"/><path d="M12 8S4 8 6 4s6 4 6 4Zm0 0s8 0 6-4-6 4-6 4Z"/></>,
  shield:<><path d="m12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
  spark:<><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/></>,
  clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  copy:<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></>,
  info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
  sun:<><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></>,
  moon:<path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/>,
  menu:<path d="M4 6h16M4 12h16M4 18h16"/>,external:<><path d="M14 3h7v7M21 3 10 14M10 3H4v17h17v-6"/></>,
  swap:<><path d="M4 7h16l-4-4M20 17H4l4 4"/></>,
  globe:<><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>,
  book:<><path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15"/></>,
  refresh:<><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/></>,
  coin:<><circle cx="12" cy="12" r="9"/><path d="M15 8h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H8M12 5v3M12 16v3"/></>,
  download:<><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>
};
export function Icon({name,size=20,className='',style}:{name:IconName;size?:number;className?:string;style?:CSSProperties}){
  return <svg className={'icon '+className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>;
}

export function BrandMark({className=''}:{className?:string}){return <svg className={'brand-mark '+className} width="38" height="38" viewBox="0 0 64 64" aria-hidden="true"><path d="M30 8a4 4 0 0 1 5 0l20 20a5 5 0 0 1 0 7L35 56a4 4 0 0 1-6 0L9 35a5 5 0 0 1 0-7Z" fill="currentColor"/><path d="m33 20-13 14 13 14 13-14Z" fill="var(--surface)"/><path d="M8 40C-1 55 43 47 57 28c8-11 1-13-5-11 17-2 11 12-4 23C29 54 1 57 8 40Z" fill="var(--ink)" stroke="var(--surface)" strokeWidth="2"/></svg>;}

export function TokenIcon({token='iAERO',size=36}:{token?:string;size?:number}){
  return <span className={'token-icon token-'+token.toLowerCase().replace(/[^a-z0-9_-]/g,'')} style={{width:size,height:size}} aria-hidden="true">{token==='USDC'?<span className="usdc-symbol">$</span>:token==='LIQ'?<Icon name="spark" size={size*.55}/>:token==='stiAERO'?<Icon name="layers" size={size*.52}/>:token==='ETH'||token==='WETH'?<svg width={size*.55} height={size*.75} viewBox="0 0 24 34" fill="currentColor"><path d="m12 0 11 18-11 6L1 18 12 0Z" opacity=".85"/><path d="m1 21 11 13 11-13-11 6-11-6Z" opacity=".65"/></svg>:!['iAERO','AERO'].includes(token)?<Icon name="coin" size={size*.56}/>:<svg width={size*.7} height={size*.7} viewBox="0 0 32 32" fill="none"><path d="m16 5 11 12-11 12L5 17 16 5Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round"/><path d="M3 20c-4 8 22 4 28-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/></svg>}</span>;
}
