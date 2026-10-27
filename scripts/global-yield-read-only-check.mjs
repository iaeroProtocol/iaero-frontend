import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4317',shared='http://127.0.0.1:4319';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const a=await fetch(shared+'/api/protocol-yield'),report=await a.json();assert.equal(a.status,200);assert.ok(report.asOfTimestamp,'Requires a newly collected report from the final Worker');assert.ok(Date.now()-report.readAtMs<900000);assert.equal(report.sharedHistory,true);
assert.deepEqual(report.chains.map(c=>c.chainId).sort((a,b)=>a-b),[1,4663,8453]);assert.ok(report.chains.every(c=>c.historyComplete));assert.equal(report.summary.earnedApy7d,null);assert.equal(report.summary.receivedApy7d,null);
const second=await (await fetch(shared+'/api/protocol-yield',{headers:{cookie:'independent-browser-profile'}})).json();assert.equal(second.readAtMs,report.readAtMs);assert.deepEqual(second.chainTotals,report.chainTotals);
const health=await fetch(shared+'/api/protocol-yield/health');assert.equal(health.status,200);
const census=await (await fetch(shared+'/api/legacy-history')).json();assert.equal(census.complete,true);assert.ok(census.targets.staking.pairs.length>=2028);
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}),layouts=[],errors=[],external=[];
await mkdir('artifacts/all-features',{recursive:true});
try{
 for(const width of [1440,390,320]){
  const context=await browser.newContext({viewport:{width,height:950},isMobile:width<500,hasTouch:width<500,reducedMotion:'reduce'}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(u.hostname)&&!['data:','blob:'].includes(u.protocol)){external.push(u.hostname);return route.abort();}return route.continue();});
  await page.goto(origin);const card=page.getByRole('article',{name:'Protocol yield and claim history',exact:true});await card.locator('.yield-chain-totals').waitFor();await page.evaluate(()=>document.fonts.ready);
  assert.equal(await card.locator('.yield-chain-totals>div').count(),3);const text=await card.innerText();for(const name of ['Base','Ethereum','Robinhood Chain'])assert.ok(text.includes(name));assert.ok(text.includes('shared finalized cutoff'));
  const layout=await card.evaluate(e=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth||e.scrollWidth>e.clientWidth+1,chainValues:[...e.querySelectorAll('.yield-chain-totals>div')].map(c=>c.textContent)}));assert.equal(layout.overflow,false);layouts.push(layout);await card.screenshot({path:`artifacts/all-features/live-yield-${width}.png`});await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 const evidence={status:'PASS',at:new Date().toISOString(),scope:'Actual shared local Worker/D1 API and live multi-chain reads. No wallet connection/signature/transaction.',asOfTimestamp:report.asOfTimestamp,readAtMs:report.readAtMs,chains:report.chains,chainTotals:report.chainTotals,storedClaims:report.storedClaims,storedObservations:report.storedObservations,independentVisitorsAgree:true,healthStatus:health.status,legacyCensusComplete:census.complete,layouts,errors,external,productionAcceptance:false};await writeFile('artifacts/all-features/SHARED_WORKER_FINAL.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({status:'PASS',chains:report.chainTotals.length,observations:report.storedObservations,widths:layouts.map(l=>l.width),realTransactions:0}));
}finally{await browser.close();}
