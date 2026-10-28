// [VERIFIED: live Infura HTTP 429, 2026-10-27; https://docs.infura.io/get-started/pricing/credit-cost/]
// Pace a shared API key across its chain URLs. Retries apply only to reads and
// simulations; reverted contract calls and authentication errors are unchanged.
type State={tail:Promise<void>;nextAt:number};
const shared=new Map<string,State>();
const methods=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getCode','eth_getBalance','eth_getStorageAt','eth_getTransactionCount','eth_getTransactionReceipt','eth_getTransactionByHash','eth_call','eth_simulateV1','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','eth_getLogs','eth_getProof','eth_getAccountInfo','net_version']);
// [VERIFIED: https://www.alchemy.com/docs/reference/compute-unit-costs and
// https://www.alchemy.com/docs/reference/throughput, 2026-10-28]
// App opt-in: 100 CU/s sustained with a 400-CU initial burst. Other callers
// keep their existing pacing; no increase in RPC volume.
// This leaves room under the documented 300-CU/s baseline for the separate
// recorder and operator reads. Only numeric virtual-time debt is shared.
const alchemyUnits:Record<string,number>={eth_chainId:5,net_version:5,eth_blockNumber:10,eth_getCode:20,eth_getBalance:20,eth_getStorageAt:20,eth_getBlockByNumber:20,eth_getBlockByHash:20,eth_getTransactionCount:20,eth_getTransactionReceipt:20,eth_getTransactionByHash:20,eth_getProof:20,eth_estimateGas:20,eth_gasPrice:20,eth_maxPriorityFeePerGas:10,eth_feeHistory:10,eth_call:26,eth_simulateV1:40,eth_getLogs:60,eth_getAccountInfo:60};
type Options={alchemyBurst?:boolean;fetchImpl?:typeof fetch;now?:()=>number;sleep?:(ms:number,signal?:AbortSignal|null)=>Promise<void>;states?:Map<string,State>;startTimes?:Map<string,number>;maxQueueMs?:number;retries?:number};
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
    const alchemy=options.alchemyBurst===true&&key.startsWith('alchemy:'),burst=alchemy?4000:0,spacing=alchemy?calls.reduce((sum,c)=>sum+(alchemyUnits[c.method]??60)*10,0):key.startsWith('infura:')?calls.reduce((sum,c)=>sum+(c.method==='eth_getLogs'?1600:500),0):200*calls.length;
    if(options.startTimes&&!options.startTimes.has(key)&&options.startTimes.size>=32)throw Error('Too many RPC sources.');
    const debt=Math.max(current.nextAt,options.startTimes?.get(key)??0),start=Math.max(now(),debt+(alchemy?spacing:0)-burst),next=alchemy?Math.max(now(),debt)+spacing:start+spacing;
    if(options.maxQueueMs!==undefined&&start-now()>options.maxQueueMs)throw Error('Read service is busy. Retry shortly.');
    options.startTimes?.set(key,next);current.nextAt=next;
    await wait(Math.max(0,start-now()),signal);abort(signal);
    const response=await fetcher(input instanceof Request?input.clone():input,{...init,redirect:'manual'});
    if(![429,502,503,504].includes(response.status)||attempt>=(options.retries??3))return response;
    const raw=response.headers.get('retry-after'),seconds=raw!==null?Number(raw):NaN,date=raw!==null?Date.parse(raw):NaN;
    const retry=Number.isFinite(seconds)?Math.max(0,seconds*1000):Number.isFinite(date)?Math.max(0,date-now()):500*2**attempt;
    current.nextAt=Math.max(current.nextAt,now()+retry+burst);if(options.startTimes)options.startTimes.set(key,Math.max(options.startTimes.get(key)??0,current.nextAt));await response.body?.cancel();
   }
  });
  current.tail=task.then(()=>{},()=>{});
  if(!signal)return task;
  return new Promise<Response>((resolve,reject)=>{const stop=()=>reject(signal.reason??new DOMException('Read cancelled','AbortError'));signal.addEventListener('abort',stop,{once:true});task.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));if(signal.aborted)stop();});
 }) as typeof fetch;
}
export const readRpcFetch=createReadRpcFetch();
