import {Component,lazy,Suspense,useMemo,useState,type ComponentType,type ReactNode} from 'react';
type BoundaryProps={children:ReactNode;fallback:(retry:()=>void)=>ReactNode;onRetry:()=>void};
class Boundary extends Component<BoundaryProps,{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?this.props.fallback(()=>{this.props.onRetry();this.setState({failed:false});}):this.props.children;}
}
export function RecoveryControls({name,retry}:{name:string;retry:()=>void}){
 return <div className="section-recovery" role="alert"><p>{name} could not load. Your saved activity is retained.</p><div><button className="button button-secondary" onClick={retry}>Try loading again</button><button className="text-link" onClick={()=>window.location.reload()}>Reload this page</button></div></div>;
}
export function AsyncSection({name,loader,componentProps={},loading=null,renderError}:{name:string;loader:()=>Promise<{default:ComponentType<any>}>;componentProps?:Record<string,unknown>;loading?:ReactNode;renderError?:(retry:()=>void)=>ReactNode}){
 const [attempt,setAttempt]=useState(0),Section=useMemo(()=>lazy(loader),[loader,attempt]);
 return <Boundary key={attempt} onRetry={()=>setAttempt(v=>v+1)} fallback={retry=>renderError?.(retry)??<div className="card section-unavailable"><RecoveryControls name={name} retry={retry}/></div>}><Suspense fallback={loading}><Section {...componentProps}/></Suspense></Boundary>;
}
export class AppErrorBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<main className="app-recovery"><h1>The app could not display this page.</h1><p>Check any pending wallet request before reloading. Saved orders and transaction records stay in this browser.</p><button className="button button-primary" onClick={()=>window.location.reload()}>Reload the app</button></main>:this.props.children;}
}
