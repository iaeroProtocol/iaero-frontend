import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {liveFixture} from './live-fixture.mjs';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4330';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const out=process.env.SWEEP_RETRY_OUTPUT??'artifacts/sweep-retries-20261028/browser';await mkdir(out,{recursive:true});
const checks=[];
for(const width of [1440,390,320]){
 const f=await liveFixture({viewport:{width,height:width<500?844:1050},reducedMotion:'reduce'}),{page,state,writes,unit}=f;
 state.failedBroadcastNames=new Map();
 const tools=()=>page.getByRole('region',{name:'Reward tools',exact:true}),dialog=()=>page.getByRole('dialog');
 const open=async(name='Sweep to USDC',bps=100,retries=true)=>{
  await tools().getByRole('button',{name,exact:true}).click();
  await page.getByRole('checkbox',{name:'Select WETH 0x4200…0006',exact:true}).waitFor();
  await page.getByRole('button',{name:'Clear selection',exact:true}).click();await page.getByRole('checkbox',{name:'Select WETH 0x4200…0006',exact:true}).check();
  await page.getByRole('textbox',{name:'Amount of WETH 0x4200…0006',exact:true}).fill('0.25');await page.locator('#sweep-slippage').selectOption(String(bps));
  const option=page.getByRole('checkbox',{name:'Automatic gas and slippage retries',exact:true});assert.equal(await option.isChecked(),true);if(!retries)await option.uncheck();
  await page.getByRole('button',{name:/^Review 1 token/}).click();await page.getByRole('button',{name:'Confirm sweep in wallet',exact:true}).waitFor();
 };
 const finish=async()=>{await page.getByRole('button',{name:'Confirm sweep in wallet',exact:true}).click();await page.getByRole('heading',{name:'Your rewards, put to work.',exact:true}).waitFor();};
 const back=async()=>page.getByRole('button',{name:'Back to your rewards',exact:true}).click();
 const record=name=>checks.push({width,name,pass:true});
 try{
  await page.goto(origin);await f.connect();await open();
  const policy=page.getByLabel('Automatic retry limits',{exact:true});await policy.getByText('Minimum including retries: 24.4375 USDC',{exact:true}).waitFor();assert((await policy.innerText()).includes('2.25%'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:out+'/'+width+'-review.png',fullPage:true});record('explicit gas/slippage limits and worst-case output fit before confirmation');
  const start=writes.length;state.failedBroadcastNames.set('executePlanFromCallerAdvanced',1);await finish();
  const swaps=writes.slice(start).filter(t=>t.name==='executePlanFromCallerAdvanced');assert.equal(swaps.length,2);assert(BigInt(swaps[1].gas)>=BigInt(swaps[0].gas)*3n/2n);assert.deepEqual(swaps.map(t=>t.args[0][0].slippageBps),[100,150]);assert.deepEqual(swaps.map(t=>t.args[2].minTotalOut),[24750000n,24625000n]);assert.equal(state.receiptsByHash.get(swaps[0].hash).status,'0x0');assert.equal(state.receiptsByHash.get(swaps[1].hash).status,'0x1');assert.equal(await page.getByRole('link',{name:'Confirmed failed attempt',exact:true}).getAttribute('href'),'https://basescan.org/tx/'+swaps[0].hash);record('exact failed receipt triggers a fresh boosted batch and preserves the failed attempt link');await back();
  await open('Compound to iAERO');const compoundStart=writes.length;state.failedBroadcastNames.set('execute',1);state.failedBroadcastNames.set('stake',1);await finish();
  const compound=writes.slice(compoundStart),routes=compound.filter(t=>t.name==='execute'),stakes=compound.filter(t=>t.name==='stake');assert.equal(compound.filter(t=>t.name==='executePlanFromCallerAdvanced').length,1);assert.equal(routes.length,2);assert.equal(stakes.length,2);assert(stakes.every(t=>t.args[0]===25n*unit));assert.equal(state.principal,45n*unit);assert.equal(state.balances.get(f.registry.legacy.iAERO.toLowerCase()),100n*unit);assert(BigInt(routes[1].gas)>BigInt(routes[0].gas));record('conversion and staking each retry safely, using only actual new iAERO');await back();
  await open('Sweep to USDC',500);await page.getByLabel('Automatic retry limits',{exact:true}).getByText(/5% to 10%/).waitFor();const capStart=writes.length;state.failedBroadcastNames.set('executePlanFromCallerAdvanced',100);await finish();const capped=writes.slice(capStart).filter(t=>t.name==='executePlanFromCallerAdvanced');assert.equal(capped.length,3);assert.deepEqual(capped.map(t=>t.args[0][0].slippageBps),[500,750,1000]);assert(capped.every(t=>BigInt(t.gas)<=16000000n));await page.getByRole('heading',{name:'No tokens were swapped',exact:true}).waitFor();record('retry count, 10% slippage and 16-million gas caps hold after repeated confirmed failures');await back();
  await open('Sweep to USDC',100,false);assert.equal(await page.getByLabel('Automatic retry limits',{exact:true}).count(),0);const offStart=writes.length;await page.getByRole('button',{name:'Confirm sweep in wallet',exact:true}).click();await page.getByRole('alert').filter({hasText:/Transaction reverted/}).waitFor();assert.equal(writes.slice(offStart).filter(t=>t.name==='executePlanFromCallerAdvanced').length,1);record('turning retries off requires fresh manual review after one failed attempt');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(f.errors,[]);assert.deepEqual(f.external,[]);record('no browser exceptions, unwanted external requests or horizontal overflow');
 }catch(error){await page.screenshot({path:out+'/'+width+'-FAILURE.png',fullPage:true});throw error;}finally{await f.browser.close();}
}
await writeFile(out+'/RESULT.json',JSON.stringify({status:'PASS',scope:'Mocked wallet and chain only; no real signature or transaction',checks},null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks:checks.length}));
