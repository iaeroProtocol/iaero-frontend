import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {liveFixture} from './live-fixture.mjs';

const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4317';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const output='artifacts/branded-dashboard-browser';await mkdir(output,{recursive:true});
const checks=[];
const record=(width,name,detail)=>checks.push({width,name,...(detail?{detail}:{})});
const firstNumber=text=>Number(text.match(/^\s*([\d,.]+)/)?.[1].replaceAll(',',''));

async function inspect(page){
 await page.evaluate(()=>document.fonts.ready);
 return page.evaluate(()=>{
  const visible=e=>{const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&e.getClientRects().length>0&&!e.closest('[aria-hidden=true]');};
  const values=[...document.querySelectorAll('[data-overview-value]')].filter(visible);
  const clippedAmounts=values.filter(e=>{const r=e.getBoundingClientRect(),card=e.closest('article').getBoundingClientRect();return r.left<card.left-1||r.right>card.right+1||e.scrollWidth>e.clientWidth+1;}).map(e=>e.textContent.trim());
  const summary=document.querySelector('[aria-label="Your overview"]'),yieldCard=document.querySelector('[aria-label="Protocol yield and claim history"]');
  return {horizontalOverflow:document.documentElement.scrollWidth>innerWidth,clippedAmounts,personalBeforeYield:!!(summary.compareDocumentPosition(yieldCard)&Node.DOCUMENT_POSITION_FOLLOWING),personalTop:Math.round(summary.getBoundingClientRect().top+scrollY),yieldTop:Math.round(yieldCard.getBoundingClientRect().top+scrollY),pageHeight:document.documentElement.scrollHeight};
 });
}

