import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4318';assert.equal(new URL(origin).hostname,'127.0.0.1');
const output=resolve('artifacts/live-readback');await mkdir(output,{recursive:true});
const response=await fetch(origin+'/api/contracts'),boot=await response.json();assert.equal(response.status,200);assert.equal(boot.snapshot.independentProviders,2);assert.equal(boot.newStackReady,false);assert.equal(boot.legacyReady,true);assert.equal(boot.oldAutoReady,true);
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'}),page=await context.newPage(),errors=[],external=[],writes=[];
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/*',route=>{
  const u=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(u.hostname)&&!['data:','blob:'].includes(u.protocol)){external.push(u.hostname);return route.abort();}
  if(u.pathname==='/api/base'){const rpc=route.request().postDataJSON();for(const r of Array.isArray(rpc)?rpc:[rpc])if(/send|sign|personal|wallet_|anvil_/i.test(r.method)){writes.push(r.method);return route.abort();}}
  return route.continue();
});
await page.addInitScript(address=>{
  const provider={request:async({method})=>{if(method==='eth_chainId')return '0x2105';if(method==='eth_accounts'||method==='eth_requestAccounts')return [address];throw Error('READ ONLY: no signing or transaction methods available.');},on:()=>{},removeListener:()=>{}};
  window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'read-only-address',name:'Read-only public address',rdns:'local.test'},provider}})));
},boot.metrics.protocolNftOwner);
try{
  await page.goto(origin);await page.getByText('Connected to Base',{exact:true}).waitFor();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();await page.getByRole('button',{name:'Read-only public address',exact:true}).click();
  await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('link',{name:'Portfolio',exact:true}).click();
  await page.getByText(/Read at \d/).waitFor({timeout:120000});
  const portfolio=await page.locator('main').innerText();await page.screenshot({path:resolve(output,'actual-base-portfolio.png'),fullPage:true});
  await page.getByRole('button',{name:'Previous rewards',exact:true}).click();await page.getByRole('heading',{name:'Previous rewards.',exact:true}).waitFor();const legacy=await page.getByRole('dialog').innerText();await page.screenshot({path:resolve(output,'actual-base-legacy.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(writes,[]);
  const result={status:'PASS',scope:'Actual Base RPC reads through the server-only connection. Read-only address fixture; no real wallet, signature or transaction.',checkedAt:new Date().toISOString(),publicAddress:boot.metrics.protocolNftOwner,bootstrap:boot,portfolioText:portfolio,legacyText:legacy,pageErrors:errors,externalBrowserRequests:external,writeRequests:writes};
  await writeFile(resolve(output,'RESULT.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:'PASS',block:boot.snapshot.block,providers:2,legacyReady:boot.legacyReady,oldAutoReady:boot.oldAutoReady,newStackReady:false,writeRequests:0}));
}catch(error){await page.screenshot({path:resolve(output,'FAILURE.png'),fullPage:true});throw error;}finally{await browser.close();}
