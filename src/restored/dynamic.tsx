import {lazy,Suspense,type ComponentType} from 'react';
export default function dynamic<P extends object>(loader:()=>Promise<{default:ComponentType<P>}>,_options?:{ssr?:boolean}){const Child=lazy(loader);return (props:P)=><Suspense fallback={<p role="status">Loading payment details…</p>}><Child {...props}/></Suspense>;}
