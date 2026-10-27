import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {liveFixture} from './live-fixture.mjs';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4318',stage=process.env.AUDIT_STAGE??'after';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const output=resolve('artifacts/usability',stage);await mkdir(output,{recursive:true});
const results=[];
for(const width of [1440,768,390,320]){
  const fixture=await liveFixture({viewport:{width,height:width<500?844:1050},isMobile:width<500,hasTouch:width<500,deviceScaleFactor:1});
  const {page,go,connect,openLegacy,close,browser,errors,external,writes}=fixture;
  async function inspect(name,screenshot=false){
    await page.evaluate(()=>document.fonts.ready);
    const metrics=await page.evaluate(()=>{
      const root=document.querySelector('[role=dialog]')??document.querySelector('.app');
      const visible=e=>{const c=getComputedStyle(e);return c.display!=='none'&&c.visibility!=='hidden'&&e.getClientRects().length>0&&!e.closest('[aria-hidden=true]');};
      const label=e=>(e.getAttribute('aria-label')??e.textContent??'').trim().replace(/\s+/g,' ').slice(0,90);
      const text=[...root.querySelectorAll('*')].filter(e=>visible(e)&&!e.closest('svg')&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()));
      const controls=[...root.querySelectorAll('button,input:not([type=hidden]),select,summary,nav a')].filter(e=>visible(e));
      const smallTargets=controls.map(e=>{const target=e.matches('input[type=checkbox]')?e.closest('label')??e:e;const r=target.getBoundingClientRect();return {label:label(e),width:Math.round(r.width),height:Math.round(r.height)};}).filter(r=>r.width<43.5||r.height<43.5);
      const tinyText=text.filter(e=>parseFloat(getComputedStyle(e).fontSize)<11.9).map(e=>({text:label(e),size:getComputedStyle(e).fontSize}));
      const smallInputs=controls.filter(e=>e.matches('input:not([type=checkbox]),select')&&parseFloat(getComputedStyle(e).fontSize)<16).map(e=>label(e));
      const rgb=s=>{const c=s.match(/[\d.]+/g)?.map(Number);return c&&c.length>=3?[...c.slice(0,3),c[3]??1]:null;};
      const luminance=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
      const lowContrast=text.flatMap(e=>{
        if(e.closest('button:disabled,[aria-disabled=true]'))return [];
        const style=getComputedStyle(e),fg=rgb(style.color);if(!fg)return [];
        let parent=e,bg=null;
        while(parent){const p=getComputedStyle(parent);if(p.backgroundImage!=='none'||Number(p.opacity)<1)return [];const color=rgb(p.backgroundColor);if(color&&color[3]===1){bg=color;break;}parent=parent.parentElement;}
        if(!bg)return [];const blended=fg.slice(0,3).map((v,i)=>v*fg[3]+bg[i]*(1-fg[3]));
        const l1=luminance(blended),l2=luminance(bg),ratio=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05),size=parseFloat(style.fontSize),large=size>=24||(size>=18.66&&Number(style.fontWeight)>=700);
        return ratio<(large?3:4.5)?[{text:label(e),class:e.className,color:style.color,ratio:Math.round(ratio*100)/100}]:[];
      });
      const clipped=[...text,...controls].filter(e=>{const r=e.getBoundingClientRect();return r.left < -1||r.right>innerWidth+1||(e.matches('button,summary,nav a')&&e.scrollWidth>e.clientWidth+1);}).map(e=>({text:label(e),class:e.className}));
      const rect=root.getBoundingClientRect();
      return {horizontalOverflow:document.documentElement.scrollWidth>innerWidth,dialogOverflow:root.matches('[role=dialog]')&&(root.scrollWidth>root.clientWidth+1||rect.width>innerWidth+1),lowContrast,clipped,minTextPx:Math.min(...text.map(e=>parseFloat(getComputedStyle(e).fontSize))),textNodes:text.length,tinyText,smallTargets,smallInputs,viewport:{width:innerWidth,height:innerHeight},dialog:root.matches('[role=dialog]')};
    });
    results.push({width,name,...metrics});
    if(screenshot)await page.screenshot({path:resolve(output,`${width}-${name}.png`),fullPage:!metrics.dialog});

  }
  try{
    await page.goto(origin);await page.getByText('Connected to Base',{exact:true}).waitFor();await inspect('overview',true);
    await fixture.openYieldDetails();await inspect('yield-details-expanded');
    for(const label of ['Reward breakdown','Claim history','How yield is measured']){const summary=page.locator('.yield-details>summary').filter({hasText:label});await summary.click();await inspect('yield-'+label.toLowerCase().replaceAll(' ','-'));await summary.click();}
    await page.getByRole('button',{name:'Connect wallet',exact:true}).first().click();await page.getByRole('button',{name:'Test Browser Wallet',exact:true}).waitFor();await inspect('wallet',width===390);await close();
    await connect();
    for(const name of ['Earn','Get iAERO','Portfolio']){await go(name);if(name==='Get iAERO')await page.getByText('Get iAERO with tokens you hold',{exact:true}).waitFor();await inspect(name.toLowerCase().replaceAll(' ','-'),true);}
    await go('Earn');await page.getByRole('button',{name:'Manage LIQ staking',exact:true}).click();await page.getByRole('heading',{name:'Your LIQ, at work.',exact:true}).waitFor();await page.getByRole('button',{name:'Claim all LIQ rewards',exact:true}).waitFor();await inspect('liq-management',true);await close();await page.getByRole('button',{name:'Receipt & collateral positions',exact:true}).click();await inspect('collateral-gated',true);await close();
    await openLegacy();await page.getByRole('button',{name:'Claim all',exact:true}).waitFor();await inspect('rewards',true);
    await page.getByRole('button',{name:'Claim all',exact:true}).click();await page.getByRole('button',{name:'Confirm in wallet',exact:true}).waitFor();await inspect('claim-review',width===390);await close();
    if(!await page.getByRole('dialog').count())await openLegacy();
    await page.getByRole('button',{name:'Customise tokens to sweep',exact:true}).click();await page.getByRole('checkbox',{name:'Select WETH 0x4200…0006',exact:true}).waitFor();await inspect('sweep-selection',true);
    if(width<500){await page.getByRole('textbox',{name:'Amount of WETH 0x4200…0006',exact:true}).focus();await page.setViewportSize({width,height:480});await inspect('sweep-short-viewport',true);await page.setViewportSize({width,height:844});}
    await page.getByRole('button',{name:'Clear selection',exact:true}).click();await page.getByRole('checkbox',{name:'Select WETH 0x4200…0006',exact:true}).check();await page.getByRole('button',{name:/^Review \d+ token/}).click();await page.getByRole('button',{name:'Confirm sweep in wallet',exact:true}).waitFor();await inspect('sweep-review',width===390);
    await close();if(await page.getByRole('dialog').count())await close();
    await page.getByRole('button',{name:'Switch to dark theme',exact:true}).click();await go('Overview');await inspect('overview-dark',true);
    await page.locator('.market-methods>summary').click();await inspect('market-definitions');await page.locator('.market-methods>summary').click();
    await page.evaluate(()=>document.documentElement.style.fontSize='20px');await inspect('larger-text-overview');await go('Earn');await inspect('larger-text-earn');await openLegacy();await inspect('larger-text-rewards');await close();await page.evaluate(()=>document.documentElement.style.removeProperty('font-size'));
    await page.goto(origin+'/?demo=1');
    if(await page.getByRole('button',{name:'Switch to light theme',exact:true}).count())await page.getByRole('button',{name:'Switch to light theme',exact:true}).click();
    await page.getByRole('button',{name:'Connect wallet',exact:true}).click();await page.getByRole('button',{name:'Use demo wallet',exact:true}).click();
    for(const name of ['Overview','Earn','Get iAERO','Portfolio']){await go(name);await inspect('demo-'+name.toLowerCase().replaceAll(' ','-'),width<500);}
    await go('Overview');await page.locator('.chart-container>svg').hover({position:{x:100,y:50}});await page.locator('.chart-point-readout').waitFor();await inspect('demo-chart-readout');
    await go('Earn');await page.getByRole('textbox',{name:'iAERO amount',exact:true}).fill('100');await page.getByRole('button',{name:'Review stake',exact:true}).click();await inspect('demo-stake-review',width===390);await close();
    await page.getByRole('button',{name:'AutoVault USDC',exact:true}).click();await inspect('demo-autovault');
    await go('Get iAERO');await page.getByRole('tab',{name:'Deposit AERO',exact:true}).click();await page.getByRole('textbox',{name:'AERO amount',exact:true}).fill('100');await inspect('demo-deposit',width<500);
    await page.getByRole('tab',{name:'Deposit NFT',exact:true}).click();await inspect('demo-nft');
    await page.getByRole('button',{name:'Preview controls',exact:true}).click();await inspect('demo-controls');await close();
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(writes.length,0);
  }finally{await writeFile(resolve(output,'RESULT.json'),JSON.stringify({stage,scope:'Local Chrome author usability audit. Mocked wallet/read transport; no transactions or signatures.',results},null,2)+'\n');await browser.close();}
}
if(stage==='after')for(const r of results){
  assert.equal(r.horizontalOverflow||r.dialogOverflow,false,`${r.width} ${r.name}: overflow`);
  assert.deepEqual(r.clipped,[],`${r.width} ${r.name}: clipped text or controls`);
  assert.deepEqual(r.tinyText,[],`${r.width} ${r.name}: text below 12px`);
  assert.deepEqual(r.smallTargets,[],`${r.width} ${r.name}: controls below 44px`);
  if(r.width<500)assert.deepEqual(r.smallInputs,[],`${r.width} ${r.name}: inputs below 16px`);
}
await writeFile(resolve(output,'RESULT.json'),JSON.stringify({status:'PASS',stage,scope:'Local Chrome author usability audit. Mocked wallet/read transport; no transactions or signatures. Contrast sampling excludes gradients/translucency; short viewport does not emulate an operating-system keyboard.',results},null,2)+'\n');
console.log(JSON.stringify({stage,scenarios:results.length,textBelow12:results.reduce((n,r)=>n+r.tinyText.length,0),controlsBelow44:results.reduce((n,r)=>n+r.smallTargets.length,0),horizontalOverflow:results.filter(r=>r.horizontalOverflow||r.dialogOverflow).length}));
