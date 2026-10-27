import {isIP} from 'node:net';
import type {IncomingMessage} from 'node:http';

function canonicalClientIp(value:unknown):string|undefined{
 if(typeof value!=='string'||value.length>64)return;
 const ip=value.trim();if(isIP(ip)===4)return ip;if(isIP(ip)!==6)return;
 try{const normalized=new URL('http://['+ip+']/').hostname.slice(1,-1).toLowerCase(),mapped=normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if(mapped){const a=parseInt(mapped[1],16),b=parseInt(mapped[2],16);return [a>>>8,a&255,b>>>8,b&255].join('.');}
  return normalized;
 }catch{return;}
}

// Direct socket identity is authoritative unless this exact peer was explicitly
// configured as a trusted proxy. Trusted ingress must append the real peer to
// X-Forwarded-For; peel from the right and stop at the first untrusted hop.
// In particular, never accept an arbitrary caller's cf-connecting-ip header.
export function clientAddressResolver(raw='[]'){
 let trusted:Set<string>;
 try{const values=JSON.parse(raw);if(!Array.isArray(values)||values.length>256)throw Error();const peers=values.map(canonicalClientIp);if(peers.some(ip=>!ip))throw Error();trusted=new Set(peers as string[]);}catch{throw Error('Trusted proxy peers must be a JSON array of valid IP addresses.');}
 return (request:Pick<IncomingMessage,'headers'|'socket'>)=>{
  let client=canonicalClientIp(request.socket?.remoteAddress);if(!client)throw Error('Client network identity is unavailable.');
  if(!trusted.has(client))return client;
  const forwarded=request.headers['x-forwarded-for'];if(typeof forwarded!=='string'||forwarded.length>2048)throw Error('Trusted proxy client identity is unavailable.');
  const hops=forwarded.split(',');if(hops.length>32)throw Error('Trusted proxy client identity is unavailable.');
  for(let i=hops.length-1;i>=0&&trusted.has(client);i--){const next=canonicalClientIp(hops[i]);if(!next)throw Error('Trusted proxy client identity is unavailable.');client=next;}
  return client;
 };
}

export function publicOrigin(value:string){
 const u=new URL(value),host=u.hostname.toLowerCase().replace(/\.$/,'');if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||host==='localhost'||host.endsWith('.localhost')||/^(127|0|10)\./.test(host)||/^192\.168\./.test(host)||/^169\.254\./.test(host)||/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)||host.startsWith('['))throw Error('A public HTTPS origin is required.');return u.origin;
}
export function allowApiRequest(host:string,origin:string|undefined,configuredOrigin?:string){
 if(configuredOrigin){const configured=new URL(publicOrigin(configuredOrigin));return host===configured.host&&(!origin||origin===configured.origin);}
 return /^(127\.0\.0\.1|localhost):\d+$/.test(host)&&(!origin||origin==='http://'+host);
}
export function assertClientDeployment(config:{protocolDataOrigin?:string|null}){if(config.protocolDataOrigin)publicOrigin(config.protocolDataOrigin);}
export {configuredBaseReads} from './read-rpc-policy.ts';
