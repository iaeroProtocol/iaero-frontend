import {useEffect,useRef,useState} from 'react';
import {publicError} from './client';

type Snapshot<T>={key:string;data?:T;error?:string;reading:boolean;observedAt?:number;revision:number};
type Options<T>={delayMs?:number;pollMs?:number;maxAgeMs?:number;observedAt?:(data:T)=>number;problem?:(data:T)=>string|undefined};
export class InvalidReadResponse extends Error {}
export function useReadExpiry(observedAt:number|undefined,maxAgeMs=120000){
 const [,tick]=useState(0),deadline=observedAt===undefined?undefined:observedAt+maxAgeMs;
 useEffect(()=>{if(deadline===undefined)return;const update=()=>tick(n=>n+1),timer=setTimeout(update,Math.max(1,Math.min(2147483647,deadline-Date.now()+1)));window.addEventListener('focus',update);return()=>{clearTimeout(timer);window.removeEventListener('focus',update);};},[deadline]);
 return observedAt!==undefined&&(Date.now()>=observedAt+maxAgeMs||observedAt>Date.now()+5000);
}

// Display data stays bound to its account, network, contract and input key.
// Refreshes are serialized: a slow read finishes before one queued refresh.
// Errors retain the original observation time, never extending its deadline.
export function useRetainedRead<T>(key:string|undefined,revision:unknown,load:()=>Promise<T>,options:Options<T>={}){
 const [snapshot,setSnapshot]=useState<Snapshot<T>>(),latest=useRef({load,options}),kick=useRef<(()=>void)|undefined>(undefined),requested=useRef({key,revision});
 latest.current={load,options};
 const delay=options.delayMs??0,poll=options.pollMs??0;
 useEffect(()=>{
  requested.current={key,revision};if(!key){kick.current=undefined;return;}
  let active=true,running=false,queued=false,start:ReturnType<typeof setTimeout>|undefined;
  const run=async()=>{
   if(!active)return;if(running){queued=true;return;}running=true;
   do{
    queued=false;setSnapshot(old=>({...(old?.key===key?old:{key,revision:0}),reading:true}));
    const reader=latest.current;
    try{
     const data=await reader.load();if(!active)return;
     const error=reader.options.problem?.(data),observedAt=reader.options.observedAt?.(data)??Date.now();
     setSnapshot(old=>error&&old?.key===key&&old.data!==undefined?{...old,error,reading:true}:{key,data,error,reading:true,observedAt,revision:(old?.key===key?old.revision:0)+1});
    }catch(error){if(active)setSnapshot(old=>({...((old?.key===key&&!(error instanceof InvalidReadResponse))?old:{key,revision:0}),reading:true,error:publicError(error)}));}
   }while(active&&queued);
   running=false;if(active)setSnapshot(old=>old?.key===key?{...old,reading:false}:old);
  };
  const request=()=>{if(start){clearTimeout(start);start=undefined;}void run();};kick.current=request;
  if(delay)start=setTimeout(request,delay);else request();
  const interval=poll?setInterval(()=>{if(!document.hidden)request();},poll):undefined;
  const visible=()=>{if(poll&&!document.hidden)request();};document.addEventListener('visibilitychange',visible);
  return()=>{active=false;clearTimeout(start);clearInterval(interval);document.removeEventListener('visibilitychange',visible);if(kick.current===request)kick.current=undefined;};
 },[key,delay,poll]);
 useEffect(()=>{if(requested.current.key===key&&Object.is(requested.current.revision,revision))return;requested.current={key,revision};kick.current?.();},[key,revision]);
 const current=snapshot?.key===key?snapshot:undefined,expired=useReadExpiry(options.maxAgeMs===undefined?undefined:current?.observedAt,options.maxAgeMs);
 return {data:current?.data,error:current?.error,reading:!!key&&(!current||current.reading),revision:current?.revision??0,expired};
}
