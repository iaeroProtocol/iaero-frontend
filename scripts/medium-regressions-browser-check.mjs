import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {liveFixture} from './live-fixture.mjs';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4317',out=process.env.MEDIUM_FIX_OUTPUT_DIR??'artifacts/medium-fixes';assert.equal(new URL(origin).hostname,'127.0.0.1');await mkdir(out,{recursive:true});const checks=[];
for(const scenario of ['slow-scan','account-change','chain-change']){
 const f=await liveFixture(),{page}=f;let release;const gate=new Promise(r=>release=r);let announce;const requested=new Promise(r=>announce=r);let bootstrapReads=0;
 page.on('request',r=>{if(new URL(r.url()).pathname==='/api/contracts')bootstrapReads++;});
 try{
  await page.goto(origin);await f.connect();await f.openLegacy();await page.route('**/api/legacy-history',async route=>{announce();await gate;await route.fallback();});
  await page.getByRole('button',{name:'Find all funded reward weeks',exact:true}).click();await requested;
  if(scenario==='slow-scan'){
   const before=bootstrapReads;await page.waitForTimeout(32000);assert.equal(bootstrapReads,before,'automatic polling must not supersede a manual scan');assert.equal(await page.getByRole('button',{name:'Checking funded weeks…',exact:true}).isDisabled(),true);release();await page.getByText('Full funding history scanned to finalized block',{exact:false}).waitFor();checks.push({name:'a full-history response delayed past the real 30-second polling interval still commits',automaticRefreshesDuringScan:bootstrapReads-before});
  }else{
   if(scenario==='account-change'){await page.evaluate(other=>window.testWallet.changeAccount(other),f.other);await page.getByRole('button',{name:'0x2222…2222',exact:true}).waitFor();}
   else{await page.evaluate(()=>window.testWallet.changeChain('0x1'));await page.getByText('Switch to Base',{exact:true}).first().waitFor();}
   await page.getByRole('button',{name:'Find all funded reward weeks',exact:true}).waitFor();release();await page.waitForTimeout(1000);assert.equal(await page.getByText('Full funding history scanned to finalized block',{exact:false}).count(),0);assert.ok((await page.getByRole('dialog').innerText()).includes('up to 26 weeks'));checks.push({name:scenario+' cancels stale full-history scope and ignores its late response'});
  }
  assert.equal(f.writes.length,0);assert.deepEqual(f.errors,[]);assert.deepEqual(f.external,[]);
 }catch(error){await page.screenshot({path:out+'/'+scenario+'-FAILURE.png',fullPage:true});await writeFile(out+'/FAILURE.json',JSON.stringify({scenario,error:error.stack,checks},null,2)+'\n');throw error;}finally{release?.();await f.browser.close();}
}
await writeFile(out+'/RESULT.json',JSON.stringify({status:'PASS',scope:'Compiled app, mocked wallet/read transports; real 32-second polling interval; no signatures or real transactions',checks},null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks:checks.length,realTransactions:0}));
