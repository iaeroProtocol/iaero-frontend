import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {Icon,TokenIcon,type IconName} from './icons';
import {usePreview} from './store';
import {LiveRevenueChart} from './live/views';

export function Button({children,variant='primary',className='',icon,iconLeft,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'primary'|'secondary'|'ghost'|'dark';icon?:IconName;iconLeft?:IconName}){
  return <button className={`button button-${variant} ${className}`} {...props}>{iconLeft&&<Icon name={iconLeft} size={17}/>}<span>{children}</span>{icon&&<Icon name={icon} size={17}/>}</button>;
}
export function Pill({children,tone='blue',dot=false}:{children:ReactNode;tone?:'blue'|'green'|'neutral'|'amber';dot?:boolean}){return <span className={'pill pill-'+tone}>{dot&&<span className="status-dot"/>}{children}</span>;}
export function Info({children,tone='neutral'}:{children:ReactNode;tone?:'neutral'|'blue'|'amber'}){return <div className={'info-box info-'+tone}><Icon name="info" size={17}/><div>{children}</div></div>;}
export function SectionHeading({eyebrow,title,children}:{eyebrow?:string;title:string;children?:ReactNode}){return <div className="section-heading"><div>{eyebrow&&<p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>{children}</div>;}
export function TokenPair({from='iAERO',to='USDC'}:{from?:string;to?:string}){return <span className="token-pair"><TokenIcon token={from}/><TokenIcon token={to}/></span>;}

export function SegmentedTabs<T extends string>({id,label,value,options,onChange,className}:{id:string;label:string;value:T;options:readonly {value:T;label:string}[];onChange:(value:T)=>void;className:string}){
  return <div className={className} role="tablist" aria-label={label} onKeyDown={e=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();const index=options.findIndex(o=>o.value===value);
    const next=e.key==='Home'?0:e.key==='End'?options.length-1:(index+(e.key==='ArrowRight'?1:-1)+options.length)%options.length;
    onChange(options[next].value);e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }}>{options.map(option=><button key={option.value} id={id+'-'+option.value} role="tab" aria-controls={id+'-panel'} aria-selected={value===option.value} tabIndex={value===option.value?0:-1} onClick={()=>onChange(option.value)}>{option.label}</button>)}</div>;
}

export function Dialog({title,subtitle,children,onClose,busy=false,className='',stepKey}:{title:string;subtitle?:string;children:ReactNode;onClose:()=>void;busy?:boolean;className?:string;stepKey?:string}){
  const id=useId(),ref=useRef<HTMLDivElement>(null),onCloseRef=useRef(onClose),busyRef=useRef(busy);onCloseRef.current=onClose;busyRef.current=busy;
  useEffect(()=>{
    if(stepKey===undefined)return;
    const panel=ref.current;
    panel?.querySelector<HTMLElement>('.dialog-heading h2')?.focus({preventScroll:true});
    panel?.scrollTo({top:0,behavior:'instant'});
  },[stepKey]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement,overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const panel=ref.current;
    const timer=setTimeout(()=>(panel?.querySelector<HTMLElement>('[data-autofocus]')??panel?.querySelector<HTMLElement>(stepKey===undefined?'button,input,a[href]':'.dialog-heading h2'))?.focus({preventScroll:true}),20);
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape'&&!busyRef.current){e.preventDefault();onCloseRef.current();}
      if(e.key==='Tab'&&panel){
        const items=[...panel.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href],[tabindex="0"]')].filter(x=>x.offsetParent!==null);
        const first=items[0],last=items.at(-1);
        if(!first){e.preventDefault();panel.focus();}
        else if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',key);return()=>{clearTimeout(timer);document.removeEventListener('keydown',key);document.body.style.overflow=overflow;previous?.focus?.({preventScroll:true});};
  },[]);
  return <div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}><div className={'dialog '+className} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
    <div className="dialog-topbar"><div className="dialog-heading"><h2 id={id} tabIndex={stepKey===undefined?undefined:-1}>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div><button className="icon-button dialog-close" aria-label="Close dialog" onClick={onClose} disabled={busy}><Icon name="close"/></button></div>{children}
  </div></div>;
}

