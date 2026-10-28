import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {createPublicClient,http,parseAbi} from 'viem';
import {base} from 'viem/chains';

const origin=process.env.PREVIEW_URL??'http://127.0.0.1:4318';assert.equal(new URL(origin).hostname,'127.0.0.1');
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try{
  const response=await fetch(origin+'/api/contracts'),boot=await response.json();assert.equal(response.status,200);assert.equal(boot.sweepReady,true);
  const client=createPublicClient({chain:base,transport:http(origin+'/api/base',{retryCount:0}),ccipRead:false});
  const {buildSweepPreview,simulateSweepBatch,SWEEP_ABI,swapStep,SWEEP_GAS_LIMIT}=await server.ssrLoadModule('/src/live/sweep.ts');
  const abi=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)']);
  const user=boot.metrics.protocolNftOwner,swapper=boot.registry.sweep.swapper;
  const balance=token=>client.readContract({address:token,abi,functionName:'balanceOf',args:[user]});
  const allowance=token=>client.readContract({address:token,abi,functionName:'allowance',args:[user,swapper]});
  const localFetch=(path,options)=>fetch(new URL(path,origin),options);
  const weth={token:boot.registry.legacy.WETH,symbol:'WETH',decimals:18,amount:100000000000000n};
  assert.ok(await balance(weth.token)>=weth.amount);
  const candidates=boot.registry.knownLegacyRewardTokens.filter(t=>![boot.registry.legacy.USDC,weth.token,'0x0000000000000000000000000000000000000000'].some(a=>a.toLowerCase()===t.address.toLowerCase())).sort((a,b)=>(b.symbol==='LIQ'?1:0)-(a.symbol==='LIQ'?1:0));
  let preview;
  for(const token of candidates){
    const available=await balance(token.address);if(!available)continue;
    const reference=10n**BigInt(token.decimals),amount=available<reference?available:reference;
    const checked=await buildSweepPreview(client,boot,user,[weth,{token:token.address,symbol:token.symbol,decimals:token.decimals,amount}],'USDC',100,localFetch);
    if(checked.quotes.length===2){preview=checked;break;}
  }
  assert.ok(preview,'Two funded, quoteable public token balances are required for this fixture.');
  const before=await Promise.all(preview.inputs.map(async row=>({balance:await balance(row.token),allowance:await allowance(row.token)})));
  await simulateSweepBatch(client,boot,user,preview.quotes,preview.slippageBps,preview.quotes,true);
  const after=await Promise.all(preview.inputs.map(async row=>({balance:await balance(row.token),allowance:await allowance(row.token)})));
  assert.deepEqual(after,before,'Read-only simulation changed no balances or allowances.');
  let gasEstimate='NOT_RUN_NEEDS_ACTUAL_ALLOWANCES';
  if(before.every((state,i)=>state.allowance>=preview.inputs[i].amount)){
    const plan=preview.quotes.map(q=>swapStep(q,q,boot,preview.slippageBps));
    const gas=await client.estimateContractGas({address:swapper,abi:SWEEP_ABI,functionName:'executePlanFromCallerAdvanced',args:[plan,user,{minTotalOut:preview.minimumOutput,allowPartial:false}],account:user,gas:SWEEP_GAS_LIMIT});
    assert.ok((gas*130n+99n)/100n<=SWEEP_GAS_LIMIT);gasEstimate='PASS';
  }
  const out='artifacts/batch-readback';await mkdir(out,{recursive:true});
  const result={status:'PASS',checkedAt:new Date().toISOString(),scope:'Actual two-token approval-plus-combined-swap eth_simulateV1 using existing public Safe balances. No Safe owner signatures or owner-wallet acceptance, balance/storage/code overrides, actual approvals or transactions.',simulationProviders:1,bootstrapProviders:boot.snapshot.independentProviders,caller:user,tokens:preview.inputs,minimumOutput:preview.minimumOutput,balancesAndAllowancesUnchanged:true,actualBatchGasEstimate:gasEstimate,realTransactionPerformed:false};
  await writeFile(out+'/RESULT.json',JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
  console.log(JSON.stringify({status:'PASS',tokens:preview.inputs.map(t=>t.symbol),combinedSimulation:'PASS',actualBatchGasEstimate:gasEstimate,balancesAndAllowancesUnchanged:true,realTransactionPerformed:false}));
}catch{console.error('Read-only two-token batch check did not pass. No transaction was sent.');process.exitCode=1;}finally{await server.close();}
