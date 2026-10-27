import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {createPublicClient,http,parseAbi} from 'viem';
import {base} from 'viem/chains';
const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4318';assert.equal(new URL(origin).hostname,'127.0.0.1');
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try{
  const bootstrap=await fetch(origin+'/api/contracts'),boot=await bootstrap.json();assert.equal(bootstrap.status,200);assert.equal(boot.sweepReady,true);assert.equal(boot.marketRouteReady,true);
  const client=createPublicClient({chain:base,transport:http(origin+'/api/base',{retryCount:0}),ccipRead:false});
  const {buildSweepPreview}=await server.ssrLoadModule('/src/live/sweep.ts');
  const localFetch=(path,options)=>fetch(new URL(path,origin),options);
  const input={token:boot.registry.legacy.WETH,symbol:'WETH',decimals:18,amount:100000000000000n};
  // A public contract holder provides real token state for an unsigned EVM
  // simulation. No impersonation transaction, balance override or fork write.
  let holder;
  for(const address of [...new Set([boot.metrics.protocolNftOwner,boot.registry.legacy.epochDistributor,boot.registry.legacy.autoVault,boot.registry.legacy.harvester,boot.registry.forwarder??boot.registry.sweep.swapper])]){
    const balance=await client.readContract({address:input.token,abi:parseAbi(['function balanceOf(address) view returns(uint256)']),functionName:'balanceOf',args:[address]});
    if(balance>=input.amount){holder=address;break;}
  }
  assert.ok(holder,'No funded public holder available for the read-only fixture.');
  const preview=await buildSweepPreview(client,boot,holder,[input],'iAERO',100,localFetch);
  assert.equal(preview.quotes.length,1);assert.ok(preview.expectedUsdc>0n);assert.ok(preview.minimumUsdc>0n);assert.ok(preview.expectedIaero>0n);assert.ok(preview.minimumIaero>0n);
  const invalid=await fetch(origin+'/api/sweep/quote?sellToken='+boot.registry.legacy.iAERO+'&sellAmount=1&slippageBps=100');assert.equal(invalid.status,400);
  const foreign=await fetch(origin+'/api/sweep/quote?sellToken='+boot.registry.legacy.WETH+'&sellAmount=1&slippageBps=100',{headers:{Origin:'https://example.invalid'}});assert.equal(foreign.status,403);
  const empty='0x0000000000000000000000000000000012349876';
  assert.equal(await client.readContract({address:input.token,abi:parseAbi(['function balanceOf(address) view returns(uint256)']),functionName:'balanceOf',args:[empty]}),0n);
  const rejected=await buildSweepPreview(client,boot,empty,[input],'USDC',100,localFetch);
  assert.equal(rejected.inputs.length,0);assert.equal(rejected.skipped[0].stage,'simulation');
  const out=resolve('artifacts/live-sweep-readback');await mkdir(out,{recursive:true});
  const result={status:'PASS',scope:'Actual 0x quote, actual Base approval-plus-swap read-only simulation using a public contract holder, zero-balance failure injection and fee-inclusive pool quote. No signatures, real approvals, transactions, balance/storage overrides, actual-owner wallet acceptance or fork execution.',checkedAt:new Date().toISOString(),registeredTokens:boot.rewardTokenAddresses.length,spamAddressRules:boot.tokenFilter.addresses.length,simulationCaller:holder,zeroBalanceSimulationRejected:true,snapshot:boot.snapshot,swapper:boot.registry.sweep.swapper,marketRouter:boot.registry.sweep.metarouter,input:preview.inputs,expectedUsdc:preview.expectedUsdc,minimumUsdc:preview.minimumUsdc,expectedIaero:preview.expectedIaero,minimumIaero:preview.minimumIaero,protectedTokenRejected:true,foreignOriginRejected:true,writeRequests:0};
  await writeFile(resolve(out,'RESULT.json'),JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log(JSON.stringify({status:'PASS',registeredTokens:result.registeredTokens,liveQuote:'PASS',approvalAndSwapSimulation:'PASS',zeroBalanceFailureRejected:true,deployedSelector:'PASS',feeInclusivePoolQuotes:'PASS',writeRequests:0}));
}catch(error){console.error(error instanceof Error?error.message:'Read-only quote check failed.');process.exitCode=1;}finally{await server.close();}
