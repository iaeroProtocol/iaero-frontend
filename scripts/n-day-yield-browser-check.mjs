import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {liveFixture} from './live-fixture.mjs';
import {blankLedger,addSnapshot,summariseYield,WEEK} from '../src/protocol-data/yield-model.ts';
import {formatYieldPercent} from '../src/protocol-data/yield-display.ts';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4317';assert.equal(new URL(origin).hostname,'127.0.0.1');
const out='artifacts/n-day-browser';await mkdir(out,{recursive:true});const checks=[];
function annualised(days=3,independent=false){
 const s=blankLedger('browser'),end=1793100000,ids=[8453,1,4663],providers={8453:2,1:2,4663:independent?2:1},asset=(id,amount)=>({chainId:id,token:'0x'+'22'.repeat(20),symbol:'USDC',decimals:6,amount:String(amount*1000000),valueUsdcWad:String(BigInt(amount)*10n**18n)});
 for(const id of ids)s.cursors[id]={block:'1',hash:'0x'+'11'.repeat(32),timestamp:end,fromBlock:'0',providers:providers[id],complete:true,gauges:[]};
 for(const [id,timestamp,assets] of [['start',end-days*86400,[]],['end',end,[asset(8453,4),asset(1,2),asset(4663,1)]]])addSnapshot(s,{id,timestamp,recordedAt:Date.now(),backingAero:'1000',tvlUsdcWad:'1000000000000000000000',assets,pendingComplete:independent,observedComplete:true,observationProviders:providers,chains:ids,errors:[]});
 return summariseYield(s,end,ids,{},{startedAt:end-days*86400}).annualised;
}
for(const width of [1440,390,320]){
 const f=await liveFixture({viewport:{width,height:width<500?844:1000},isMobile:width<500,hasTouch:width<500}),{page,state}=f;page.setDefaultTimeout(15000);
 state.protocolAnnualised=annualised();state.protocolPendingValue='7000000000000000000';state.protocolChains=[{name:'Base',chainId:8453,providers:2,status:'verified',historyComplete:true},{name:'Ethereum',chainId:1,providers:2,status:'verified',historyComplete:true},{name:'Robinhood Chain',chainId:4663,providers:1,status:'single-provider',historyComplete:true}];
 try{
  await page.goto(origin);const card=page.getByRole('article',{name:'Protocol yield and claim history',exact:true});
  await card.getByText('Earned APY · 3d estimate',{exact:true}).waitFor();assert.equal(await card.locator('.yield-apy strong').first().innerText(),formatYieldPercent(state.protocolAnnualised.earnedApy));
  assert.equal(await card.locator('.yield-apy strong').nth(1).innerText(),'0.00%');await card.locator('.yield-window-qualification').getByText(/Robinhood Chain/).waitFor();checks.push({width,name:'all-chain earned APY displays before any claims, with actual N-day and coverage labels'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:out+'/'+width+'-overview.png',fullPage:true});
  await f.connect();const portfolio=page.getByRole('article',{name:'iAERO yield',exact:true});await portfolio.getByText('Earned APY · 3d estimate',{exact:true}).waitFor();assert.equal(await portfolio.locator('.portfolio-protocol-rates>div>strong').first().innerText(),formatYieldPercent(state.protocolAnnualised.earnedApy));assert.equal(await portfolio.locator('.iaero-funded-rate>strong').innerText(),'—');checks.push({width,name:'Portfolio matches Overview while undeployed funded staking stays separate'});await page.getByRole('region',{name:'Portfolio yield rates',exact:true}).screenshot({path:out+'/'+width+'-portfolio.png'});
  state.protocolAnnualised=annualised(7,false);await portfolio.getByRole('button',{name:'Refresh iAERO yield',exact:true}).click();await portfolio.getByText('Earned APY · rolling 7d',{exact:true}).waitFor();assert.ok((await portfolio.locator('.yield-window-qualification').innerText()).includes('Robinhood'));checks.push({width,name:'a full observed week switches its window label but retains single-provider qualification'});
  state.protocolAnnualised=annualised(7,true);state.protocolChains[2].providers=2;state.protocolChains[2].status='verified';await portfolio.getByRole('button',{name:'Refresh iAERO yield',exact:true}).click();await portfolio.locator('.yield-window-qualification').waitFor({state:'detached'});assert.equal(await portfolio.locator('.yield-window-qualification').count(),0);checks.push({width,name:'independent full-week data drops the provisional qualification'});
  state.protocolAnnualised={...annualised(),windowSeconds:1};await portfolio.getByRole('button',{name:'Refresh iAERO yield',exact:true}).click();await portfolio.getByText('Protocol yield data is unavailable or still loading.',{exact:true}).waitFor();assert.deepEqual(await portfolio.locator('.portfolio-protocol-rates>div>strong').allTextContents(),['—','—']);checks.push({width,name:'malformed interval evidence suppresses rates instead of showing cached values'});
  state.protocolAnnualised=annualised();await portfolio.getByRole('button',{name:'Refresh iAERO yield',exact:true}).click();await portfolio.getByText(formatYieldPercent(state.protocolAnnualised.earnedApy),{exact:true}).waitFor();await page.getByRole('button',{name:'Switch to dark theme',exact:true}).click();await page.getByRole('region',{name:'Portfolio yield rates',exact:true}).screenshot({path:out+'/'+width+'-portfolio-dark.png'});
  await f.openLegacy();assert.equal(await page.getByRole('button',{name:'Claim all',exact:true}).isEnabled(),true);assert.equal(f.writes.length,0);assert.deepEqual(f.errors,[]);assert.deepEqual(f.external,[]);checks.push({width,name:'yield changes leave existing claims usable, with no mocked writes or page errors'});
 }catch(e){await page.screenshot({path:out+'/FAILURE-'+width+'.png',fullPage:true});await writeFile(out+'/FAILURE.json',JSON.stringify({width,error:e.stack,checks},null,2));throw e;}finally{await f.browser.close();}
}
await writeFile(out+'/RESULT.json',JSON.stringify({status:'PASS',checks,scope:'Generated real-model estimates with mocked reads/wallets; no signatures or real transactions.'},null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks:checks.length,realTransactions:0}));
