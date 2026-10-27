import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {liveFixture} from './live-fixture.mjs';

const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4317';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const out=resolve('artifacts/visual-follow-up');await mkdir(out,{recursive:true});
const checks=[],measurements=[],pendingLayouts=[];
const record=(width,name)=>checks.push({width,name,pass:true});
for(const width of [1440,768,390,320]){
 const f=await liveFixture({viewport:{width,height:width<500?844:1000},isMobile:width<500,hasTouch:width<500,deviceScaleFactor:1});
 const {page,state,boot,registry,unit}=f;page.setDefaultTimeout(12000);
 boot.newStackReady=true;boot.newStackReason='';boot.newStack={ready:true,configured:true,reason:'Verified deployed contracts',addresses:{...state.newAddresses,iAERO:registry.legacy.iAERO,USDC:registry.legacy.USDC},emissionsModule:state.newAddresses.emissionsModule,optionalErrors:[]};
 state.protocolEarnedApy=12.34;state.protocolReceivedApy=9.87;
 for(let i=0;i<16;i++){const token='0x'+(88000+i).toString(16).padStart(40,'0');boot.rewardTokenAddresses.push(token);state.tokenMetadata.set(token,{symbol:'REWARD'+i,decimals:18});state.balances.set(token,unit/1000000n);if(i<12)state.quoteFailureTokens.add(token);}
 const snap=async name=>{
  await page.evaluate(()=>document.fonts.ready);
  const dialog=await page.getByRole('dialog').count();
  if(!dialog)await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:resolve(out,width+'-'+name+'.png'),fullPage:!dialog});
  if(!dialog)await page.screenshot({path:resolve(out,width+'-'+name+'-viewport.png')});
 };
 try{
  await page.goto(origin);await page.getByText('Connected to Base',{exact:true}).waitFor();
  await page.getByRole('article',{name:'LIQ staking yield',exact:true}).getByText('12.48%',{exact:true}).waitFor();
  await snap('overview');
  const geometry=await page.evaluate(()=>{const card=document.querySelector('.dashboard-liq-yield'),income=document.querySelector('.protocol-yield-card');return{streamCardHeight:card.getBoundingClientRect().height,incomeCardHeight:income.getBoundingClientRect().height,alignment:getComputedStyle(card.parentElement).alignItems,pageHeight:document.documentElement.scrollHeight};});
  if(width===1440)assert.equal(geometry.alignment,'start','Overview yield cards must keep their natural height');
  record(width,'Overview uses content-height cards');
  await f.connect();await page.getByText('5.19%',{exact:true}).waitFor();await snap('portfolio');
  assert.equal(await page.locator('.position-row[data-position="liqStake"]').count(),1);
  assert.ok((await page.locator('.position-row[data-position="liqStake"]').innerText()).includes('20.00'));
  const portfolio=await page.evaluate(()=>{
   const reward=[...document.querySelectorAll('button')].find(e=>e.textContent.trim().startsWith('Review & claim'));
   const nav=document.querySelector('.mobile-nav'),limit=nav&&getComputedStyle(nav).display!=='none'?nav.getBoundingClientRect().top:innerHeight;
   return{rewardActionBottom:reward.getBoundingClientRect().bottom,visibleLimit:limit,yieldSectionY:document.getElementById('portfolio-yields').getBoundingClientRect().top+scrollY,horizontalOverflow:document.documentElement.scrollWidth>innerWidth};
  });
  assert.equal(portfolio.horizontalOverflow,false);
  if(width===390)assert.ok(portfolio.rewardActionBottom<=portfolio.visibleLimit,'reward entry must fit above mobile navigation');
  record(width,'Portfolio retains LIQ, known/unknown positions and a reachable reward action');
  await page.getByRole('link',{name:'View yield rates',exact:true}).click();
  assert.ok(await page.getByRole('article',{name:'iAERO yield',exact:true}).isVisible());
  record(width,'Portfolio yield shortcut reaches the detailed rates without changing page routing');
  await f.openLegacy();await page.getByRole('button',{name:'Claim all',exact:true}).waitFor();
  const claim=await page.getByRole('button',{name:'Claim all',exact:true}).boundingBox();
  assert.ok(claim.y>=0&&claim.y+claim.height<=page.viewportSize().height,'Claim all must appear on first screen');
  await snap('rewards-first');record(width,'legacy reward value and Claim all lead the dialog');
  await page.getByRole('button',{name:'Claim all',exact:true}).click();await page.getByRole('button',{name:'Confirm in wallet',exact:true}).waitFor();
  const eth=page.locator('.claim-token-summary>div').filter({hasText:'ETH'});
  await eth.getByText('< 0.000001',{exact:true}).waitFor();await eth.getByText('Exact amount',{exact:true}).click();await eth.getByText('0.000000000000000001',{exact:true}).waitFor();
  await snap('exact-claim-review');record(width,'positive native dust has a nonzero summary and fully accessible exact amount');
  await f.close();if(!await page.getByRole('dialog').count())await f.openLegacy();
  await page.getByRole('button',{name:'Customise tokens to sweep',exact:true}).click();await page.getByRole('checkbox',{name:'Select WETH 0x4200…0006',exact:true}).waitFor();
  await page.getByText('Estimated wallet value · highest first',{exact:true}).waitFor();
  const rowHeight=await page.locator('.sweep-token-row').first().evaluate(e=>e.getBoundingClientRect().height);
  if(width<500)assert.ok(rowHeight<176,'phone sweep rows must be more compact than the old 206px rows');
  for(const end of ['top','bottom']){
   await page.getByRole('dialog').evaluate((e,end)=>{e.scrollTop=end==='top'?0:e.scrollHeight;},end);
   const action=await page.getByRole('button',{name:/^Review \d+ token/}).boundingBox();
   assert.ok(action.y>=0&&action.y+action.height<=page.viewportSize().height+1,'Review must stay visible at '+end);
  }
  await snap('dense-sweep');record(width,'dense sweep has compact rows and persistent selection/review controls');
  await page.getByRole('button',{name:/^Review \d+ token/}).click();await page.getByRole('button',{name:'Confirm sweep in wallet',exact:true}).waitFor();
  const review=await page.evaluate(()=>{const dialog=document.querySelector('[role=dialog]'),output=dialog.querySelector('.sweep-output'),header=dialog.querySelector('.dialog-topbar');return{scrollTop:dialog.scrollTop,outputY:output.getBoundingClientRect().top,headerBottom:header.getBoundingClientRect().bottom,focusedTag:document.activeElement?.tagName,scrollWidth:dialog.scrollWidth,clientWidth:dialog.clientWidth};});
  assert.equal(review.scrollTop,0);assert.ok(review.outputY>=review.headerBottom);assert.equal(review.focusedTag,'H2');assert.ok(review.scrollWidth<=review.clientWidth+1);
  const amount=await page.locator('.sweep-review-inputs .exact-amount>strong').first().evaluate(e=>({text:e.textContent,height:e.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(e).lineHeight)}));
  assert.equal(amount.text,'100');assert.ok(amount.height<=amount.lineHeight+1,'a three-digit input amount must fit on one line');
  assert.equal(await page.locator('.sweep-skipped-tokens>details').getAttribute('open'),null);
  await page.locator('.sweep-skipped-tokens>details>summary').click();await page.locator('.sweep-skipped-group>summary').first().click();
  await page.getByRole('region',{name:'Skipped sweep tokens',exact:true}).getByText(/no executable USDC route/).first().waitFor();
  await page.getByRole('dialog').evaluate(e=>{e.scrollTop=0;});await snap('sweep-review-top');record(width,'long sweep review resets scroll/focus and preserves grouped exact exclusion reasons');
  await f.close();if(await page.getByRole('dialog').count())await f.close();
  for(const name of ['Earn','Get iAERO']){await f.go(name);if(name==='Get iAERO')await page.getByRole('heading',{name:'More ways to get iAERO.',exact:true}).waitFor();await snap(name==='Earn'?'earn':'rift');}
  await f.go('Earn');assert.equal(await page.locator('.transition-guide').getAttribute('open'),null);await page.locator('.transition-guide>summary').click();await page.getByRole('button',{name:'Review previous rewards',exact:true}).waitFor();record(width,'legacy transition instructions remain accessible in a compact disclosure');
  await page.getByRole('button',{name:'Receipt & collateral positions',exact:true}).click();await snap('collateral');await f.close();
  await page.getByRole('button',{name:'Switch to dark theme',exact:true}).click();await f.go('Portfolio');await snap('portfolio-dark');await f.go('Overview');await snap('overview-dark');
  assert.deepEqual(f.errors,[]);assert.deepEqual(f.external,[]);assert.equal(f.writes.length,0);record(width,'light/dark page and dialog captures have no errors or mocked writes');
  measurements.push({width,overview:geometry,portfolio,sweep:{rowHeight,review},pageErrors:f.errors,mockedWrites:f.writes.length});
 }catch(error){await snap('FAILURE');await writeFile(resolve(out,'FAILURE.json'),JSON.stringify({width,error:error.stack,checks,measurements},null,2)+'\n');throw error;}
 finally{await f.browser.close();}
}
for(const width of [390,320]){
 const f=await liveFixture({viewport:{width,height:844},isMobile:true,hasTouch:true});
 try{
  await f.page.goto(origin);await f.connect();
  const rect=await f.page.getByRole('button',{name:'Review & claim',exact:true}).boundingBox();
  const nav=await f.page.getByRole('navigation',{name:'Mobile navigation',exact:true}).boundingBox();
  await f.page.screenshot({path:resolve(out,width+'-portfolio-pending-viewport.png')});
  pendingLayouts.push({width,rewardActionBottom:rect.y+rect.height,navigationTop:nav.y});await writeFile(resolve(out,'PENDING_LAYOUTS.json'),JSON.stringify(pendingLayouts,null,2)+'\n');
  assert.ok(rect.y>=0&&rect.y+rect.height<=nav.y,'pending-deployment rewards must fit above navigation');
  record(width,'pending-deployment Portfolio keeps the reward entry in the first viewport');
  await f.openLegacy();await f.page.getByRole('button',{name:'Claim all',exact:true}).waitFor();
  assert.equal(await f.page.getByRole('button',{name:'Claim all',exact:true}).isEnabled(),true);
  assert.equal(f.writes.length,0);assert.deepEqual(f.errors,[]);
  record(width,'pending deployment leaves existing claims accessible');
 }finally{await f.browser.close();}
}
await writeFile(resolve(out,'RESULT.json'),JSON.stringify({status:'PASS',scope:'Author local Chrome checks; all wallets and reads mocked. No real signatures or transactions.',checks,measurements,pendingLayouts},null,2)+'\n');
console.log(JSON.stringify({status:'PASS',checks:checks.length,widths:measurements.map(m=>m.width),realTransactions:0}));
