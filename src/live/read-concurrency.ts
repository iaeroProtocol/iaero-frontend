// Bound metadata fan-out as well as reward preview calls. Large wallets must
// not reserve hundreds of server RPC slots before other balances can load.
export async function mapReadBatches<T,R>(items:readonly T[],run:(item:T,index:number)=>Promise<R>){
 const out:R[]=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
  while(next<items.length){const i=next++;out[i]=await run(items[i],i);}
 }));return out;
}
