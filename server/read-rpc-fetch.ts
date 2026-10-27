// [VERIFIED: live Infura HTTP 429, 2026-10-27; https://docs.infura.io/get-started/pricing/credit-cost/]
// Pace a shared API key across its chain URLs. Retries apply only to reads and
// simulations; reverted contract calls and authentication errors are unchanged.
type State={tail:Promise<void>;nextAt:number};
const shared=new Map<string,State>();
const methods=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getCode','eth_getBalance','eth_getStorageAt','eth_getTransactionCount','eth_getTransactionReceipt','eth_getTransactionByHash','eth_call','eth_simulateV1','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','eth_getLogs','eth_getProof','eth_getAccountInfo','net_version']);
type Options={fetchImpl?:typeof fetch;now?:()=>number;sleep?:(ms:number,signal?:AbortSignal|null)=>Promise<void>;states?:Map<string,State>;startTimes?:Map<string,number>;retries?:number};
function abort(signal?:AbortSignal|null){if(signal?.aborted)throw signal.reason??new DOMException('Read cancelled','AbortError');}
const sleep=(ms:number,signal?:AbortSignal|null)=>new Promise<void>((resolve,reject)=>{abort(signal);const stop=()=>{clearTimeout(timer);reject(signal?.reason??new DOMException('Read cancelled','AbortError'));},timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);signal?.addEventListener('abort',stop,{once:true});});
function group(url:URL){const host=url.hostname.toLowerCase();return /(?:^|\.)infura\.io$/.test(host)?'infura:'+url.pathname:/(?:^|\.)alchemy\.com$/.test(host)?'alchemy:'+url.pathname:url.origin+url.pathname;}
export function createReadRpcFetch(options:Options={}):typeof fetch{
 const fetcher=options.fetchImpl??fetch,now=options.now??Date.now,wait=options.sleep??sleep,states=options.states??shared;
 return (async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),body=init?.body??(input instanceof Request?await input.clone().text():undefined);
  let calls:any[];try{const parsed=JSON.parse(typeof body==='string'?body:'');calls=Array.isArray(parsed)?parsed:[parsed];if(!calls.length||calls.some(c=>!c||!methods.has(c.method)))throw Error();}catch{throw Error('Read-only RPC request required.');}
  const key=group(url),signal=init?.signal??(input instanceof Request?input.signal:undefined);abort(signal);
  let state=states.get(key);if(!state){if(states.size>=32)throw Error('Too many RPC sources.');state={tail:Promise.resolve(),nextAt:0};states.set(key,state);}
  const current=state,task=current.tail.then(async()=>{
   for(let attempt=0;;attempt++){
    abort(signal);
    // Leave room for the separate app, collector and read-only operator checks
    // under Infura's documented 500-credit/s baseline. Logs cost more than reads.
    const spacing=key.startsWith('infura:')?calls.reduce((sum,c)=>sum+(c.method==='eth_getLogs'?1600:500),0):200*calls.length;
    let start=Math.max(current.nextAt,now());
    if(options.startTimes){if(!options.startTimes.has(key)&&options.startTimes.size>=32)throw Error('Too many RPC sources.');start=Math.max(start,options.startTimes.get(key)??0);options.startTimes.set(key,start+spacing);}
    await wait(Math.max(0,start-now()),signal);abort(signal);current.nextAt=now()+spacing;
    const response=await fetcher(input instanceof Request?input.clone():input,{...init,redirect:'manual'});
    if(![429,502,503,504].includes(response.status)||attempt>=(options.retries??3))return response;
    const raw=response.headers.get('retry-after'),seconds=raw!==null?Number(raw):NaN,date=raw!==null?Date.parse(raw):NaN;
    const retry=Number.isFinite(seconds)?Math.max(0,seconds*1000):Number.isFinite(date)?Math.max(0,date-now()):500*2**attempt;
    current.nextAt=Math.max(current.nextAt,now()+retry);await response.body?.cancel();
   }
  });
  current.tail=task.then(()=>{},()=>{});
  if(!signal)return task;
  return new Promise<Response>((resolve,reject)=>{const stop=()=>reject(signal.reason??new DOMException('Read cancelled','AbortError'));signal.addEventListener('abort',stop,{once:true});task.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));if(signal.aborted)stop();});
 }) as typeof fetch;
}
export const readRpcFetch=createReadRpcFetch();
