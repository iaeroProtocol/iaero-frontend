import {createPublicClient,http,isAddress,type Address} from 'viem';
import {base} from 'viem/chains';
import registry from '../config/base.registry.json' with {type:'json'};
import tokenFilter from '../config/spam-tokens.base.json' with {type:'json'};
import deployment from '../config/saero.deployment.json' with {type:'json'};
import {inspectBootstrap} from '../server/bootstrap.ts';
import {configuredBaseReads,canonicalReadRequest,scrubReadResponse} from '../server/read-rpc-policy.ts';
import {estimateTokenValue,valueInput,type TokenValue} from '../server/reward-value.ts';
import {loadLiqYield} from '../server/liq-yield.ts';
import {checkQuoteServiceResponse,SweepQuoteError} from '../server/sweep-quote.ts';
import {createReadRpcFetch} from '../server/read-rpc-fetch.ts';
import {bootstrapCacheKey,bootstrapLifetime,createBootstrapCache} from './bootstrap-cache.ts';

export type AppReadEnv={BASE_READ_RPC_URLS?:string;ZERO_EX_API_KEY?:string};
export const appJson=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...headers}});
export const readApiPaths=new Set(['/api/base','/api/contracts','/api/rewards/value','/api/sweep/quote','/api/liq-yield']);
// Only reservation timestamps cross Worker invocations, never pending I/O.
const rpcStartTimes=new Map<string,number>();

