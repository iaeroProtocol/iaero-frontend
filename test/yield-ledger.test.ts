import {describe,it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addClaim,addSnapshot,annualisedWeeklyApy,blankLedger,loadLedger,summariseYield,updateLedger,WEEK,type YieldClaim,type YieldSnapshot} from '../server/yield-ledger';
import {verifyYieldReceipt} from '../server/protocol-yield';
const h=('0x'+'11'.repeat(32)) as `0x${string}`,token='0x'+'22'.repeat(20),position='8453:asset:1584',now=2000000;
const claim=(patch:Partial<YieldClaim>={}):YieldClaim=>({id:'8453:'+h+':1',chainId:8453,block:'123',blockHash:h,timestamp:now-5,transactionHash:h,logIndex:1,manager:token,recipient:token,token,amount:'1000000',decimals:6,symbol:'USDC',kind:'fees',programId:null,valueUsdcWad:'1000000000000000000',valuation:'exact-usdc',providers:2,...patch});
const snapshot=(patch:Partial<YieldSnapshot>={}):YieldSnapshot=>({id:'now',timestamp:now,recordedAt:now*1000,backingAero:'1000000000000000000000',tvlUsdcWad:'1000000000000000000000',assets:[],pendingComplete:true,chains:[8453],errors:[],...patch});
const state=()=>{const s=blankLedger(position);s.cursors[8453]={block:'123',hash:h,timestamp:now,fromBlock:'0',providers:2,complete:true,gauges:[]};addSnapshot(s,snapshot({id:'baseline',timestamp:now-WEEK}));addSnapshot(s,snapshot());return s;};
describe('durable receipt history',()=>{
 it('persists exact large amounts across close/reopen and deduplicates receipt replays',async()=>{
  const path=join(await mkdtemp(join(tmpdir(),'iaero-yield-')),'yield.sqlite'),c=claim({amount:(2n**200n).toString()});
  await updateLedger(path,position,async s=>{addClaim(s,c);});await updateLedger(path,position,async s=>{addClaim(s,c);});
  expect((await loadLedger(path,position)).claims).toEqual([c]);
 });
 it('migrates the first local storage format without changing its receipts or observations',async()=>{
  const path=join(await mkdtemp(join(tmpdir(),'iaero-yield-')),'yield.sqlite'),original=state();addClaim(original,claim());const db=new DatabaseSync(path);
  db.exec('CREATE TABLE ledger(position TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL) STRICT');db.prepare('INSERT INTO ledger VALUES(?,?,?)').run(position,7,JSON.stringify(original));db.close();
  expect(await loadLedger(path,position)).toEqual(original);await updateLedger(path,position,async s=>{addSnapshot(s,snapshot({id:'later',timestamp:now+1}));});
  expect((await loadLedger(path,position)).snapshots).toHaveLength(3);const check=new DatabaseSync(path);expect(JSON.parse(String(check.prepare('SELECT data FROM ledger').get()!.data))).toEqual(original);check.close();
 });
 it('rejects conflicting receipts and retains the saved facts',async()=>{
  const path=join(await mkdtemp(join(tmpdir(),'iaero-yield-')),'yield.sqlite');await updateLedger(path,position,async s=>{addClaim(s,claim());});
  await expect(updateLedger(path,position,async s=>{addClaim(s,claim({amount:'2'}));})).rejects.toThrow('conflict');expect((await loadLedger(path,position)).claims[0].amount).toBe('1000000');
 });
 it('does not commit part of a failed update',async()=>{
  const path=join(await mkdtemp(join(tmpdir(),'iaero-yield-')),'yield.sqlite');await updateLedger(path,position,async s=>{addClaim(s,claim());});
  await expect(updateLedger(path,position,async s=>{addClaim(s,claim({id:'second'}));throw Error('interrupted');})).rejects.toThrow('interrupted');expect((await loadLedger(path,position)).claims).toHaveLength(1);
 });
 it('rejects deleting or editing earlier receipts and observations',async()=>{
  const path=join(await mkdtemp(join(tmpdir(),'iaero-yield-')),'yield.sqlite');await updateLedger(path,position,async s=>{addClaim(s,claim());addSnapshot(s,snapshot());});
  await expect(updateLedger(path,position,async s=>{s.claims=[];})).rejects.toThrow('history_changed');await expect(updateLedger(path,position,async s=>{s.snapshots[0].backingAero='1';})).rejects.toThrow('history_changed');
 });
 it('refuses corrupted storage rather than silently starting an empty history',async()=>{
  const path=join(await mkdtemp(join(tmpdir(),'iaero-yield-')),'yield.sqlite');await writeFile(path,'damaged database');await expect(loadLedger(path,position)).rejects.toThrow();expect(await readFile(path,'utf8')).toBe('damaged database');
 });
 it('detects concurrent writers without losing the winner’s records',async()=>{
  const path=join(await mkdtemp(join(tmpdir(),'iaero-yield-')),'yield.sqlite');let release!:()=>void,entered!:()=>void;
  const began=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
  const first=updateLedger(path,position,async s=>{entered();await hold;addClaim(s,claim());});await began;
  await updateLedger(path,position,async s=>{addClaim(s,claim({id:'winner'}));});release();await expect(first).rejects.toThrow('concurrent_update');expect((await loadLedger(path,position)).claims[0].id).toBe('winner');
 });
});
describe('weekly compounding and truthful income',()=>{
 it('compounds a 1% seven-day return using 365/7, rather than simple APR',()=>{expect(annualisedWeeklyApy(10n,1000n)).toBeCloseTo((1.01**(365/7)-1)*100,10);expect(annualisedWeeklyApy(1n,0n)).toBeNull();});
 it('does not count pending rewards as received',()=>{const s=state();s.snapshots[1].assets=[{chainId:8453,token,amount:'1000000',decimals:6,symbol:'USDC',valueUsdcWad:'1000000000000000000'}];const out=summariseYield(s,now,[8453]);expect(out.receivedValueUsdcWad).toBe('0');expect(out.receivedApy7d).toBe(0);expect(out.earnedApy7d).toBeGreaterThan(0);});
 it('keeps receipt-based APY available independently of a pending-reward outage',()=>{const s=state();s.snapshots[1].pendingComplete=false;const out=summariseYield(s,now,[8453]);expect(out.receivedApy7d).toBe(0);expect(out.earnedApy7d).toBeNull();});
 it('retains a zero received rate when the complete week has no claims',()=>{const out=summariseYield(state(),now,[8453]);expect(out.receivedApy7d).toBe(0);});
 it('shows unknown, rather than zero, for incomplete scanning and short history',()=>{const s=state();s.cursors[8453].complete=false;expect(summariseYield(s,now,[8453]).receivedValueUsdcWad).toBeNull();s.cursors[8453].complete=true;s.snapshots.shift();expect(summariseYield(s,now,[8453]).receivedApy7d).toBeNull();});
 it('keeps old received valuations frozen when pending-token prices change',()=>{const s=state();addClaim(s,claim());const first=summariseYield(s,now,[8453]);s.snapshots[1].assets=[{chainId:8453,token,amount:'1000000',decimals:6,symbol:'USDC',valueUsdcWad:'9000000000000000000'}];expect(summariseYield(s,now,[8453]).receivedValueUsdcWad).toBe(first.receivedValueUsdcWad);});
 it('counts token growth, rather than rising pending-token prices, as earned yield',()=>{const s=state();s.snapshots[0].assets=[{chainId:8453,token,amount:'1000000',decimals:6,symbol:'USDC',valueUsdcWad:'1000000000000000000'}];s.snapshots[1].assets=[{...s.snapshots[0].assets[0],valueUsdcWad:'2000000000000000000'}];expect(summariseYield(s,now,[8453]).earnedApy7d).toBe(0);});
 it('treats an ETH payout and the corresponding pending WETH as the same economic units, retaining raw receipt identities',()=>{const s=state(),native='0x'+'00'.repeat(20);s.snapshots[0].assets=[{chainId:8453,token,amount:'1000000',decimals:18,symbol:'WETH',valueUsdcWad:'1000000'}];s.snapshots[1].assets=[];addClaim(s,claim({token:native,symbol:'ETH',amount:'1000000',decimals:18,valueUsdcWad:'1000000'}));const out=summariseYield(s,now,[8453],{['8453:'+native]:'8453:'+token});expect(out.earnedApy7d).toBe(0);expect(s.claims[0].token).toBe(native);});
 it('prevents an APY when a received token is unpriced, a chain is single-provider or backing changed',()=>{const s=state();addClaim(s,claim({valueUsdcWad:null,valuation:'unpriced'}));expect(summariseYield(s,now,[8453]).receivedApy7d).toBeNull();s.claims=[];s.cursors[8453].providers=1;expect(summariseYield(s,now,[8453]).receivedApy7d).toBeNull();s.cursors[8453].providers=2;s.snapshots[1].backingAero='1';expect(summariseYield(s,now,[8453]).receivedApy7d).toBeNull();});
 it('requires the exact rolling-week boundary rather than silently using a nearby observation',()=>{const s=state();s.snapshots[0].timestamp-=1;expect(summariseYield(s,now,[8453]).receivedApy7d).toBeNull();});
 it('excludes claims outside the rolling week and does not duplicate replayed claims',()=>{const s=state();addClaim(s,claim({id:'old',timestamp:now-WEEK}));addClaim(s,claim());addClaim(s,claim());expect(summariseYield(s,now,[8453]).receivedCount7d).toBe(1);});
});
describe('receipt provenance',()=>{
 const receipt={transactionHash:h,blockNumber:123n,blockHash:h,status:'success',logs:[]};const ctx=(values:any[])=>({clients:values.map(value=>({getTransactionReceipt:async()=>value})),header:async()=>({hash:h,timestamp:now})}) as any;
 it('requires matching providers and a canonical successful receipt',async()=>{await expect(verifyYieldReceipt(ctx([receipt,receipt]),h,123n)).resolves.toHaveProperty('timestamp',now);await expect(verifyYieldReceipt(ctx([receipt,{...receipt,status:'reverted'}]),h,123n)).rejects.toThrow('disagreement');await expect(verifyYieldReceipt(ctx([{...receipt,status:'reverted'}]),h,123n)).rejects.toThrow('canonical');await expect(verifyYieldReceipt(ctx([{...receipt,transactionHash:'0x'+'33'.repeat(32)}]),h,123n)).rejects.toThrow('canonical');});
});
