import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {liveFixture} from './live-fixture.mjs';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4330',out='artifacts/wallet-loading-20261027/yield-recovery';assert.equal(new URL(origin).hostname,'127.0.0.1');await mkdir(out,{recursive:true});
const f=await liveFixture(),{page}=f,checks=[];let attempts=0,fail=false,hold=false,release;const held=new Promise(r=>release=r);await page.clock.install({time:new Date()});
await page.route('**/api/protocol-yield',async route=>{attempts++;if(attempts===1||fail)return route.fulfill({status:503,json:{error:'Temporary read failure'}});if(hold)await held;return route.fallback();});
try{
 const began=Date.now();await page.goto(origin);const card=page.getByRole('article',{name:'Protocol yield and claim history',exact:true});await card.getByText('123.45',{exact:false}).waitFor({timeout:7000});assert(Date.now()-began<7000);assert.equal(attempts,2);checks.push('initial transient error recovers within seconds rather than waiting thirty seconds');
 await f.go('Portfolio');await page.getByRole('heading',{name:'Your portfolio.',exact:true}).waitFor();hold=true;await f.go('Overview');await card.getByText('123.45',{exact:false}).waitFor({timeout:1500});checks.push('page navigation immediately reuses the last validated protocol observation while fetching');release();await page.waitForTimeout(100);
 fail=true;await card.getByRole('button',{name:'Refresh protocol yield',exact:true}).click();await card.getByText('Refresh delayed. Showing the last recorded observation while retrying.',{exact:true}).waitFor();assert.deepEqual(await card.locator('.yield-metrics strong').allTextContents(),['123.45 USDC','0.00 USDC']);checks.push('a transient refresh error keeps fresh numbers with an explicit retry notice');
 await page.clock.fastForward(901000);await card.getByText('This read is unavailable or expired; saved receipts are preserved.',{exact:true}).waitFor();assert.deepEqual(await card.locator('.yield-metrics strong').allTextContents(),['— USDC','— USDC']);checks.push('cached display stops at the original report deadline and never extends its freshness');
 assert.equal(f.writes.length,0);assert.deepEqual(f.errors,[]);await writeFile(out+'/RESULT.json',JSON.stringify({status:'PASS',checks,transactions:0,signatures:0,scope:'Compiled client with mocked transient failures and browser time'},null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks:checks.length}));
}finally{release();await f.browser.close();}
