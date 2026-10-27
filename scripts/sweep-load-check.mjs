import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {liveFixture} from './live-fixture.mjs';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4318';assert.equal(new URL(origin).hostname,'127.0.0.1');
const {page,browser,connect,openLegacy,writes,errors}=await liveFixture();let blocked=0;
try{
  await page.route('**/assets/sweep-view-*.js',route=>{blocked++;return route.abort();});
  await page.goto(origin);await connect();assert.equal(blocked,0);
  await openLegacy();await page.getByRole('button',{name:'Customise tokens to sweep',exact:true}).click();await page.getByRole('heading',{name:'Your sweep could not open.',exact:true}).waitFor();
  await page.getByRole('button',{name:'Back to your rewards',exact:true}).click();await page.getByRole('button',{name:'Claim all',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Claim all',exact:true}).isEnabled(),true);assert.equal(writes.length,0);assert.equal(blocked,1);assert.deepEqual(errors,[]);
  const result={status:'PASS',scope:'Blocked deferred UI module in mocked local browser; existing rewards remain available; no wallet transactions.',blocked,writes:writes.length,errors};
  await mkdir('artifacts/usability',{recursive:true});await writeFile('artifacts/usability/LOAD_FAILURE.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await browser.close();}