for(const width of [1440,768,390,320]){
 const f=await liveFixture({viewport:{width,height:width<500?844:1050},isMobile:width<500,hasTouch:width<500}),{page,state}=f;
 page.setDefaultTimeout(15000);state.protocolEarnedApy=12.34;state.protocolReceivedApy=9.87;
 const personal=()=>page.getByRole('region',{name:'Your overview',exact:true});
 const principal=()=>page.getByRole('article',{name:'Your iAERO principal',exact:true});
 const liq=()=>page.getByRole('article',{name:'Your staked LIQ',exact:true});
 const rewards=()=>page.getByRole('article',{name:'Your reward estimate',exact:true});
 const protocol=()=>page.getByRole('article',{name:'Protocol yield and claim history',exact:true});
 try{
  await page.goto(origin);await page.getByText('Connected to Base',{exact:true}).waitFor();await personal().waitFor();
  assert.equal(await page.locator('.hero.dashboard-hero .orbital-scene svg').count(),1);
  const headline=await page.locator('.dashboard-hero h1').innerText();assert.match(headline,/Stay liquid/);assert.match(headline,/Earn in USDC/);
  for(const card of [principal(),liq(),rewards()]){
   const value=await card.locator('[data-overview-value]').innerText();assert.match(value,/^\s*—/);assert.ok(!/^\s*0(?:\.0+)?/.test(value));
  }
  assert.equal(await page.evaluate(()=>window.testWallet.calls.length),0);
  record(width,'original orbital branding remains and disconnected personal values stay unknown without a wallet request');

  await protocol().getByText('12.34%',{exact:true}).waitFor();
  await page.getByRole('article',{name:'LIQ staking yield',exact:true}).getByText('12.48%',{exact:true}).waitFor();
  assert.equal(await page.getByRole('region',{name:'Protocol market metrics',exact:true}).locator('.protocol-stats strong').count(),4);
  const initialLayout=await inspect(page);assert.equal(initialLayout.horizontalOverflow,false);assert.deepEqual(initialLayout.clippedAmounts,[]);assert.equal(initialLayout.personalBeforeYield,true);
  await page.screenshot({path:output+'/'+width+'-disconnected.png',fullPage:true});
  record(width,'public protocol and LIQ rates coexist with unknown personal values and all market metrics',initialLayout);

  await f.connect();await f.go('Overview');
  await principal().locator('[data-overview-value]').filter({hasText:'123'}).waitFor();
  assert.equal(firstNumber(await principal().locator('[data-overview-value]').innerText()),123);
  assert.equal(firstNumber(await liq().locator('[data-overview-value]').innerText()),20);
  const rewardScope=await rewards().innerText();assert.match(rewardScope,/Selected legacy rewards/i);assert.match(rewardScope,/LIQ rewards viewed separately/i);
  const connectedLayout=await inspect(page);assert.equal(connectedLayout.horizontalOverflow,false);assert.deepEqual(connectedLayout.clippedAmounts,[]);assert.equal(connectedLayout.personalBeforeYield,true);
  await page.screenshot({path:output+'/'+width+'-connected.png',fullPage:true});
  record(width,'connected principal includes wallet plus legacy positions once, LIQ stays separate and reward scope is explicit',connectedLayout);

  const rewardRoutes=page.locator('details#overview-rewards');assert.equal(await rewardRoutes.evaluate(e=>e.open),false);
  await rewards().getByRole('button',{name:'Review rewards',exact:true}).click();assert.equal(await rewardRoutes.evaluate(e=>e.open),true);
  await rewardRoutes.getByRole('button',{name:'Review legacy rewards',exact:true}).click();
  await page.getByRole('heading',{name:'Previous rewards.',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Claim all',exact:true}).isEnabled(),true);
  await page.getByRole('button',{name:'Customise tokens to sweep',exact:true}).click();await page.getByRole('checkbox',{name:'Select WETH 0x4200…0006',exact:true}).waitFor();
  await f.close();if(await page.getByRole('dialog').count())await f.close();
  record(width,'one review entry point reaches existing legacy claims and the full sweep flow without sending');

  await rewardRoutes.getByRole('button',{name:'Review LIQ rewards',exact:true}).click();
  await page.getByRole('heading',{name:'Your LIQ, at work.',exact:true}).waitFor();await page.getByRole('button',{name:'Claim all LIQ rewards',exact:true}).waitFor();await f.close();
  await principal().getByRole('button',{name:'View positions',exact:true}).click();await page.getByRole('heading',{name:'Your portfolio.',exact:true}).waitFor();await f.go('Overview');
  record(width,'LIQ claims and the full Portfolio remain directly reachable from the overview');

  const details=protocol().locator('details.dashboard-yield-details');assert.equal(await details.evaluate(e=>e.open),false);
  await details.locator(':scope > summary').click();await protocol().locator('.yield-details>summary').filter({hasText:'Claim history'}).click();
  await protocol().getByText('No claims confirmed in the indexed history.',{exact:false}).waitFor();
  await protocol().locator('.yield-details>summary').filter({hasText:'Claim history'}).click();await details.locator(':scope > summary').click();
  record(width,'expanded history and methodology remain accessible while the default dashboard stays compact');

  await page.getByRole('button',{name:'Switch to dark theme',exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme==='dark'),true);
  const darkLayout=await inspect(page);assert.equal(darkLayout.horizontalOverflow,false);assert.deepEqual(darkLayout.clippedAmounts,[]);assert.equal(darkLayout.personalBeforeYield,true);
  assert.equal(await page.locator('.dashboard-hero .orbital-scene svg').count(),1);await page.screenshot({path:output+'/'+width+'-dark.png',fullPage:true});
  assert.equal(f.writes.length,0);assert.deepEqual(f.errors,[]);assert.deepEqual(f.external,[]);
  assert.equal(await page.evaluate(()=>window.testWallet.calls.filter(c=>/eth_send|eth_sign|personal_sign|wallet_send/i.test(c.method)).length),0);
  record(width,'dark/mobile layouts retain branding and clear amounts with no page errors, signatures or transactions',darkLayout);
 }catch(error){
  await page.screenshot({path:output+'/FAILURE-'+width+'.png',fullPage:true});
  await writeFile(output+'/FAILURE.json',JSON.stringify({width,error:error.stack,checks,pageErrors:f.errors,external:f.external,writes:f.writes.length},null,2)+'\n');throw error;
 }finally{await f.browser.close();}
}
await writeFile(output+'/RESULT.json',JSON.stringify({status:'PASS',checks,scope:'Compiled branded Overview with mocked read transport and wallet. No signatures, payments or real transactions.',realTransactions:false},null,2)+'\n');
console.log(JSON.stringify({status:'PASS',checks:checks.length,widths:[1440,768,390,320],realTransactions:false}));