export function OrbitalScene(){return <div className="orbital-scene" aria-hidden="true"><svg viewBox="0 0 640 470" fill="none">
  <defs>
    <radialGradient id="aura"><stop stopColor="#266ffe" stopOpacity=".32"/><stop offset="1" stopColor="#266ffe" stopOpacity="0"/></radialGradient>
    <radialGradient id="planet" cx=".26" cy=".2" r=".86"><stop stopColor="#b4e6ff"/><stop offset=".19" stopColor="#5abaff"/><stop offset=".5" stopColor="#2175f3"/><stop offset=".79" stopColor="#0630ac"/><stop offset="1" stopColor="#030f45"/></radialGradient>
    <linearGradient id="ring" x1="136" y1="360" x2="514" y2="100" gradientUnits="userSpaceOnUse"><stop stopColor="#4a6c9f"/><stop offset=".25" stopColor="#e6f4ff"/><stop offset=".43" stopColor="#658bb9"/><stop offset=".72" stopColor="#f1f8ff"/><stop offset="1" stopColor="#203c6d"/></linearGradient>
    <linearGradient id="line" x1="204" y1="130" x2="449" y2="354" gradientUnits="userSpaceOnUse"><stop stopColor="#e3f7ff" stopOpacity=".7"/><stop offset="1" stopColor="#75b9ff" stopOpacity=".07"/></linearGradient>
    <clipPath id="ball"><circle cx="336" cy="236" r="135"/></clipPath>
    <filter id="shadow"><feGaussianBlur stdDeviation="14"/></filter>
  </defs>
  <ellipse cx="335" cy="250" rx="284" ry="222" fill="url(#aura)"/>
  <g className="orbital-float">
    <ellipse cx="334" cy="247" rx="233" ry="68" transform="rotate(-33 334 247)" stroke="#6582ad" strokeOpacity=".28" strokeWidth="1"/>
    <ellipse cx="334" cy="247" rx="206" ry="57" transform="rotate(-33 334 247)" stroke="url(#ring)" strokeWidth="9"/>
    <circle cx="336" cy="236" r="135" fill="url(#planet)"/>
    <g clipPath="url(#ball)" stroke="url(#line)" strokeWidth=".8" opacity=".6">
      {[-108,-72,-36,0,36,72,108].map(y=><ellipse key={y} cx="336" cy={236+y*.86} rx={Math.sqrt(135**2-y**2)} ry="26" transform="rotate(-18 336 236)"/>)}
      {[30,61,93,120].map(x=><ellipse key={x} cx="336" cy="236" rx={x} ry="135" transform="rotate(-18 336 236)"/>)}
      <path d="m231 148 205 190M227 325l202-185" strokeOpacity=".25"/>
    </g>
    <circle cx="336" cy="236" r="134.5" stroke="#c9eaff" strokeOpacity=".26"/>
    <path d="M161 355c18 31 112 0 211-64s164-140 146-170" stroke="url(#ring)" strokeWidth="10" strokeLinecap="round"/>
    <path d="M161 353c18 31 112 0 211-64s164-140 146-170" stroke="#e0f4ff" strokeOpacity=".7" strokeWidth="1"/>
    <g transform="translate(336 229) rotate(-18)"><path d="m0-49 45 48L0 47-45-1 0-49Z" fill="#c2e8ff" fillOpacity=".15" stroke="#d5efff" strokeOpacity=".62" strokeWidth="1.4"/><path d="m0-27 25 26L0 25-25-26 0-27Z" stroke="#d6f0ff" strokeOpacity=".6" strokeWidth="1"/></g>
  </g>
  <circle cx="154" cy="116" r="3.5" fill="#91bffb"/><circle cx="512" cy="335" r="2" fill="#74b4ff"/>
  <path d="M502 110h8m-4-4v8M178 303h6m-3-3v6" stroke="#8eb1e0" strokeOpacity=".6"/>
  <circle cx="191" cy="372" r="1.3" fill="#c5daff"/><circle cx="483" cy="85" r="1" fill="#c5daff"/>
  <g className="orbital-chip"><rect x="454" y="301" width="107" height="43" rx="13" fill="#15233b" fillOpacity=".85" stroke="#6a8aaf" strokeOpacity=".35"/><circle cx="478" cy="322" r="10" fill="#326dea"/><path d="m478 316 5.5 6-5.5 6-5.5-6 5.5-6Z" stroke="white" strokeWidth="1.5"/><text x="495" y="327" fill="#e5edfc" fontFamily="Manrope,sans-serif" fontSize="12" fontWeight="600">iAERO</text></g>
</svg></div>;}

