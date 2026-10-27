import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {liveFixture} from './live-fixture.mjs';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4330',output='artifacts/functionality-audit-20261027/alchemy-browser';
assert.equal(new URL(origin).hostname,'127.0.0.1');await mkdir(output,{recursive:true});
const checks=[],coverage={provider:'Alchemy',providers:1,singleProviderAccepted:true,independentlyVerified:false,independentLaunchProvidersRequired:2};
for(const width of [1440,390,320]){
 const f=await liveFixture({viewport:{width,height:width<500?844:1050}}),{page,boot}=f;page.setDefaultTimeout(15000);
 try{
  boot.snapshot.independentProviders=1;boot.readCoverage=coverage;boot.metrics.market.readProviders=1;
  await page.route('**/api/liq-yield',route=>route.fulfill({json:{status:'estimated',aprPct:12.48,reason:null,readAtMs:Date.now(),readProviders:1,readCoverage:coverage,totalStaked:'1000000000000000000000',stakedValueUsdcWad:'100000000000000000000',weeklyLiqUsdcWad:'240000000000000000',forecastUpdatedAt:new Date().toISOString()}}));
  await page.goto(origin);await page.getByText('Connected to Base',{exact:true}).waitFor();await page.getByText('1 provider',{exact:true}).waitFor();
  const markets=page.getByRole('region',{name:'Protocol market metrics',exact:true});await markets.getByText(/^0\.6400\s*USDC$/).waitFor();
  await page.locator('.connection-details>summary').click();await page.getByText('Alchemy only · independent confirmation pending.',{exact:true}).waitFor();
  checks.push({width,name:'Single Alchemy readback enables actual-shaped market data with truthful provider label'});
  await f.connect();await page.getByRole('article',{name:'LIQ staking yield',exact:true}).getByText('12.48%',{exact:true}).waitFor();
  await f.openLegacy();assert.equal(await page.getByRole('button',{name:'Claim all',exact:true}).isEnabled(),true);assert.equal(await page.getByRole('button',{name:'Withdraw old iAERO',exact:true}).isEnabled(),true);await f.close();
  await f.go('Earn');assert.equal(await page.getByRole('button',{name:'New staking stream not deployed',exact:true}).isDisabled(),true);
  assert.equal(f.writes.length,0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(f.errors,[]);
  checks.push({width,name:'Legacy claims, withdrawals and LIQ yield remain available; undeployed stream remains blocked; no writes or overflow'});
  if(width===1440){delete boot.readCoverage;await page.reload();await page.getByText('Verified Base contract data is unavailable. Refresh to retry.',{exact:true}).waitFor();checks.push({width,name:'An unapproved single-provider response is refused'});}
 }finally{await f.browser.close();}
}
await writeFile(output+'/RESULT.json',JSON.stringify({status:'PASS',checks,scope:'Mocked read APIs and wallet only; no transactions'},null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks:checks.length}));