// Fetch + injected secret bindings only: no filesystem, SQLite or signing keys.
export function createAppReadApi(env:AppReadEnv,options:{fetchImpl?:typeof fetch;inspect?:()=>Promise<any>;now?:()=>number;bootstrapCache?:ReturnType<typeof createBootstrapCache>;waitUntil?:(task:Promise<unknown>)=>void}={}){
 const fetcher=options.fetchImpl??fetch,now=options.now??Date.now,urls=configuredBaseReads(env.BASE_READ_RPC_URLS??'');
 const rpcFetch=createReadRpcFetch({alchemyBurst:true,fetchImpl:fetcher,states:new Map(),startTimes:rpcStartTimes,maxQueueMs:15000}),sharedKey=options.bootstrapCache?bootstrapCacheKey({urls,registry,deployment,tokenFilter}):undefined;
 let active=0;const queue:(()=>void)[]=[];
 async function bounded<T>(run:()=>Promise<T>){if(active>=6){if(queue.length>=100)throw Error('Read service busy');await new Promise<void>(r=>queue.push(r));}else active++;try{return await run();}finally{const next=queue.shift();if(next)next();else active--;}}
 let boot:{expiresAt:number;value:any}|undefined,pending:Promise<any>|undefined;
 async function bootstrap(){
  if(boot&&now()<boot.expiresAt)return boot.value;
  if(!pending){
   pending=(async()=>{const produce=async()=>{const clients=urls.map(url=>createPublicClient({chain:{...base,contracts:{...base.contracts,multicall3:{address:registry.sweep.multicall3 as Address}}},batch:{multicall:{batchSize:16384,wait:0}},transport:http(url,{timeout:20000,retryCount:0,fetchFn:rpcFetch}),ccipRead:false}));const value=options.inspect?await options.inspect():await inspectBootstrap(clients as any,bounded);return {...value,tokenFilter};};const result=options.bootstrapCache?await options.bootstrapCache.run(await sharedKey!,produce):await produce(),verified=Date.parse(result.verifiedAt);boot={expiresAt:(Number.isFinite(verified)?Math.min(now(),verified):now())+bootstrapLifetime(result),value:result};return result;})().finally(()=>{pending=undefined;});
   // Finish the shared proof and release its lease if this visitor navigates away.
   options.waitUntil?.(pending.catch(()=>{}));
  }return pending;
 }
 async function quote(token:Address,amount:bigint,slippage=100,buyToken:Address=registry.legacy.USDC as Address){
  if(!env.ZERO_EX_API_KEY)throw new SweepQuoteError('QUOTE_AUTHENTICATION',503,'The quote service authentication needs attention.');
  const upstream=new URL('https://api.0x.org/swap/allowance-holder/quote');
  upstream.search=new URLSearchParams({chainId:'8453',sellToken:token,sellAmount:amount.toString(),buyToken,taker:registry.sweep.swapper,recipient:registry.sweep.swapper,slippageBps:String(slippage)}).toString();
  return bounded(async()=>{const r=await fetcher(upstream,{headers:{'0x-api-key':env.ZERO_EX_API_KEY!,'0x-version':'v2'},signal:AbortSignal.timeout(25000),redirect:'manual'});if(r.status>=300&&r.status<400){await r.body?.cancel();throw Error('Quote redirect refused');}const data=await r.json().catch(()=>null);checkQuoteServiceResponse(r.status,data);return data;});
 }
 const values=new Map<string,{at:number;pending:Promise<TokenValue>}>();
 let liq:{at:number;pending:Promise<unknown>}|undefined;
 return async(request:Request)=>{
  const url=new URL(request.url),path=url.pathname;
  if(!readApiPaths.has(path))return appJson({error:'Not found.'},404);
  if(request.method!==(path==='/api/base'?'POST':'GET'))return appJson({error:path==='/api/base'?'POST only.':'GET only.'},405);
  try{
   if(path==='/api/contracts')return appJson(await bootstrap());
   if(path==='/api/liq-yield'){if(!liq||now()-liq.at>=60000)liq={at:now(),pending:bootstrap().then(boot=>loadLiqYield(boot,{fetchImpl:fetcher,now:now()})).catch(error=>{liq=undefined;throw error;})};return appJson(await liq.pending);}
   if(path==='/api/base'){
    // Enforce a byte limit even when Content-Length is absent or misleading.
    const length=Number(request.headers.get('content-length')??0);if(length>100000)return appJson({error:'Request too large.'},413);
    const reader=request.body?.getReader();if(!reader)return appJson({error:'Missing read request.'},400);const decoder=new TextDecoder();let size=0,body='';
    try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>100000){await reader.cancel();return appJson({error:'Request too large.'},413);}body+=decoder.decode(chunk.value,{stream:true});}body+=decoder.decode();}finally{reader.releaseLock();}
    let canonical:string;try{canonical=canonicalReadRequest(JSON.parse(body));}catch{return appJson({error:'Only supported Base read and simulation requests are permitted.'},400);}
    await bootstrap();const reply=await bounded(async()=>{const r=await rpcFetch(urls[0],{method:'POST',headers:{'content-type':'application/json'},body:canonical,signal:AbortSignal.timeout(25000),redirect:'manual'});if(!r.ok)throw Error('Base unavailable');return scrubReadResponse(await r.json());});return appJson(reply);
   }
   if(path==='/api/rewards/value'){
    let input;try{input=valueInput(url.searchParams);}catch{return appJson({error:'Invalid reward valuation request.'},400);}
    await bootstrap();const key=input.token.toLowerCase()+':'+input.amount+':'+input.decimals;let cached=values.get(key);
    if(!cached||now()-cached.at>=60000){cached={at:now(),pending:estimateTokenValue(input,{usdc:registry.legacy.USDC as Address,weth:registry.legacy.WETH as Address},quote)};values.set(key,cached);if(values.size>1024)values.delete(values.keys().next().value!);}
    // Never expose quote calldata or an approval as a display valuation.
    return appJson(await cached.pending);
   }
   const params=url.searchParams,sellToken=params.get('sellToken')??'',sellAmount=params.get('sellAmount')??'',slippage=Number(params.get('slippageBps')),buyToken=params.get('buyToken')??registry.legacy.USDC;
   if(!isAddress(sellToken)||BigInt(sellToken)===0n||!isAddress(buyToken)||![registry.legacy.USDC,registry.aero.token].some(a=>a.toLowerCase()===buyToken.toLowerCase())||[registry.legacy.iAERO,registry.legacy.stiAERO,buyToken].some(a=>a.toLowerCase()===sellToken.toLowerCase())||!/^\d{1,78}$/.test(sellAmount)||BigInt(sellAmount)<=0n||BigInt(sellAmount)>=2n**256n||!Number.isInteger(slippage)||slippage<10||slippage>1000)return appJson({error:'Invalid token, output, amount or slippage.'},400);
   const boot=await bootstrap();if(!boot.sweepReady)return appJson({error:'The deployed reward swapper is not verified.'},503);
   if(buyToken.toLowerCase()===registry.aero.token.toLowerCase()&&!boot.aeroCompoundReady)return appJson({error:'The new AERO output and compound route are not verified.'},503);
   const data=await quote(sellToken,BigInt(sellAmount),slippage,buyToken);
   if(data.liquidityAvailable===false||!data.transaction?.data||!isAddress(data.transaction.to)||String(data.sellAmount)!==sellAmount||!/^\d{1,78}$/.test(String(data.buyAmount))||BigInt(data.buyAmount)<=0n||BigInt(data.buyAmount)>=2n**256n||BigInt(data.transaction.value??'0')!==0n)return appJson({code:'INVALID_EXECUTABLE_QUOTE',error:'The service did not return a valid executable quote.'},422);
   if(data.sellToken&&String(data.sellToken).toLowerCase()!==sellToken.toLowerCase()||data.buyToken&&String(data.buyToken).toLowerCase()!==buyToken.toLowerCase())return appJson({code:'INVALID_EXECUTABLE_QUOTE',error:'Quote tokens do not match the requested swap.'},422);
   return appJson({sellToken,sellAmount,buyToken,buyAmount:String(data.buyAmount),minBuyAmount:String(data.minBuyAmount??'0'),taker:registry.sweep.swapper,recipient:registry.sweep.swapper,transaction:{to:data.transaction.to,data:data.transaction.data,value:'0'},quotedAt:now()});
  }catch(error){
   if(error instanceof SweepQuoteError)return appJson({code:error.code,error:error.message},error.status);
   return appJson({error:path==='/api/rewards/value'?'Reward value is unavailable. Claims are unaffected.':path.includes('quote')?'The quote connection is temporarily unavailable. Retry later.':'Verified Base read connection unavailable. Retry later.'},503);
  }
 };
}