function smoothPath(points:[number,number][]){
  return points.map(([x,y],i)=>{if(!i)return `M ${x} ${y}`;const [px,py]=points[i-1],mid=(px+x)/2;return `C ${mid} ${py} ${mid} ${y} ${x} ${y}`;}).join(' ');
}
export function RevenueChart(){
  const [range,setRange]=useState<'7D'|'30D'|'90D'>('30D'),[hover,setHover]=useState<number|null>(null);
  const svg=useRef<SVGSVGElement>(null),uid=useId().replace(/:/g,'');
  const {mode}=usePreview();
  if(mode==='live')return <LiveRevenueChart/>;
  const values=range==='7D'?[0,6,12,12,19,22,26,38,42,52,56,61]:range==='30D'?[0,5,8,8,14,16,16,20,21,27,27,32,37,38,45,46,49,57,58,62,68,69,74,83]:[0,7,12,13,19,20,27,31,35,36,42,45,50,52,60,64,69,72,75,80,83,87,92,95];
  const total=range==='7D'?8621.40:range==='30D'?32841.76:89420.31,max=range==='7D'?10000:range==='30D'?40000:100000;
  const amounts=values.map(value=>value/values[values.length-1]*total);
  const pts=amounts.map((value,i)=>[8+i*(645/(values.length-1)),175-value/max*150] as [number,number]);
  const line=smoothPath(pts),area=line+` L 653 185 L 8 185 Z`;
  const selected=hover??values.length-1;
  return <article className="card revenue-card"><div className="card-title-row"><div><p className="label-with-dot"><span className="small-blue-dot"/>Protocol revenue</p><h3 className="chart-total">${total.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}<span className="chart-unit">USDC</span></h3><p className="small muted">Revenue distributed to iAERO stakers <span className="positive">↗ {range==='7D'?'8.2':'14.6'}%</span></p></div><div className="range-selector" aria-label="Revenue chart time range">{(['7D','30D','90D'] as const).map(r=><button key={r} aria-pressed={r===range} onClick={()=>{setRange(r);setHover(null);}}>{r}</button>)}</div></div>
    <div className="chart-container"><div className="chart-y-axis">{[1,.75,.5,.25,0].map(fraction=><span key={fraction}>{fraction?'$'+max*fraction/1000+'k':'$0'}</span>)}</div>
    <svg ref={svg} viewBox="0 0 672 198" role="img" aria-label={`Illustrative ${range} USDC revenue chart`} onMouseMove={e=>{const rect=svg.current?.getBoundingClientRect();if(rect)setHover(Math.min(values.length-1,Math.max(0,Math.round((e.clientX-rect.left)/rect.width*(values.length-1)))));}} onMouseLeave={()=>setHover(null)}>
      <defs><linearGradient id={'chart-fill-'+uid} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#488bff" stopOpacity=".21"/><stop offset="1" stopColor="#488bff" stopOpacity=".015"/></linearGradient></defs>
      {[25,62.5,100,137.5,175].map(y=><path key={y} d={`M0 ${y} H672`} stroke="var(--line)" strokeDasharray="3 5"/>)}
      <path d={area} fill={`url(#chart-fill-${uid})`}/><path d={line} stroke="#397cf5" strokeWidth="2.7" strokeLinejoin="round" strokeLinecap="round" fill="none"/>
      {hover!==null&&<><path d={`M ${pts[selected][0]} 8 V186`} stroke="#7faaff" strokeDasharray="3 3"/><circle cx={pts[selected][0]} cy={pts[selected][1]} r="5" fill="#3379f5" stroke="var(--surface)" strokeWidth="3"/></>}
    </svg>{hover!==null&&<span className="chart-point-readout">{amounts[selected].toLocaleString('en-US',{maximumFractionDigits:0})} USDC</span>}</div><div className="chart-x-axis">{(range==='7D'?['19 Oct','20 Oct','21 Oct','22 Oct','23 Oct','25 Oct']:range==='30D'?['25 Sep','1 Oct','7 Oct','13 Oct','19 Oct','25 Oct']:['Jul','Aug','Sep','Oct']).map(x=><span key={x}>{x}</span>)}</div>
    <div className="chart-footer"><span><Icon name="shield" size={14}/>Rewards paid in USDC</span><span>Illustrative preview data</span></div>
  </article>;
}

export function EmptyWallet({title='Your position starts here',text='Connect a demo wallet to explore your balances, rewards and the new staking experience.'}:{title?:string;text?:string}){
  const {setWalletDialog,mode}=usePreview();return <div className="empty-wallet"><span className="empty-wallet-icon"><Icon name="wallet" size={26}/></span><h3>{title}</h3><p>{mode==='live'?'Connect your browser wallet to read your actual balances, previous stake and selected rewards on Base.':text}</p><Button onClick={()=>setWalletDialog(true)} icon="arrow">{mode==='live'?'Connect your wallet':'Explore demo wallet'}</Button></div>;
}
