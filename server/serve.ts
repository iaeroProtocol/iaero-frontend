// Staged same-origin production adapter. Starting it does not publish anything.
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {baseApiMiddleware} from './base-rpc.ts';
import {assertClientDeployment,configuredBaseReads,publicOrigin,clientAddressResolver} from './access-policy.ts';
const origin=publicOrigin(process.env.IAERO_PUBLIC_ORIGIN??''),historyOrigin=publicOrigin(process.env.SHARED_HISTORY_ORIGIN??'');
if(historyOrigin===origin)throw Error('The shared-history origin must be a separate service.');
configuredBaseReads(process.env.BASE_READ_RPC_URLS??'');
const root=resolve('dist');assertClientDeployment(JSON.parse(await readFile(resolve(root,'frontend-config.json'),'utf8')));
const clientAddress=clientAddressResolver(process.env.IAERO_TRUSTED_PROXY_IPS??'[]');
const api=baseApiMiddleware({publicOrigin:origin,collect:false,clientAddress}),mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.ico':'image/x-icon'};
const historyPaths=new Set(['/api/protocol-yield','/api/protocol-yield/history','/api/protocol-yield/health','/api/legacy-history']),limits=new Map<string,{until:number;count:number}>();
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url??'/','http://internal');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
 if(url.pathname.startsWith('/api/')){
  const host=req.headers.host??'';if(host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin){res.writeHead(403).end();return;}
  const key=clientAddress(req),now=Date.now(),bucket=limits.get(key);if(!bucket||bucket.until<now){for(const [key,value] of limits)if(value.until<now)limits.delete(key);limits.set(key,{until:now+60000,count:1});}else if(++bucket.count>1200){res.writeHead(429,{'Retry-After':'60'}).end();return;}
  if(historyPaths.has(url.pathname)){if(req.method!=='GET'){res.writeHead(405).end();return;}const reply=await fetch(new URL(url.pathname+url.search,historyOrigin),{signal:AbortSignal.timeout(20000),redirect:'error'});res.writeHead(reply.status,{'Content-Type':'application/json','Cache-Control':reply.headers.get('cache-control')??'no-store'});res.end(await reply.text());return;}
  await api(req,res,()=>{res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"Not found"}');});return;
 }
 if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405).end();return;}
 let path=resolve(root,'.'+decodeURIComponent(url.pathname));if(path!==root&&!path.startsWith(root+'/')||path.endsWith('.map')){res.writeHead(404).end();return;}
 try{if(!(await stat(path)).isFile())path=resolve(root,'index.html');}catch{if(extname(path)){res.writeHead(404).end();return;}path=resolve(root,'index.html');}
 const body=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]??'application/octet-stream','Cache-Control':path.includes('/assets/')?'public, max-age=31536000, immutable':'no-cache'});res.end(req.method==='HEAD'?undefined:body);
 }catch{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"Service temporarily unavailable. Retry later."}');}});
server.requestTimeout=30000;server.headersTimeout=15000;const port=Number(process.env.PORT??4320);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid service port.');
server.listen(port,process.env.IAERO_LISTEN_HOST??'127.0.0.1',()=>console.log('Staged frontend adapter listening; no publication performed.'));
