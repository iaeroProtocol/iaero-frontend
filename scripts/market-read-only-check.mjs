import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4318';assert.equal(new URL(origin).hostname,'127.0.0.1');
const response=await fetch(origin+'/api/contracts'),boot=await response.json(),market=boot.metrics?.market;
assert.equal(response.status,200);assert.ok(market);assert.equal(market.readProviders,2);assert.equal(market.asOfBlock,boot.snapshot.block);
for(const field of ['aeroPriceUsdcWad','iaeroPegWad','tvlUsdcWad','liqPriceUsdcWad','liqMarketCapUsdcWad'])assert.ok(market[field]!==null&&BigInt(market[field])>0n,field+' unavailable: '+JSON.stringify(market.errors));
assert.equal(BigInt(market.tvlUsdcWad),BigInt(boot.metrics.backingAero)*BigInt(market.aeroPriceUsdcWad)/10n**18n);
assert.equal(BigInt(market.liqMarketCapUsdcWad),BigInt(market.liqCirculatingSupply)*BigInt(market.liqPriceUsdcWad)/10n**BigInt(market.liqDecimals));
assert.equal(BigInt(market.liqCirculatingSupply),BigInt(market.liqTotalSupply)-BigInt(market.liqUnvested)-BigInt(market.liqTreasuryBalance));
const cases=[{symbol:'VVV',pattern:/^0xacfe.*21bf$/i,amount:'208984759204'},{symbol:'wstETH',pattern:/^0xc1cb.*e452$/i,amount:'388395575'}],quotes=[];
for(const input of cases){
  const matches=boot.rewardTokenAddresses.filter(a=>input.pattern.test(a));assert.equal(matches.length,1);
  const token=matches[0],params=new URLSearchParams({sellToken:token,sellAmount:input.amount,slippageBps:'100'});
  const r=await fetch(origin+'/api/sweep/quote?'+params),data=await r.json();assert.equal(r.status,422);assert.equal(data.code,'NO_ROUTE_FOR_AMOUNT');
  quotes.push({symbol:input.symbol,token,amount:input.amount,status:r.status,code:data.code});
}
const result={status:'PASS',at:new Date().toISOString(),scope:'Actual finalized two-provider pool types, token pairs, reserves, decimals, total supply, actual vesting streams, treasury exclusions and protocol-NFT backing. Exact user amount no-route responses. No signatures or transactions.',snapshot:boot.snapshot,market,sourcePools:{aeroUsdc:boot.registry.sweep.aeroUsdcPool,iaeroAero:boot.registry.sweep.aeroIaeroPool,liqUsdc:boot.registry.marketData.liqUsdcPool},exactAmountCases:quotes,realTransactionPerformed:false};
await mkdir('artifacts/market-readback',{recursive:true});await writeFile('artifacts/market-readback/RESULT.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:'PASS',market,quoteReasons:quotes.map(q=>({symbol:q.symbol,code:q.code})),realTransactionPerformed:false}));
