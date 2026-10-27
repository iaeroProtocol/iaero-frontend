import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {liveFixture} from './live-fixture.mjs';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4318';assert.equal(new URL(origin).hostname,'127.0.0.1');
const {page,browser,state,connect,openLegacy,openYieldDetails,writes,errors,external}=await liveFixture();const checks=[];
try{
 await page.goto(origin);const card=page.getByRole('article',{name:'Protocol yield and claim history',exact:true});await card.getByText('123.45',{exact:false}).waitFor();
 assert.equal(await card.locator('.yield-apy strong').allTextContents().then(values=>values.every(v=>v==='—')),true);assert.ok((await card.innerText()).includes('Building a complete seven-day observation window'));checks.push('current pending income is distinct from received income; incomplete weekly evidence never produces an APY');
 await openYieldDetails();await card.locator('summary').filter({hasText:'Claim history'}).click();await card.getByText('No claims confirmed in the indexed history.',{exact:false}).waitFor();
 const downloadPromise=page.waitForEvent('download');await card.getByRole('button',{name:'Download saved yield history',exact:false}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'iaero-protocol-yield-history.json');checks.push('explicit history export is available without a wallet or signing');
 state.yieldFailure=true;await card.getByRole('button',{name:'Refresh protocol yield',exact:true}).click();await card.getByText('This read is unavailable or expired; saved receipts are preserved.',{exact:true}).waitFor();assert.deepEqual(await card.locator('.yield-metrics strong').allTextContents(),['— USDC','— USDC']);checks.push('yield outages show unknown values and preserve saved history');
 state.yieldFailure=false;state.yieldMalformed=true;await card.getByRole('button',{name:'Refresh protocol yield',exact:true}).click();await card.getByText('This read is unavailable or expired; saved receipts are preserved.',{exact:true}).waitFor();checks.push('malformed successful analytics responses are rejected without crashing account controls');
 await connect();await openLegacy();assert.equal(await page.getByRole('button',{name:'Claim all',exact:true}).isEnabled(),true);assert.equal(await page.getByRole('button',{name:'Withdraw old iAERO',exact:true}).isEnabled(),true);checks.push('analytics failures do not gate legacy claims or principal withdrawals');
 assert.equal(writes.length,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 await mkdir('artifacts/protocol-yield',{recursive:true});await writeFile('artifacts/protocol-yield/BROWSER.json',JSON.stringify({status:'PASS',checks,scope:'Mocked read data and wallet; zero signatures/transactions',writes:writes.length,errors,external},null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks:checks.length,writes:writes.length}));
}finally{await browser.close();}
