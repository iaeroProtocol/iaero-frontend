import {afterEach,expect,it,vi} from 'vitest';
import {getAddress,type Address} from 'viem';
import registry from '../config/base.registry.json';
import {readAccount,type BaseClient} from '../src/live/client';
import {scanSweepWallet} from '../src/live/sweep';
import {readFundedHistory} from '../src/live/legacy-history';
import type {Bootstrap} from '../src/live/types';
const user='0x1111111111111111111111111111111111111111' as Address,epoch=1792627200n;
function fixture(offset:number){
 const tokens=Array.from({length:40},(_,i)=>('0x'+(offset+i).toString(16).padStart(40,'0')) as Address),boot={registry,rewardTokenAddresses:tokens,sweepReady:true,tokenFilter:{chainId:8453,addresses:[],symbolPatterns:[]}} as unknown as Bootstrap;
 let active=0,peak=0;
 const client={getChainId:async()=>8453,getBlock:async()=>({number:123n,timestamp:epoch+1n}),getBalance:async()=>0n,multicall:async({contracts}:any)=>contracts.map(()=>({status:'success',result:1n})),readContract:async(r:any)=>{
  if(['symbol','decimals'].includes(r.functionName)){active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,1));return r.functionName==='symbol'?'TOKEN\u202e':'18';}finally{active--;}}
  if(r.functionName==='currentEpoch')return epoch;if(r.functionName==='paused')return false;if(r.functionName==='previewUSDCMany')return [[],0n];if(r.functionName==='previewClaimsForEpoch')return r.args[1].map(()=>1n);return 1n;
 }} as unknown as BaseClient;return {client,boot,tokens,peak:()=>peak};
}
afterEach(()=>vi.unstubAllGlobals());
it('bounds metadata requests for a wallet with many positive rewards without dropping any',async()=>{const f=fixture(3000),out=await readAccount(f.client,f.boot,user);expect(f.peak()).toBeLessThanOrEqual(8);expect(out.rewards.filter(r=>f.tokens.includes(r.token))).toHaveLength(160);expect(out.rewards.every(r=>!r.symbol.includes('\u202e'))).toBe(true);expect(out.known.legacyStake).toBe(true);});
it('bounds metadata fan-out while scanning many wallet tokens',async()=>{const f=fixture(4000),out=await scanSweepWallet(f.client,f.boot,user);expect(f.peak()).toBeLessThanOrEqual(8);expect(out.tokens.filter(r=>f.tokens.some(t=>t.toLowerCase()===r.token.toLowerCase()))).toHaveLength(40);expect(out.tokens.every(r=>r.token===getAddress(r.token))).toBe(true);});
it('bounds full-history metadata reads and removes control characters',async()=>{const f=fixture(5000);vi.stubGlobal('fetch',vi.fn(async()=>Response.json({version:1,chainId:8453,providers:2,head:'123',readAtMs:Date.now(),complete:true,targets:{staking:{block:'123',pairs:f.tokens.map(token=>({token,epoch:String(epoch)}))},autoVault:{block:'123',epochs:[]}}})));const out=await readFundedHistory(f.client,f.boot,user);expect(f.peak()).toBeLessThanOrEqual(4);expect(out.rewards).toHaveLength(40);expect(out.rewards.every(r=>!r.symbol.includes('\u202e'))).toBe(true);expect(out.legacyDiscovery.complete).toBe(true);});
