// Cloudflare Pages advanced mode: frontend APIs use read-only bindings. The
// scheduled recorder is deployed separately, against the same persistent D1.
import history from './index.ts';
import type {YieldDB} from './d1-store.ts';
import {createAppReadApi,appJson,readApiPaths,type AppReadEnv} from './app-api.ts';
import {GET as holdings} from '../server/rift-holdings.ts';
import {rateKey,touch} from '../src/restored/lib/rift/rate-limit.ts';

export type PagesEnv=AppReadEnv&{ASSETS:{fetch:(request:Request)=>Promise<Response>};YIELD_DB:YieldDB;COLLECTOR_ENABLED?:string;APP_ALLOWED_ORIGINS?:string;LEGACY_API_ORIGIN?:string};
const historyPaths=new Set(['/api/protocol-yield','/api/protocol-yield/history','/api/protocol-yield/health','/api/legacy-history']);
const preservedPaths:Record<string,string>={'/api/0x/quote':'GET','/api/stats':'GET','/api/prices/token':'GET','/api/spam-report':'POST'};
export function configuredAppOrigins(raw:string){
 try{const values=JSON.parse(raw);if(!Array.isArray(values)||!values.length||values.length>16)throw Error();return new Set(values.map(v=>{const u=new URL(v),h=u.hostname.toLowerCase().replace(/\.$/,'');if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||h==='localhost'||h.endsWith('.localhost')||/^(127|0|10)\./.test(h)||/^192\.168\./.test(h)||/^169\.254\./.test(h)||/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)||h.startsWith('['))throw Error();return u.origin;}));}catch{throw Error('Public application origins are not configured.');}
}
// Cloudflare supplies cf-connecting-ip at its ingress. X-Forwarded-For and
// client-supplied copies on a plain/local Request never establish identity.
export function pagesCaller(request:Request){
 const ip=(request as Request&{cf?:unknown}).cf?request.headers.get('cf-connecting-ip'):null;
 if(!ip||ip.length>64||!/^([\da-f:]+|(?:\d{1,3}\.){3}\d{1,3})$/i.test(ip))return 'unknown';
 return rateKey(ip);
}
export function createPagesHandler(options:{readApi?:ReturnType<typeof createAppReadApi>;holdings?:typeof holdings;history?:typeof history.fetch;legacyFetch?:typeof fetch}={}){
 const limits=new Map<string,{until:number;count:number}>(),services=new WeakMap<object,ReturnType<typeof createAppReadApi>>();
 return async(request:Request,env:PagesEnv)=>{
  const url=new URL(request.url);if(!url.pathname.startsWith('/api/')){
   if(url.pathname.endsWith('.map')||url.pathname.includes('/.'))return new Response('Not found',{status:404});
   return env.ASSETS.fetch(request);
  }
  try{
   const origins=configuredAppOrigins(env.APP_ALLOWED_ORIGINS??'');if(!origins.has(url.origin)||request.headers.has('origin')&&request.headers.get('origin')!==url.origin)return appJson({error:'Same-origin application requests only.'},403);
   const caller=pagesCaller(request),now=Date.now(),prior=limits.get(caller),bucket=!prior||prior.until<=now?{until:now+60000,count:0}:prior;bucket.count=Math.min(bucket.count+1,1201);touch(limits,caller,bucket,5000);if(bucket.count>1200)return appJson({error:'Read limit reached. Retry shortly.'},429,{'retry-after':'60'});
   let reply:Response;
   if(historyPaths.has(url.pathname))reply=await (options.history??history.fetch)(request,env);
   else if(url.pathname==='/api/rift/holdings'){
    if(request.method!=='GET')return appJson({error:'GET only.'},405);
    const read=Object.assign(new Request(request.url,{headers:{'x-forwarded-for':caller}}),{nextUrl:url});reply=await (options.holdings??holdings)(read);
   }else if(preservedPaths[url.pathname]){
    if(request.method!==preservedPaths[url.pathname]&&!(request.method==='HEAD'&&preservedPaths[url.pathname]==='GET'))return appJson({error:'Method not supported.'},405);
    // Keep pre-existing integrations on their exact, retained Pages deployment;
    // never call the mutable application hostname and accidentally recurse.
    if(!env.LEGACY_API_ORIGIN||!/^https:\/\/[a-z0-9]{8,32}\.iaero-frontend\.pages\.dev$/.test(env.LEGACY_API_ORIGIN))return appJson({error:'The previous API connection is unavailable.'},503);
    let body:string|undefined;
    if(request.method==='POST'){
     if(!request.headers.get('content-type')?.startsWith('application/json'))return appJson({error:'JSON body required.'},415);
     const reader=request.body?.getReader();if(!reader)return appJson({error:'Missing body.'},400);let bytes=0;body='';const decoder=new TextDecoder();
     try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>100000){await reader.cancel();return appJson({error:'Request too large.'},413);}body+=decoder.decode(chunk.value,{stream:true});}body+=decoder.decode();}finally{reader.releaseLock();}
    }
    // Workers supports manual redirects, but rejects Node's redirect:"error".
    // Never follow a redirect away from the retained, fixed deployment.
    const upstream=await (options.legacyFetch??fetch)(new URL(url.pathname+url.search,env.LEGACY_API_ORIGIN),{method:request.method==='HEAD'?'GET':request.method,headers:{accept:'application/json',...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body}:{}),signal:AbortSignal.timeout(25000),redirect:'manual'});
    if(upstream.status>=300&&upstream.status<400){await upstream.body?.cancel();return appJson({error:'The previous API is temporarily unavailable.'},503);}
    if(!upstream.headers.get('content-type')?.includes('application/json'))return appJson({error:'The previous API is temporarily unavailable.'},503);
    reply=new Response(upstream.body,{status:upstream.status,headers:{'content-type':'application/json','cache-control':upstream.headers.get('cache-control')??'no-store'}});
   }else if(readApiPaths.has(url.pathname)){
    let service=options.readApi??services.get(env);if(!service){service=createAppReadApi(env);services.set(env,service);}reply=await service(request);
   }else return appJson({error:'Not found.'},404);
   const headers=new Headers(reply.headers);headers.set('x-content-type-options','nosniff');headers.set('x-frame-options','DENY');headers.set('referrer-policy','strict-origin-when-cross-origin');
   return new Response(request.method==='HEAD'?null:reply.body,{status:reply.status,headers});
  }catch{return appJson({error:'Application read services are temporarily unavailable. Retry later.'},503);}
 };
}
export default {fetch:createPagesHandler()};
