import {createReadRpcFetch} from './read-rpc-fetch.ts';
// Node-only app queue; the scheduled recorder retains its separate policy.
const readRpcFetch=createReadRpcFetch({alchemyBurst:true,states:new Map()});
import {allowApiRequest,configuredBaseReads,clientAddressResolver} from './access-policy.ts';
import {liqYield} from './liq-yield.ts';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createPublicClient,http,isAddress,keccak256,parseAbi} from 'viem';
import {base} from 'viem/chains';
import registry from '../config/base.registry.json' with {type:'json'};
import {estimateTokenValue,valueInput,type TokenValue} from './reward-value.ts';
import tokenFilter from '../config/spam-tokens.base.json' with {type:'json'};
import {readProtocolMarketMetrics} from './protocol-metrics.ts';
import {protocolYield,syncProtocolYield,yieldHistory} from './protocol-yield.ts';
import deployment from '../config/saero.deployment.json' with {type:'json'};
import {inspectBootstrap} from './bootstrap.ts';
import {legacyHistory,syncLegacyHistory} from './legacy-history.ts';
import {checkQuoteServiceResponse,SweepQuoteError} from './sweep-quote.ts';

import {canonicalReadRequest,scrubReadResponse as scrub} from './read-rpc-policy.ts';
export {canonicalReadRequest} from './read-rpc-policy.ts';
const json=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
let settings:Promise<string[]>|undefined;
async function rpcSettings(){
  settings??=(async()=>{
    if(process.env.BASE_READ_RPC_URLS)return configuredBaseReads(process.env.BASE_READ_RPC_URLS);
    // Server-only, exact previously authorized RPC settings. No wallet key is selected.
    const raw=await readFile(resolve(process.cwd(),'../../protocol/.env'),'utf8');
    const get=(name:string)=>{
      const match=raw.match(new RegExp('^\\s*(?:export\\s+)?'+name+'\\s*=\\s*(.*)$','m'));
      if(!match)throw Error('Base read connection is not configured.');
      return match[1].trim().replace(/^["']|["']$/g,'');
    };
    const urls=configuredBaseReads(JSON.stringify([get('RPC_URL')]));
    return urls;
  })();
  return settings;
}

let active=0;const waiting:(()=>void)[]=[];
async function bounded<T>(run:()=>Promise<T>){
  if(active>=6){if(waiting.length>=100)throw Error('Read service is busy.');await new Promise<void>(r=>waiting.push(r));}else active++;
  try{return await run();}finally{const next=waiting.shift();if(next)next();else active--;}
}
let bootCache:{at:number;data:any}|undefined,bootInFlight:Promise<any>|undefined;
const valueCache=new Map<string,{at:number;pending:Promise<TokenValue>}>();
async function readBootstrap(){
  const urls=await rpcSettings();
  const clients=urls.map(url=>createPublicClient({chain:base,transport:http(url,{timeout:20000,retryCount:0,fetchFn:readRpcFetch}),ccipRead:false}));
  const data=await inspectBootstrap(clients as any,bounded);
  const result={...data,tokenFilter};bootCache={at:Date.now(),data:result};return result;
}
export async function publicBootstrap(force=false){
  if(!force&&bootCache&&Date.now()-bootCache.at<60000)return bootCache.data;
  bootInFlight??=readBootstrap().finally(()=>{bootInFlight=undefined;});return bootInFlight;
}

let yieldTimer:ReturnType<typeof setInterval>|undefined;
export function baseApiMiddleware(options:{publicOrigin?:string;collect?:boolean;clientAddress?:ReturnType<typeof clientAddressResolver>}={}){
  const clientAddress=options.clientAddress??clientAddressResolver();
  // Read-only recorder continues while this local server runs, including without an open browser.
  if(options.collect!==false&&!yieldTimer&&!process.env.VITEST){
    const legacyTick=()=>{void rpcSettings().then(syncLegacyHistory).then(state=>{if(!state.complete){const timer=setTimeout(legacyTick,15000);timer.unref();}}).catch(()=>{});};
    const tick=()=>{void rpcSettings().then(urls=>syncProtocolYield(urls,()=>publicBootstrap())).catch(()=>{});legacyTick();};
    const initial=setTimeout(tick,10000);initial.unref();yieldTimer=setInterval(tick,300000);yieldTimer.unref();
  }
  return async(req:IncomingMessage,res:ServerResponse,next:()=>void)=>{
    const path=req.url?.split('?')[0];if(!['/api/base','/api/contracts','/api/sweep/quote','/api/rewards/value','/api/liq-yield','/api/protocol-yield','/api/protocol-yield/history','/api/rift/holdings','/api/legacy-history'].includes(path??''))return next();
    const respond=(status:number,body:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(json(body));};
    try{
      const host=req.headers.host??'';
      if(!allowApiRequest(host,req.headers.origin,options.publicOrigin))return respond(403,{error:'Local same-origin requests only.'});
      if(path==='/api/liq-yield'){if(req.method!=='GET')return respond(405,{error:'GET only.'});return respond(200,await liqYield(()=>publicBootstrap()));}
      if(path==='/api/legacy-history'){if(req.method!=='GET')return respond(405,{error:'GET only.'});void rpcSettings().then(syncLegacyHistory).catch(()=>{});return respond(200,await legacyHistory()??{status:'INDEXING',complete:false});}
      if(path==='/api/rift/holdings'){if(req.method!=='GET')return respond(405,{error:'GET only.'});const {GET}=await import('./rift-holdings.ts'),request=Object.assign(new Request('http://'+host+req.url,{headers:{'x-forwarded-for':clientAddress(req)}}),{nextUrl:new URL('http://'+host+req.url)}),reply=await GET(request);res.statusCode=reply.status;reply.headers.forEach((v,k)=>res.setHeader(k,v));res.end(await reply.text());return;}
      if(path==='/api/protocol-yield'||path==='/api/protocol-yield/history'){
        if(req.method!=='GET')return respond(405,{error:'GET only.'});
        if(path.endsWith('/history')){res.setHeader('Content-Disposition','attachment; filename="iaero-protocol-yield-history.json"');return respond(200,await yieldHistory());}
        return respond(200,await protocolYield(await rpcSettings(),()=>publicBootstrap()));
      }
      if(path==='/api/rewards/value'){
        if(req.method!=='GET')return respond(405,{error:'GET only.'});
        let input;try{input=valueInput(new URL(req.url!,'http://'+host).searchParams);}catch{return respond(400,{error:'Invalid reward valuation request.'});}
        await publicBootstrap();
        const key=input.token.toLowerCase()+':'+input.amount+':'+input.decimals;
        let cached=valueCache.get(key);
        if(!cached||Date.now()-cached.at>=60000){
          const pending=estimateTokenValue(input,{usdc:registry.legacy.USDC as `0x${string}`,weth:registry.legacy.WETH as `0x${string}`},async(token,amount)=>{
            const url=new URL(registry.sweep.quoteEndpoint);
            for(const [name,value] of Object.entries({chainId:'8453',sellToken:token,sellAmount:amount.toString(),buyToken:registry.legacy.USDC,taker:registry.sweep.swapper,recipient:registry.sweep.swapper,slippageBps:'100'}))url.searchParams.set(name,value);
            return bounded(async()=>{const r=await fetch(url,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Quote unavailable');return r.json();});
          });
          cached={at:Date.now(),pending};valueCache.set(key,cached);if(valueCache.size>1024)valueCache.delete(valueCache.keys().next().value!);
        }
        // Display-only numbers: never relay transaction calldata or approvals.
        return respond(200,await cached.pending);
      }
      if(path==='/api/sweep/quote'){
        if(req.method!=='GET')return respond(405,{error:'GET only.'});
        const input=new URL(req.url!,'http://'+host).searchParams,sellToken=input.get('sellToken')??'',sellAmount=input.get('sellAmount')??'',slippage=Number(input.get('slippageBps')),buyToken=input.get('buyToken')??registry.legacy.USDC;
        if(!isAddress(sellToken)||BigInt(sellToken)===0n||!isAddress(buyToken)||![registry.legacy.USDC,registry.aero.token].some(a=>a.toLowerCase()===buyToken.toLowerCase())||[registry.legacy.iAERO,registry.legacy.stiAERO,buyToken].some(a=>a.toLowerCase()===sellToken.toLowerCase())||!/^\d{1,78}$/.test(sellAmount)||BigInt(sellAmount)<=0n||BigInt(sellAmount)>=2n**256n||!Number.isInteger(slippage)||slippage<10||slippage>1000)return respond(400,{error:'Invalid token, amount or slippage.'});
        const boot=await publicBootstrap();if(!boot.sweepReady)return respond(503,{error:'The deployed reward swapper is not verified.'});
        if(buyToken.toLowerCase()===registry.aero.token.toLowerCase()&&!boot.aeroCompoundReady)return respond(503,{error:'The new AERO output and compound route are not verified.'});
        // Existing public app proxy retains its own 0x credential. The local
        // browser never receives it, and cannot choose an arbitrary upstream.
        const upstream=new URL(registry.sweep.quoteEndpoint);
        for(const [key,value] of Object.entries({chainId:'8453',sellToken,sellAmount,buyToken,taker:registry.sweep.swapper,recipient:registry.sweep.swapper,slippageBps:String(slippage)}))upstream.searchParams.set(key,value);
        const quote=await bounded(async()=>{const r=await fetch(upstream,{signal:AbortSignal.timeout(25000)});const data=await r.json().catch(()=>null);checkQuoteServiceResponse(r.status,data);return data;});
        if(quote.liquidityAvailable===false||!quote.transaction?.data||!isAddress(quote.transaction.to)||String(quote.sellAmount)!==sellAmount||!/^\d+$/.test(String(quote.buyAmount))||BigInt(quote.buyAmount)<=0n||BigInt(quote.transaction.value??'0')!==0n)return respond(422,{code:'INVALID_EXECUTABLE_QUOTE',error:'The service did not return a valid executable quote.'});
        if(quote.sellToken&&String(quote.sellToken).toLowerCase()!==sellToken.toLowerCase()||quote.buyToken&&String(quote.buyToken).toLowerCase()!==buyToken.toLowerCase())return respond(422,{code:'INVALID_EXECUTABLE_QUOTE',error:'Quote tokens do not match the requested swap.'});
        return respond(200,{sellToken,sellAmount,buyToken,buyAmount:String(quote.buyAmount),minBuyAmount:String(quote.minBuyAmount??'0'),taker:registry.sweep.swapper,recipient:registry.sweep.swapper,transaction:{to:quote.transaction.to,data:quote.transaction.data,value:'0'},quotedAt:Date.now()});
      }
      if(path==='/api/contracts'){
        if(req.method!=='GET')return respond(405,{error:'GET only.'});
        return respond(200,await publicBootstrap());
      }
      if(req.method!=='POST')return respond(405,{error:'POST only.'});
      let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw Error('Request too large.');}
      const parsed=JSON.parse(body),canonical=canonicalReadRequest(parsed);
      await publicBootstrap();
      const [url]=await rpcSettings();
      const result=await bounded(async()=>{
        const response=await readRpcFetch(url,{method:'POST',headers:{'content-type':'application/json'},body:canonical,signal:AbortSignal.timeout(25000)});
        if(!response.ok)throw Error('Base connection unavailable.');return scrub(await response.json());
      });
      respond(200,result);
    }catch(error){
      if(error instanceof SweepQuoteError)return respond(error.status,{code:error.code,error:error.message});
      // Never return raw provider exceptions, endpoints, credential fragments or upstream text.
      if(path==='/api/base')respond(200,{jsonrpc:'2.0',id:null,error:{code:-32000,message:'Base read connection unavailable. Refresh and retry.'}});
      else if(path==='/api/sweep/quote')respond(503,{code:'QUOTE_SERVICE_UNAVAILABLE',error:'The 0x quote connection is temporarily unavailable. Retry later.'});
      else if(path==='/api/rewards/value')respond(503,{error:'Reward value is unavailable. Claims are unaffected.'});
      else respond(503,{error:'Verified Base read connection unavailable. New actions remain disabled.'});
    }
  };
}
