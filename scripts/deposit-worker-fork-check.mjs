// Exercise the compiled Worker and fresh D1 against a disposable local fork.
// Its placeholder HTTPS RPC is intercepted; no credential or signing key loads.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {createPublicClient,encodeFunctionData,http} from 'viem';
import {base} from 'viem/chains';
import {createServer} from 'vite';
const context=JSON.parse(await readFile(process.env.DEPOSIT_FORK_CONTEXT,'utf8')),out=process.env.DEPOSIT_FORK_OUTPUT??'/private/tmp/iaero-deposit-evidence-20261029',manifest=JSON.parse(await readFile('config/aero-deposit.json','utf8')),abi=JSON.parse(await readFile('config/aero-deposit.abi.json','utf8'));
for(const value of [context.forkUrl,context.readBridgeUrl])assert.equal(new URL(value).hostname,'127.0.0.1');
const rpc=async(method,params=[])=>{const reply=await fetch(context.forkUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(r=>r.json());if(reply.error)throw Error('Local fork setup failed: '+method);return reply.result;};
assert.match(await rpc('web3_clientVersion'),/anvil/i);await rpc('anvil_reset',[{forking:{jsonRpcUrl:context.readBridgeUrl,blockNumber:Number(context.forkBlock)}}]);
if(context.forkBlockHash)assert.equal((await rpc('eth_getBlockByNumber',['0x'+BigInt(context.forkBlock).toString(16),false])).hash,context.forkBlockHash);
await rpc('evm_setNextBlockTimestamp',[Math.floor(Date.now()/1000)]);await rpc('evm_mine');
// Anvil's finalized tag trails by 64 blocks. Advance empty local blocks at the
// same timestamp so the production freshness guard sees the local fork clock.
await rpc('anvil_mine',['0x40','0x0']);
// A cold Anvil fetches hundreds of historic token-registry storage slots from
// its upstream. Warm that fork cache outside the production 20s RPC deadline;
// the unmodified compiled Worker still runs with its normal deadline below.
const warm=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:[]}});
try{const {inspectBootstrap}=await warm.ssrLoadModule('/server/bootstrap.ts'),client=createPublicClient({chain:base,batch:{multicall:{batchSize:16384,wait:0}},transport:http(context.forkUrl,{timeout:180000,retryCount:0}),ccipRead:false}),proof=await inspectBootstrap([client]);assert.equal(proof.deposit.verified,true);assert.equal(proof.legacyReady,true);assert.equal(proof.sweepReady,true);}finally{await warm.close();}
const methods=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getCode','eth_getBalance','eth_call','eth_getStorageAt','eth_estimateGas']),readRequests=[],rpcFailures=[];
const mf=new Miniflare({modules:true,scriptPath:resolve('.release/pages/_worker.js'),compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],host:'127.0.0.1',port:0,log:new Log(LogLevel.NONE),d1Databases:{YIELD_DB:'deposit-fork-only'},d1Persist:await mkdtemp(join(tmpdir(),'iaero-deposit-worker-')),bindings:{BASE_READ_RPC_URLS:'["https://base-mainnet.g.alchemy.com/credential-free-test-placeholder"]',APP_ALLOWED_ORIGINS:'["https://app.iaero.finance"]'},outboundService:async request=>{
 assert.equal(new URL(request.url).hostname,'base-mainnet.g.alchemy.com');const body=await request.text(),calls=JSON.parse(body);for(const c of Array.isArray(calls)?calls:[calls]){assert(methods.has(c.method),'Only read methods may leave the Worker');readRequests.push(c.method);}const response=await fetch(context.forkUrl,{method:'POST',headers:{'content-type':'application/json'},body}),reply=await response.json();for(const r of Array.isArray(reply)?reply:[reply])if(r.error)rpcFailures.push(r.error);return new Response(JSON.stringify(reply),{status:response.status,headers:{'content-type':'application/json'}});
}});
const checks=[],origin='https://app.iaero.finance',record=name=>checks.push({name,pass:true});await mkdir(out,{recursive:true});
try{
 const db=await mf.getD1Database('YIELD_DB');for(const migration of ['0001_yield.sql','0002_claim_assessments.sql','0003_bootstrap_cache.sql'])for(const statement of (await readFile('worker/migrations/'+migration,'utf8')).split(/;\s*\n/).filter(s=>s.trim()))await db.exec(statement+';');
 const response=await mf.dispatchFetch(origin+'/api/contracts');if(response.status!==200)throw Error('Worker bootstrap '+response.status+': '+(await response.text())+'; read methods='+readRequests.join(','));const boot=await response.json();if(!boot.deposit?.verified)await writeFile(out+'/WORKER_BOOTSTRAP_DIAGNOSTIC.json',JSON.stringify({boot,rpcFailures},null,2)+'\n');assert.equal(boot.deposit.verified,true);assert.equal(boot.deposit.address.toLowerCase(),manifest.address.toLowerCase());assert.equal(boot.deposit.open,false);assert(boot.deposit.issues.some(i=>Number(i.reason)===2));assert.equal(boot.newStackReady,false);for(const key of ['legacyReady','oldAutoReady','liqStakingReady','sweepReady','marketRouteReady','aeroCompoundReady'])assert.equal(boot[key],true,key);record('compiled Worker independently connects the real deployed deposit while preserving every existing route');
 assert.equal(boot.metrics.protocolBacking.complete,true);assert.equal(boot.metrics.protocolBacking.scope,'primary-and-vault');assert(BigInt(boot.metrics.protocolBacking.totalAero)>=BigInt(boot.metrics.backingAero));record('compiled TVL and backing response includes the verified vault census');
 const count=readRequests.length,cached=await mf.dispatchFetch(origin+'/api/contracts');assert.equal(cached.status,200);assert.deepEqual(await cached.json(),boot);assert.equal(readRequests.length,count);record('shared bootstrap serialization and cache retain the same verified proof with no duplicate RPC');
 const call=await mf.dispatchFetch(origin+'/api/base',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_call',params:[{to:manifest.address,data:encodeFunctionData({abi,functionName:'checkAeroDeposit',args:['0x0000000000000000000000000000000000000000',10n**18n]})},'latest']})});assert.equal(call.status,200);assert.match((await call.json()).result,/^0x[0-9a-f]+$/);record('the public read proxy supports actual deposit previews and refusal reads');
 const blocked=await mf.dispatchFetch(origin+'/api/base',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:3,method:'eth_sendRawTransaction',params:['0x']})});assert.equal(blocked.status,400);assert(readRequests.every(m=>methods.has(m)));record('transaction broadcast remains blocked at the production read proxy');
 const result={status:'PASS',sourceCommit:process.env.DEPOSIT_SOURCE_COMMIT??null,forkBlock:context.forkBlock,checks,readRequests:readRequests.length,actualMainnetTransactions:0,scope:'Compiled production Worker with unmodified 20s RPC deadline; local D1 and warmed deployed fork state. Local clock and 64 empty blocks advanced for Anvil finality; Safe go-live not executed.'};await writeFile(out+'/COMPILED_WORKER_FORK.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks:checks.length,readRequests:readRequests.length}));
}finally{await mf.dispose();}
