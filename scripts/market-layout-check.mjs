import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4318';assert.equal(new URL(origin).hostname,'127.0.0.1');
const boot=await (await fetch(origin+'/api/contracts')).json(),market=boot.metrics.market;
assert.equal(market.readProviders,2);assert.deepEqual(market.errors,[]);
assert.equal(BigInt(market.liqCirculatingSupply),BigInt(market.liqTotalSupply)-BigInt(market.liqUnvested)-BigInt(market.liqTreasuryBalance));
assert.equal(BigInt(market.liqMarketCapUsdcWad),BigInt(market.liqCirculatingSupply)*BigInt(market.liqPriceUsdcWad)/10n**BigInt(market.liqDecimals));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}),layouts=[],errors=[],external=[];
await mkdir('artifacts/market-readback',{recursive:true});
try{
  for(const width of [1440,390,320]){
    const context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500,reducedMotion:'reduce'}),page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{const host=new URL(route.request().url()).hostname;if(!['127.0.0.1','localhost'].includes(host)){external.push(host);return route.abort();}return route.continue();});
    await page.goto(origin);await page.waitForFunction(()=>document.querySelectorAll('.protocol-market-number').length===4&&[...document.querySelectorAll('.protocol-market-number')].every(e=>e.textContent!=='—'));await page.evaluate(()=>document.fonts.ready);
    const layout=await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,numbers:[...document.querySelectorAll('.protocol-market-number')].map(e=>{
      const r=document.createRange();r.selectNodeContents(e);const lines=[...r.getClientRects()];
      return {value:e.textContent,overflows:e.scrollWidth>e.clientWidth+1,wraps:lines.some(line=>Math.abs(line.y-lines[0].y)>1)};
    })}));
    assert.equal(layout.overflow,false);assert.equal(layout.numbers.length,4);assert.ok(layout.numbers.every(n=>!n.overflows&&!n.wraps));layouts.push(layout);
    await page.getByRole('region',{name:'Protocol market metrics',exact:true}).screenshot({path:`artifacts/market-readback/current-metrics-${width}.png`});await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  await writeFile('artifacts/market-readback/CIRCULATING_AND_LAYOUT.json',JSON.stringify({status:'PASS',at:new Date().toISOString(),snapshot:boot.snapshot,market,layouts,errors,external,scope:'Actual local API and two-provider finalized reads; no wallet connected; no signatures or transactions.'},null,2)+'\n');
  console.log(JSON.stringify({status:'PASS',block:market.asOfBlock,circulating:market.liqCirculatingSupply,capUsdcWad:market.liqMarketCapUsdcWad,widths:layouts.map(l=>l.width),errors}));
}finally{await browser.close();}
