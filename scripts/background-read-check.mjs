import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {liveFixture} from './live-fixture.mjs';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4318';assert.equal(new URL(origin).hostname,'127.0.0.1');
const {page,browser,state,writes,errors}=await liveFixture();
try{
  await page.clock.install();await page.goto(origin);await page.getByText('Connected to Base',{exact:true}).waitFor();
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  const before=state.bootstrapReads;await page.clock.fastForward(31000);assert.equal(state.bootstrapReads,before);
  const resumed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/contracts');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await resumed;
  assert.ok(state.bootstrapReads>before);assert.equal(writes.length,0);assert.deepEqual(errors,[]);
  const result={status:'PASS',scope:'Mocked visibility and browser clock: 31 seconds hidden adds no contract reads; visibility resumes a fresh read. No transaction lifecycle is altered.',before,after:state.bootstrapReads,writes:writes.length,errors};
  await mkdir('artifacts/usability',{recursive:true});await writeFile('artifacts/usability/BACKGROUND_READS.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await browser.close();}
