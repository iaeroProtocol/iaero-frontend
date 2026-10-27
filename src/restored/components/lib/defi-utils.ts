import {useEffect,useState} from 'react';
export function useDebounce<T>(value:T,delay:number){const [out,setOut]=useState(value);useEffect(()=>{const timer=setTimeout(()=>setOut(value),delay);return()=>clearTimeout(timer);},[value,delay]);return out;}
