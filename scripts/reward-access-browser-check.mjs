import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {liveFixture} from './live-fixture.mjs';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4330';assert.equal(new URL(origin).hostname,'127.0.0.1');
const out=process.env.REWARD_ACCESS_OUTPUT??'artifacts/reward-access-20261028/browser';await mkdir(out,{recursive:true});
const checks=[];
for(const width of [1440,390,320]){
 const f=await liveFixture({viewport:{width,height:width<500?844:1050},reducedMotion:'reduce'}),{page,state,registry,unit,writes}=f;
 const bad='0x00000000000000000000000000000000aa110001';
 state.liqTokens=[registry.legacy.USDC,registry.legacy.WETH,bad];state.liqAmounts=[1500000n,unit/100n,unit];state.liqFailTokens=new Set([bad.toLowerCase()]);state.tokenMetadata.set(bad.toLowerCase(),{symbol:'Anon',decimals:18});
 const tools=()=>page.getByRole('region',{name:'Reward tools',exact:true});
 try{
  await page.goto(origin);await f.connect();
  for(const route of ['Overview','Portfolio','Earn']){await f.go(route);for(const name of ['Claim LIQ rewards','Compound to iAERO','Sweep to USDC'])assert.equal(await tools().getByRole('button',{name,exact:true}).isVisible(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks.push({width,name:route+' exposes all reward tools without a disclosure'});}
  await tools().getByRole('button',{name:'Claim LIQ rewards',exact:true}).click();
  await page.getByRole('button',{name:'Claim 2 available rewards',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Claim 2 available rewards',exact:true}).isEnabled(),true);
  const badRow=page.locator('.yield-asset').filter({has:page.getByText('Anon',{exact:true})});await badRow.getByText(/insufficient balance/).waitFor();assert.equal(await badRow.getByRole('button',{name:'Claim',exact:true}).isDisabled(),true);assert.equal(writes.length,0);checks.push({width,name:'underfunded token is identified before signing; healthy claims remain enabled'});
  await page.screenshot({path:out+'/'+width+'-liq-check.png',fullPage:true});
  await page.getByRole('button',{name:'Claim 2 available rewards',exact:true}).click();await page.getByRole('button',{name:'Confirm in wallet',exact:true}).waitFor();assert(!(await page.getByRole('dialog').locator('.transaction-token-rows').innerText()).includes('Anon'));assert.equal(writes.length,0);await page.getByRole('button',{name:'Confirm in wallet',exact:true}).click();await page.getByRole('heading',{name:'Transaction complete',exact:true}).waitFor();
  assert.equal(writes.length,1);assert.equal(writes[0].name,'claimMany');assert.deepEqual(writes[0].args[0].map(t=>t.toLowerCase()),state.liqTokens.slice(0,2).map(t=>t.toLowerCase()));assert.equal(state.liqPrincipal,20n*unit);assert.equal(state.liqAmounts[2],unit);checks.push({width,name:'one mocked batch claims healthy tokens; excluded reward and LIQ principal remain'});
  await f.close();if(await page.getByRole('dialog').count())await f.close();await f.go('Portfolio');
  for(const [name,mode] of [['Sweep to USDC','USDC'],['Compound to iAERO','iAERO + stake']]){await tools().getByRole('button',{name,exact:true}).click();await page.getByRole('button',{name:mode,exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:mode,exact:true}).getAttribute('aria-pressed'),'true');await page.getByRole('checkbox',{name:/^Select WETH /}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:out+'/'+width+'-'+(mode==='USDC'?'sweep':'compound')+'.png',fullPage:true});await f.close();checks.push({width,name:name+' opens the executable existing wallet flow directly'});}
  await tools().getByRole('button',{name:'Claim LIQ rewards',exact:true}).click();await page.getByRole('button',{name:'Claim 0 available rewards',exact:true}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'Sweep to USDC',exact:true}).click();await page.getByRole('checkbox',{name:/^Select WETH /}).waitFor();checks.push({width,name:'LIQ dialog can continue to wallet conversion even when only the failing reward remains'});assert.equal(writes.length,1);assert.deepEqual(f.errors,[]);assert.deepEqual(f.external,[]);
 }catch(e){await page.screenshot({path:out+'/'+width+'-FAILURE.png',fullPage:true});throw e;}finally{await f.browser.close();}
}
await writeFile(out+'/RESULT.json',JSON.stringify({status:'PASS',checks,scope:'Mocked read transport and wallet; no real signatures or transactions'},null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks:checks.length}));
