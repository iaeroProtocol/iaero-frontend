import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const demoUrl=new URL(process.env.PREVIEW_URL??'http://127.0.0.1:4317');demoUrl.searchParams.set('demo','1');
const url=demoUrl.href;
assert.equal(new URL(url).hostname,'127.0.0.1','Browser checks only target loopback.');
const output=resolve('artifacts/browser');await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_BINARY??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,reducedMotion:'reduce'});
const page=await context.newPage(),errors=[],external=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/*',route=>{
  const target=new URL(route.request().url());
  if(['127.0.0.1','localhost'].includes(target.hostname)||['data:','blob:'].includes(target.protocol))return route.continue();
  external.push(target.hostname);return route.abort();
});
const record=(name,data={})=>checks.push({name,pass:true,...data});
const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('iaero.saero.design-preview.v1'))?.wallet);
const go=async name=>{
  const width=page.viewportSize().width;
  await page.getByRole('navigation',{name:width<=640?'Mobile navigation':'Main navigation',exact:true}).getByRole('link',{name,exact:true}).click();
  await page.getByRole('heading',{level:1}).waitFor();
};
const screenshot=async name=>{await page.screenshot({path:resolve(output,name+'.png'),fullPage:true,animations:'disabled'});};
const finish=async({approval=false,legacy=false,doubleClick=false}={})=>{
  const dialog=page.getByRole('dialog');
  if(approval){
    await dialog.getByRole('button',{name:'Simulate exact approval',exact:true}).click();
    await dialog.getByRole('button',{name:'Confirm simulation',exact:true}).waitFor();
  }
  const button=dialog.getByRole('button',{name:'Confirm simulation',exact:true});
  if(doubleClick)await button.dblclick({delay:15});else await button.click();
  await dialog.getByRole('heading',{name:'Simulation complete',exact:true}).waitFor();
  await dialog.getByRole('button',{name:legacy?'Continue your transition':'Back to the app',exact:true}).click();
};
const setScenario=async({paused=false,unavailable=false,reset=false}={})=>{
  await page.getByRole('button',{name:'Preview controls',exact:true}).click();
  const dialog=page.getByRole('dialog');
  if(reset){await dialog.getByRole('button',{name:'Reset sample balances',exact:true}).click();return;}
  await dialog.getByRole('switch',{name:/Pause new deposits/}).setChecked(paused);
  await dialog.getByRole('switch',{name:/Simulate a reward-read outage/}).setChecked(unavailable);
  await dialog.getByRole('button',{name:'Done',exact:true}).click();
};

try{
  await page.goto(url);await page.evaluate(()=>document.fonts.ready);
  assert.match(await page.title(),/iAERO/);assert.equal(await page.getByRole('button',{name:'Connect wallet',exact:true}).count(),1);
  await screenshot('overview-desktop-disconnected');record('disconnected overview renders with self-hosted font and explicit sample mode');
  await go('Portfolio');await page.getByRole('heading',{name:'Your position starts here',exact:true}).waitFor();record('disconnected portfolio has an honest empty state');
  await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  await page.getByRole('button',{name:'Use demo wallet',exact:true}).click();
  assert.equal((await stored()).staked,'42500000000000000000000');record('demo wallet loads without a wallet extension or provider');

  await go('Earn');await page.getByRole('tab',{name:'Stake',exact:true}).focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab',{name:'Unstake',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('Home');assert.equal(await page.getByRole('tab',{name:'Stake',exact:true}).getAttribute('aria-selected'),'true');record('staking tabs support arrow keys, Home and associated accessible panels');
  await page.getByRole('textbox',{name:'iAERO amount',exact:true}).fill('1000');
  await page.getByRole('button',{name:'Review stake',exact:true}).click();
  const beforeApproval=await stored();
  await page.getByRole('dialog').getByRole('button',{name:'Simulate exact approval',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Confirm simulation',exact:true}).waitFor();
  assert.equal((await stored()).staked,beforeApproval.staked);
  await finish({doubleClick:true});
  assert.equal((await stored()).staked,'43500000000000000000000');assert.equal((await stored()).iaero,'7650500000000000000000');
  record('exact approval is separate; rapid confirmation credits the stake once');

  const beforeClaim=await stored();await page.getByRole('button',{name:'Claim USDC',exact:true}).click();await finish();
  const afterClaim=await stored();assert.equal(afterClaim.staked,beforeClaim.staked);assert(BigInt(afterClaim.usdc)-BigInt(beforeClaim.usdc)>=124831200n);record('USDC claim preserves principal and credits rewards');
  await page.getByRole('tab',{name:'Unstake',exact:true}).click();await page.getByRole('textbox',{name:'iAERO amount',exact:true}).fill('250.5');
  await page.getByRole('button',{name:'Review unstake',exact:true}).click();await finish();
  assert.equal((await stored()).staked,'43249500000000000000000');assert.equal((await stored()).iaero,'7901000000000000000000');record('unstake returns the exact iAERO principal');

  await go('Get iAERO');await page.getByRole('tab',{name:'Deposit AERO',exact:true}).click();
  await page.getByRole('textbox',{name:'AERO amount',exact:true}).fill('100');
  assert(await page.getByRole('button',{name:'Review AERO deposit',exact:true}).isDisabled());
  await page.getByRole('checkbox',{name:/I understand that AERO deposits are permanent/}).check();
  const beforeMint=await stored();await page.getByRole('button',{name:'Review AERO deposit',exact:true}).click();await finish({approval:true});
  const afterMint=await stored();assert.equal(BigInt(beforeMint.aero)-BigInt(afterMint.aero),100n*10n**18n);assert.equal(BigInt(afterMint.iaero)-BigInt(beforeMint.iaero),95n*10n**18n);record('mint requires permanence acknowledgment and credits net of the 5% fee');
  await page.getByRole('tab',{name:'Buy iAERO',exact:true}).click();await page.getByRole('textbox',{name:'USDC amount',exact:true}).fill('10');
  const beforeBuy=await stored();await page.getByRole('button',{name:'Review sample swap',exact:true}).click();await finish({approval:true});
  const afterBuy=await stored();assert.equal(BigInt(beforeBuy.usdc)-BigInt(afterBuy.usdc),10_000_000n);assert(BigInt(afterBuy.iaero)>BigInt(beforeBuy.iaero));record('sample swap changes only the local quoted assets');
  await page.getByRole('tab',{name:'Deposit NFT',exact:true}).click();await page.getByRole('textbox',{name:'Your converted sAERO NFT ID',exact:true}).fill('2048');
  await page.getByRole('button',{name:'Preview NFT checks',exact:true}).click();assert.equal(await page.getByRole('button',{name:/Approve.*NFT/i}).count(),0);assert.match(await page.locator('main').innerText(),/awaiting its verified registration/);record('NFT registration stays gated and blanket NFT approval is absent');

  await page.getByRole('button',{name:'Previous rewards',exact:true}).click();const legacyBefore=await stored();
  await page.getByRole('dialog').getByRole('button',{name:'Withdraw old iAERO',exact:true}).click();await finish({legacy:true});
  const legacyExit=await stored();assert.equal(legacyExit.legacyStake,'0');assert.equal(legacyExit.legacyRewards,legacyBefore.legacyRewards);
  await page.getByRole('dialog').getByRole('button',{name:'Claim selected old USDC',exact:true}).click();await finish({legacy:true});
  assert.equal((await stored()).legacyRewards,'0');await page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();record('legacy withdrawal leaves selected old USDC claimable afterward');

  await setScenario({paused:true});await go('Earn');await page.getByRole('textbox',{name:'iAERO amount',exact:true}).fill('1');
  assert(await page.getByRole('button',{name:'New staking is paused',exact:true}).isDisabled());
  await page.getByRole('tab',{name:'Unstake',exact:true}).click();await page.getByRole('textbox',{name:'iAERO amount',exact:true}).fill('1');
  assert(await page.getByRole('button',{name:'Review unstake',exact:true}).isEnabled());await page.getByRole('button',{name:'Review unstake',exact:true}).click();await finish();record('pausing new deposits preserves the principal exit');
  await setScenario({unavailable:true});assert(await page.getByRole('button',{name:'Claim USDC',exact:true}).isDisabled());
  await page.getByRole('textbox',{name:'iAERO amount',exact:true}).fill('1');assert(await page.getByRole('button',{name:'Review unstake',exact:true}).isEnabled());record('unavailable new rewards are not rendered as zero and do not hide principal');

  await setScenario({reset:true});await go('Earn');await page.getByRole('tab',{name:'Stake',exact:true}).click();
  await page.getByRole('button',{name:/AutoVault USDC/}).click();await page.getByRole('textbox',{name:'iAERO amount',exact:true}).fill('50');
  await page.getByRole('button',{name:'Review stake',exact:true}).click();await finish({approval:true});
  assert.equal((await stored()).autoStaked,'50000000000000000000');assert.equal((await stored()).staked,'42500000000000000000000');assert.match(await page.locator('.reward-label').innerText(),/AUTOVAULT/);record('AutoVault balances and reward source remain separate from direct staking');
  await page.getByRole('textbox',{name:'iAERO amount',exact:true}).fill('1e3');assert(await page.getByRole('button',{name:'Review stake',exact:true}).isDisabled());await page.getByRole('alert').waitFor();record('invalid numeric notation cannot enter a transaction review');
  const beforeReload=await stored();await page.reload();await page.getByRole('button',{name:'Demo wallet',exact:true}).waitFor();assert.equal((await stored()).iaero,beforeReload.iaero);record('preview balances persist across reload');

  await page.getByRole('button',{name:'Preview controls',exact:true}).click();await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);assert(await page.getByRole('button',{name:'Preview controls',exact:true}).evaluate(e=>e===document.activeElement));record('dialog Escape dismisses and restores trigger focus');
  await setScenario({reset:true});await go('Overview');await screenshot('overview-desktop-connected');await go('Earn');await screenshot('earn-desktop');await go('Get iAERO');await page.getByRole('tab',{name:'Deposit AERO',exact:true}).click();await page.getByRole('textbox',{name:'AERO amount',exact:true}).fill('1000');await screenshot('deposit-desktop');await go('Portfolio');await screenshot('portfolio-desktop');
  await page.getByRole('button',{name:'Switch to dark theme',exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'dark');await go('Overview');await screenshot('overview-desktop-dark');
  await page.getByRole('button',{name:'Switch to light theme',exact:true}).click();record('light and dark themes render');

  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});
    for(const name of ['Overview','Earn','Get iAERO','Portfolio']){
      await go(name);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,`${name} overflows at ${width}px`);
      assert(await page.getByRole('heading',{level:1}).isVisible());
      if(width===390)await screenshot(name.toLowerCase().replaceAll(' ','-')+'-mobile');
    }
    record('all four screens fit '+width+'px with a usable mobile navigation');
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);record('zero uncaught browser errors and zero external network requests');
  await writeFile(resolve(output,'RESULT.json'),JSON.stringify({status:'PASS',at:new Date().toISOString(),checks,errors,external,mode:'Demo adapter only; no real wallet, RPC, signing, push or deployment.'},null,2)+'\n');
  console.log(JSON.stringify({status:'PASS',checks:checks.length,errors,external,output},null,2));
}catch(error){
  await screenshot('failure');await writeFile(resolve(output,'FAILURE.json'),JSON.stringify({status:'FAIL',checks,errors,external,error:String(error)},null,2)+'\n');throw error;
}finally{await browser.close();}
