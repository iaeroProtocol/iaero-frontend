import {quoteIaeroRoute,quoteAeroIaeroRoute,encodeAeroIaeroRoute} from './iaero-route';
import {decodeEventLog,decodeFunctionResult,encodeAbiParameters,encodeFunctionData,formatUnits,isAddress,parseAbi,type Address,type Hash} from 'viem';
import {STAKING_ERC20_ABI} from '../protocol/streamingClient';
import type {Activity} from '../domain';
import {createGuardedSender,publicError,tokenMetadata,type BaseClient,type ExecutionContext} from './client';
import type {Bootstrap} from './types';
import {spamReason} from './token-filter';
import type {RewardTokenValue} from './reward-value';
import {mapReadBatches} from './read-concurrency';
import {accountReadClient} from './account-read-client';
import {SWEEP_GAS_LIMIT,SWEEP_MAX_RETRIES,retrySlippage,retryGas,contractReverted,retryReadClient,verifiedRevertedAttempt,SweepPreflightRevert,type SweepRetryPolicy,type SweepRetryEvent} from './sweep-retries';
export {SWEEP_GAS_LIMIT} from './sweep-retries';

// [VERIFIED: integration/legacy/RewardSwapper.sol, PullStep and ExecOpts]
export const SWEEP_ABI=parseAbi([
  'function executePlanFromCallerAdvanced((uint8 kind,address tokenIn,address outToken,bool useAll,uint256 amountIn,uint256 quotedIn,uint256 quotedOut,uint16 slippageBps,bytes data,bool viaPermit2,bytes permitSig,uint256 permitAmount,uint256 permitDeadline,uint256 permitNonce)[] plan,address recipient,(uint256 minTotalOut,bool allowPartial) opts) returns(uint256)',
  'function agg0x() view returns(address)','function allowedSelectors(address,bytes4) view returns(bool)','function dustFloor(address) view returns(uint256)',
  'event SwapExecuted(uint8 kind,address indexed tokenIn,address indexed outToken,uint256 inAmt,uint256 outAmt)',
]);
export const POOL_ABI=parseAbi(['function getAmountOutWithTotalFee(uint256,address) view returns(uint256)']);
export const METAROUTER_ABI=parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable']);
export const TRANSFER_ABI=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
export const LEGACY_DEPOSIT_ABI=parseAbi(['function stake(uint256)','function paused() view returns(bool)']);
export const ROUTE_PARAMS=[{type:'tuple',components:[{name:'pools',type:'address[]'},{name:'tokenIn',type:'address'},{name:'amountIn',type:'tuple',components:[{name:'mode',type:'uint8'},{name:'value',type:'uint256'}]},{name:'payerIsUser',type:'bool'},{name:'minAmountOut',type:'uint256'},{name:'recipient',type:'address'}]}] as const;
export type SweepMode='USDC'|'iAERO'|'stake';
export type SweepToken={token:Address;symbol:string;decimals:number|null;balance:bigint};
export const SWEEP_BATCH_LIMIT=10; // [VERIFIED: existing RewardsSection execution batch; swapper MAX_STEPS=32]
export function orderSweepTokens(tokens:readonly SweepToken[],values:Record<string,RewardTokenValue>={}){
  const value=(t:SweepToken)=>{const q=values[t.token.toLowerCase()];return q?.amount===t.balance?q.valueWad:null;};
  return [...tokens].sort((a,b)=>{
    const av=value(a),bv=value(b);
    if(av!==null&&bv===null)return -1;if(av===null&&bv!==null)return 1;
    if(av!==null&&bv!==null&&av!==bv)return av>bv?-1:1;
    return a.symbol.localeCompare(b.symbol)||a.token.toLowerCase().localeCompare(b.token.toLowerCase());
  });
}
export type SweepInput=Omit<SweepToken,'balance'>&{amount:bigint};
export type SweepQuote={input:SweepInput;outToken:Address;buyAmount:bigint;minimum:bigint;to:Address;data:`0x${string}`;quotedAt:number;retryLevel?:number};
export type SweepSkipped={input:SweepInput;stage:'filter'|'quote'|'simulation'|'batch';reason:string};
export type HiddenSweepToken=SweepToken&{reason:string};
export type SweepPreview={user:Address;mode:SweepMode;outToken:Address;slippageBps:number;inputs:SweepInput[];quotes:SweepQuote[];skipped:SweepSkipped[];existingOutput:bigint;expectedOutput:bigint;minimumOutput:bigint;expectedIaero?:bigint;minimumIaero?:bigint;quotedAt:number;retry?:SweepRetryPolicy};
export type SweepResult={hashes:Hash[];outToken:Address;outputAmount:bigint;iaero:bigint;staked:bigint;swapped:number;batches:number;skipped:SweepSkipped[];conversionDeferred?:string;stakingDeferred?:string};
export type SweepHooks={onProgress?:(text:string)=>void;onConfirmed?:(activity:Activity)=>void;onRetry?:(event:SweepRetryEvent)=>void;shouldStop?:()=>boolean};
const equal=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const minimum=(amount:bigint,bps:number)=>amount*BigInt(10000-bps)/10000n;
const validAmount=(amount:bigint)=>amount>0n&&amount<2n**256n;
export function sweepOutput(boot:Bootstrap,mode:SweepMode){return mode==='USDC'?{token:boot.registry.legacy.USDC,symbol:'USDC',decimals:6}:{token:boot.registry.aero.token,symbol:'AERO',decimals:18};}
export function validateSweepInputs(boot:Bootstrap,rows:readonly SweepInput[],mode:SweepMode){
  if(!boot.sweepReady)throw Error('The deployed reward swapper has not been verified.');
  if(mode!=='USDC'&&!boot.aeroCompoundReady)throw Error('The new AERO output permission and iAERO compound route have not been verified. Refresh before compounding.');
  if(!['USDC','iAERO','stake'].includes(mode)||!rows.length||rows.length>512)throw Error('Choose between 1 and 512 tokens to sweep.');
  const seen=new Set<string>();
  for(const row of rows){
    if(!isAddress(row.token)||BigInt(row.token)===0n||!validAmount(row.amount))throw Error('A selected token or amount is invalid.');
    if([boot.registry.legacy.iAERO,boot.registry.legacy.stiAERO].some(a=>equal(a,row.token)))throw Error('iAERO principal and staking receipts are excluded from reward sweeps.');
    if(mode==='USDC'&&equal(row.token,boot.registry.legacy.USDC))throw Error('USDC is already the output token.');
    const key=row.token.toLowerCase();if(seen.has(key))throw Error('A token was selected more than once.');seen.add(key);
  }
}
export async function scanSweepWallet(client:BaseClient,boot:Bootstrap,user:Address,additional:Address[]=[]){
  if(!boot.sweepReady)throw Error('The deployed reward swapper has not been verified.');
  if(!boot.tokenFilter)throw Error('The token filter is unavailable. Refresh before sweeping.');
  const addresses=[...new Map([...boot.registry.knownLegacyRewardTokens.map(t=>t.address),...(boot.rewardTokenAddresses??[]),...additional].map(a=>[a.toLowerCase(),a])).values()]
    .filter(a=>BigInt(a)!==0n&&![boot.registry.legacy.iAERO,boot.registry.legacy.stiAERO].some(p=>equal(a,p)));
  const block=await client.getBlock();
  const results=await client.multicall({multicallAddress:boot.registry.sweep.multicall3,allowFailure:true,batchSize:4096,blockNumber:block.number,contracts:addresses.map(address=>({address,abi:STAKING_ERC20_ABI,functionName:'balanceOf',args:[user]} as const))});
  const tokens:SweepToken[]=[],errors:string[]=[],metadataClient=accountReadClient(client,boot);
  await mapReadBatches(results,async(result,i)=>{
    if(result.status!=='success'){errors.push('Balance unavailable for '+addresses[i]);return;}
    const balance=BigInt(result.result);if(balance<=0n)return;
    const meta=await tokenMetadata(metadataClient,addresses[i]);tokens.push({token:addresses[i],balance,...meta});
  });
  const visible:SweepToken[]=[],hidden:HiddenSweepToken[]=[];
  for(const token of tokens.sort((a,b)=>a.symbol.localeCompare(b.symbol)||a.token.localeCompare(b.token))){
    const reason=spamReason(boot.tokenFilter,token.token,token.symbol);
    if(reason)hidden.push({...token,reason});else visible.push(token);
  }
  return {tokens:visible,hidden,errors,tokenCount:addresses.length};
}
export async function fetchSweepQuote(client:BaseClient,boot:Bootstrap,input:SweepInput,slippageBps:number,fetcher:typeof fetch=fetch,outToken:Address=boot.registry.legacy.USDC):Promise<SweepQuote>{
  if(![boot.registry.legacy.USDC,boot.registry.aero.token].some(t=>equal(t,outToken))||equal(input.token,outToken))throw Error('The requested sweep output is invalid.');
  const outputSymbol=equal(outToken,boot.registry.legacy.USDC)?'USDC':'AERO';
  const params=new URLSearchParams({sellToken:input.token,sellAmount:input.amount.toString(),slippageBps:String(slippageBps),buyToken:outToken});
  const response=await fetcher('/api/sweep/quote?'+params,{cache:'no-store'});
  if(!response.ok){
    let code='';try{code=String((await response.json()).code??'');}catch{}
    const reasons:Record<string,string>={
      NO_ROUTE_FOR_AMOUNT:`0x returned no executable ${outputSymbol} route for this amount of ${input.symbol}. Very small balances may still have an indicative price.`,
      RATE_LIMITED:`The 0x quote service is rate limited. Wait and retry ${input.symbol}.`,
      QUOTE_AUTHENTICATION:'The quote service authentication needs attention.',
      QUOTE_ACCESS_DENIED:`The quote service refused this request for ${input.symbol}.`,
      QUOTE_SERVICE_UNAVAILABLE:`The 0x quote service is temporarily unavailable. Retry ${input.symbol} later.`,
      TOKEN_NOT_SUPPORTED:`0x does not currently support ${input.symbol} for this trade.`,
      QUOTE_REQUEST_REJECTED:`The quote service rejected the token or amount for ${input.symbol}.`,
      INVALID_EXECUTABLE_QUOTE:`The service returned an invalid executable quote for ${input.symbol}.`
    };
    throw Error(reasons[code]??(response.status===429?reasons.RATE_LIMITED:`The live quote request failed for ${input.symbol}. Retry later.`));
  }
  const q=await response.json(),s=boot.registry.sweep.swapper;
  if(!q.transaction||!isAddress(q.transaction.to)||!/^0x[0-9a-f]{8,}$/i.test(q.transaction.data)||BigInt(q.transaction.value??'0')!==0n||!equal(q.sellToken??'',input.token)||!equal(q.buyToken??'',outToken)||!equal(q.taker??'',s)||!equal(q.recipient??'',s)||BigInt(q.sellAmount??'0')!==input.amount||!validAmount(BigInt(q.buyAmount??'0')))throw Error('The live quote does not match the reviewed token, amount or recipient.');
  // [VERIFIED: RewardSwapper._executeOne] Check the actual deployed router and
  // selector before asking for an approval. The user only approves RewardSwapper.
  const [router,allowed,floor]=await Promise.all([
    client.readContract({address:s,abi:SWEEP_ABI,functionName:'agg0x'}),
    client.readContract({address:s,abi:SWEEP_ABI,functionName:'allowedSelectors',args:[q.transaction.to,q.transaction.data.slice(0,10)]}),
    client.readContract({address:s,abi:SWEEP_ABI,functionName:'dustFloor',args:[input.token]})
  ]);
  if(!equal(router,q.transaction.to)||!allowed)throw Error('The deployed swapper does not permit this quote router or selector.');
  if(input.amount<floor)throw Error(`${input.symbol} is below the swapper's on-chain minimum. It remains in your wallet.`);
  const buyAmount=BigInt(q.buyAmount),bound=minimum(buyAmount,slippageBps);
  if(bound<=0n)throw Error(`${input.symbol} has no positive minimum ${outputSymbol} output at this amount.`);
  if(!Number.isSafeInteger(q.quotedAt)||Date.now()-q.quotedAt>120000||q.quotedAt>Date.now()+5000)throw Error('The live quote is stale. Refresh to retry.');
  return {input,outToken,buyAmount,minimum:bound,to:q.transaction.to,data:q.transaction.data,quotedAt:Number(q.quotedAt)};
}
export async function simulateSweepBatch(client:BaseClient,boot:Bootstrap,user:Address,quotes:SweepQuote[],slippageBps:number,reviews=quotes,withApprovals=false){
  if(!quotes.length||quotes.length>SWEEP_BATCH_LIMIT||reviews.length!==quotes.length||quotes.some(q=>!equal(q.outToken,quotes[0].outToken)))throw Error('Invalid sweep simulation batch.');
  const swapper=boot.registry.sweep.swapper,plan=quotes.map((q,i)=>swapStep(q,reviews[i],boot,slippageBps));
  const calls:{to:Address;data:`0x${string}`;account:Address;gas:bigint}[]=[];
  const add=(to:Address,data:`0x${string}`)=>calls.push({to,data,account:user,gas:SWEEP_GAS_LIMIT});
  if(withApprovals)for(const {input} of reviews){
    const allowance=await client.readContract({address:input.token,abi:STAKING_ERC20_ABI,functionName:'allowance',args:[user,swapper]});
    if(allowance<input.amount){
      if(allowance>0n)add(input.token,encodeFunctionData({abi:STAKING_ERC20_ABI,functionName:'approve',args:[swapper,0n]}));
      add(input.token,encodeFunctionData({abi:STAKING_ERC20_ABI,functionName:'approve',args:[swapper,input.amount]}));
    }
  }
  const floor=reviews.reduce((sum,q)=>sum+q.minimum,0n);
  add(swapper,encodeFunctionData({abi:SWEEP_ABI,functionName:'executePlanFromCallerAdvanced',args:[plan,user,{minTotalOut:floor,allowPartial:false}]}));
  // [VERIFIED: viem 2.36 simulateBlocks; eth_simulateV1 on configured Base RPC]
  // Approvals and the exact pull/swap share simulated state only. No allowance,
  // balance, code or storage override is fabricated, and no transaction is sent.
  const blocks=await client.simulateBlocks({blocks:[{calls}],validation:false,blockTag:'latest'});
  const results=blocks[0]?.calls;
  if(blocks.length!==1||!results||results.length!==calls.length)throw Error('The swap simulation response is unavailable.');
  if(results.slice(0,-1).some(r=>r.status!=='success'))throw Error('Token approval simulation failed. This token will stay in your wallet.');
  if(results.at(-1)?.status!=='success')throw new SweepPreflightRevert('Swap simulation failed. This token will stay in your wallet.');
  for(const result of results.slice(0,-1))if(result.data!=='0x'&&decodeFunctionResult({abi:STAKING_ERC20_ABI,functionName:'approve',data:result.data})!==true)throw Error('Token approval simulation failed. This token will stay in your wallet.');
  const trade=results[results.length-1],output=decodeFunctionResult({abi:SWEEP_ABI,functionName:'executePlanFromCallerAdvanced',data:trade.data});
  if(output<floor)throw Error('The simulated swap is below your minimum output.');
  receiptOutput(trade.logs??[],boot,reviews);
}
export async function simulateSweepQuote(client:BaseClient,boot:Bootstrap,user:Address,quote:SweepQuote,slippageBps:number,review=quote,withApprovals=true){
  await simulateSweepBatch(client,boot,user,[quote],slippageBps,[review],withApprovals);
}
export async function quoteIaero(client:BaseClient,boot:Bootstrap,usdc:bigint){
 return (await quoteIaeroRoute(client,boot,usdc)).output;
}
export async function buildSweepPreview(client:BaseClient,boot:Bootstrap,user:Address,inputs:SweepInput[],mode:SweepMode,slippageBps:number,fetcher:typeof fetch=fetch,onProgress?:(checked:number,total:number)=>void,automaticRetries=false):Promise<SweepPreview>{
  validateSweepInputs(boot,inputs,mode);
  const output=sweepOutput(boot,mode);
  if(!boot.tokenFilter)throw Error('The token filter is unavailable. Refresh before sweeping.');
  if(!Number.isInteger(slippageBps)||slippageBps<10||slippageBps>500)throw Error('Choose slippage from 0.1% to 5%.');
  const checks:Array<{input:SweepInput;quote?:SweepQuote;skipped?:SweepSkipped}>=new Array(inputs.length);
  let next=0,checked=0;
  await Promise.all(Array.from({length:Math.min(3,inputs.length)},async()=>{
    while(next<inputs.length){
      const index=next++,input=inputs[index];let stage:SweepSkipped['stage']='filter';
      try{
        const reason=spamReason(boot.tokenFilter,input.token,input.symbol);if(reason)throw Error(reason);
        stage='simulation';
        if(equal(input.token,output.token)){
          const balance=await client.readContract({address:input.token,abi:STAKING_ERC20_ABI,functionName:'balanceOf',args:[user]});
          if(input.amount>balance)throw Error(output.symbol+' balance changed. Choose an amount within your wallet balance.');
          checks[index]={input};
        }else{
          let quote:SweepQuote|undefined;
          for(let attempt=0;attempt<=(automaticRetries?SWEEP_MAX_RETRIES:0);attempt++){
            const bps=retrySlippage(slippageBps,attempt);stage='quote';quote=await fetchSweepQuote(client,boot,input,bps,fetcher,output.token);
            stage='simulation';try{await simulateSweepQuote(client,boot,user,quote,bps);quote={...quote,...(attempt?{retryLevel:attempt}:{})};break;}
            catch(error){if(!(error instanceof SweepPreflightRevert)||!automaticRetries||attempt===SWEEP_MAX_RETRIES)throw error;}
          }
          if(!quote)throw Error('No executable reward quote.');
          checks[index]={input,quote};
        }
      }catch(error){checks[index]={input,skipped:{input,stage,reason:stage==='simulation'?'Swap simulation did not pass. This token stays in your wallet.':publicError(error)}};}
      onProgress?.(++checked,inputs.length);
    }
  }));
  const accepted=checks.filter(c=>!c.skipped),quotes=accepted.flatMap(c=>c.quote?[c.quote]:[]),skipped=checks.flatMap(c=>c.skipped?[c.skipped]:[]);
  const existingOutput=accepted.filter(c=>equal(c.input.token,output.token)).reduce((sum,c)=>sum+c.input.amount,0n);
  const expectedOutput=quotes.reduce((sum,q)=>sum+q.buyAmount,existingOutput),minimumOutput=quotes.reduce((sum,q)=>sum+q.minimum,existingOutput);
  if(expectedOutput>=2n**256n||minimumOutput>=2n**256n)throw Error('The quote total exceeds the supported amount.');
  const preview:SweepPreview={user,mode,outToken:output.token,slippageBps,inputs:accepted.map(c=>c.input),quotes,skipped,existingOutput,expectedOutput,minimumOutput,quotedAt:Date.now()};
  if(automaticRetries){const maxSlippageBps=retrySlippage(slippageBps,SWEEP_MAX_RETRIES);preview.retry={maxRetries:SWEEP_MAX_RETRIES,maxSlippageBps,minimumOutputByAttempt:Array.from({length:SWEEP_MAX_RETRIES+1},(_,attempt)=>quotes.reduce((sum,q)=>sum+minimum(q.buyAmount,retrySlippage(slippageBps,Math.max(attempt,q.retryLevel??0))),existingOutput))};}
  if(mode!=='USDC'&&minimumOutput>0n){
    preview.expectedIaero=(await quoteAeroIaeroRoute(client,boot,expectedOutput)).output;
    const bounded=await quoteAeroIaeroRoute(client,boot,minimumOutput),slippageFloor=minimum(bounded.output,slippageBps);
    preview.minimumIaero=slippageFloor>bounded.costMinimum?slippageFloor:bounded.costMinimum;
    if(preview.minimumIaero<=0n)throw Error('The route has no positive minimum iAERO output.');
    if(preview.retry){const floors=[preview.minimumIaero];for(let attempt=1;attempt<=SWEEP_MAX_RETRIES;attempt++){const last=await quoteAeroIaeroRoute(client,boot,preview.retry.minimumOutputByAttempt[attempt]),floor=minimum(last.output,retrySlippage(slippageBps,attempt)),protectedFloor=floor>last.costMinimum?floor:last.costMinimum;floors.push(protectedFloor>floors.at(-1)!?floors.at(-1)!:protectedFloor);}preview.retry.minimumIaeroByAttempt=floors;}
  }
  return preview;
}
export function swapStep(quote:SweepQuote,review:SweepQuote,boot:Bootstrap,slippageBps:number){
  if(!equal(quote.input.token,review.input.token)||quote.input.amount!==review.input.amount||!equal(quote.outToken,review.outToken)||![boot.registry.legacy.USDC,boot.registry.aero.token].some(t=>equal(t,review.outToken)))throw Error('The quote does not match the reviewed input or output.');
  if(quote.buyAmount<review.minimum)throw new SweepPreflightRevert('The quote moved beyond your reviewed minimum. Refresh the preview.');
  return {kind:2,tokenIn:review.input.token,outToken:review.outToken,useAll:false,amountIn:review.input.amount,quotedIn:review.input.amount,quotedOut:review.buyAmount,slippageBps,data:encodeAbiParameters([{type:'address'},{type:'bytes'}],[quote.to,quote.data]),viaPermit2:false,permitSig:'0x' as const,permitAmount:0n,permitDeadline:0n,permitNonce:0n};
}
export function receiptOutput(logs:readonly any[],boot:Bootstrap,expected:readonly SweepQuote[]){
  if(!expected.length||expected.some(q=>!equal(q.outToken,expected[0].outToken)))throw Error('The receipt output does not match the reviewed batch.');
  const found=new Map<string,bigint>();
  for(const log of logs){if(!equal(log.address,boot.registry.sweep.swapper))continue;try{
    const decoded=decodeEventLog({abi:SWEEP_ABI,data:log.data,topics:log.topics});
    if(decoded.eventName==='SwapExecuted'&&equal(decoded.args.outToken,expected[0].outToken))found.set(decoded.args.tokenIn.toLowerCase(),(found.get(decoded.args.tokenIn.toLowerCase())??0n)+decoded.args.outAmt);
  }catch{}}
  for(const row of expected)if((found.get(row.input.token.toLowerCase())??0n)<row.minimum)throw Error('The confirmed trade output could not be reconciled. Review its receipt before continuing; no conversion or staking followed.');
  return expected.reduce((sum,q)=>sum+(found.get(q.input.token.toLowerCase())??0n),0n);
}
export function receiptIaero(logs:readonly any[],token:Address,user:Address){
  let received=0n;
  for(const log of logs){if(!equal(log.address,token))continue;try{const e=decodeEventLog({abi:TRANSFER_ABI,data:log.data,topics:log.topics});if(equal(e.args.to,user))received+=e.args.value;if(equal(e.args.from,user))received-=e.args.value;}catch{}}
  if(received<=0n)throw Error('The confirmed iAERO output could not be reconciled. Review the receipt; no staking followed.');return received;
}
export async function runSweep(context:ExecutionContext,preview:SweepPreview,hooks:SweepHooks={}):Promise<SweepResult>{
  const {client,state}=context,boot=state.boot!,user=state.address!;
  validateSweepInputs(boot,preview.inputs,preview.mode);
  const output=sweepOutput(boot,preview.mode);if(!equal(preview.outToken,output.token))throw Error('The reviewed output token changed. Refresh the preview.');
  for(const input of preview.inputs)if(spamReason(boot.tokenFilter,input.token,input.symbol))throw Error('A filtered token is not eligible for this sweep. Refresh your selection.');
  if(!Number.isInteger(preview.slippageBps)||preview.slippageBps<10||preview.slippageBps>500)throw Error('The reviewed slippage is invalid.');
  const expectedInputs=preview.inputs.filter(i=>!equal(i.token,output.token));
  const maxAttempt=preview.retry?SWEEP_MAX_RETRIES:0;
  if(preview.quotes.some(q=>!Number.isInteger(q.retryLevel??0)||(q.retryLevel??0)<0||(q.retryLevel??0)>maxAttempt))throw Error('The reviewed retry level is invalid.');
  if(expectedInputs.length!==preview.quotes.length||preview.quotes.some(q=>!equal(q.outToken,output.token))||expectedInputs.some(input=>preview.quotes.filter(q=>equal(q.input.token,input.token)&&q.input.amount===input.amount&&q.minimum===minimum(q.buyAmount,retrySlippage(preview.slippageBps,q.retryLevel??0))&&q.minimum>0n).length!==1))throw Error('The sweep quotes do not match the reviewed selection.');
  const selectedOutput=preview.inputs.filter(i=>equal(i.token,output.token)).reduce((sum,i)=>sum+i.amount,0n);
  if(preview.existingOutput!==selectedOutput||preview.minimumOutput!==preview.quotes.reduce((sum,q)=>sum+q.minimum,selectedOutput)||preview.expectedOutput!==preview.quotes.reduce((sum,q)=>sum+q.buyAmount,selectedOutput))throw Error('The reviewed output totals changed. Refresh the preview.');
  if(!validAmount(preview.expectedOutput)||!validAmount(preview.minimumOutput)||preview.mode!=='USDC'&&(!preview.expectedIaero||!preview.minimumIaero||!validAmount(preview.expectedIaero)||!validAmount(preview.minimumIaero)||preview.minimumIaero>preview.expectedIaero))throw Error('The reviewed minimum output is invalid.');
  if(preview.retry){const p=preview.retry;if(p.maxRetries!==SWEEP_MAX_RETRIES||p.maxSlippageBps!==retrySlippage(preview.slippageBps,SWEEP_MAX_RETRIES)||p.minimumOutputByAttempt.length!==SWEEP_MAX_RETRIES+1||p.minimumOutputByAttempt.some((v,n)=>v!==preview.quotes.reduce((sum,q)=>sum+minimum(q.buyAmount,retrySlippage(preview.slippageBps,Math.max(n,q.retryLevel??0))),selectedOutput))||preview.mode!=='USDC'&&(!p.minimumIaeroByAttempt||p.minimumIaeroByAttempt.length!==SWEEP_MAX_RETRIES+1||p.minimumIaeroByAttempt[0]!==preview.minimumIaero||p.minimumIaeroByAttempt.some((v,n)=>!validAmount(v)||n>0&&v>p.minimumIaeroByAttempt![n-1])))throw Error('The reviewed retry limits changed. Refresh the preview.');}
  if(!equal(preview.user,user)||state.chainId!==8453||!Number.isSafeInteger(preview.quotedAt)||Date.now()-preview.quotedAt>120000||preview.quotedAt>Date.now()+5000)throw Error('Wallet or quote changed. Refresh the sweep preview.');
  const stop=()=>{if(hooks.shouldStop?.())throw Error('Stopped before the next transaction. Confirmed steps remain in your wallet history.');};
  let batchGas:bigint|undefined,lastBroadcast:Hash|undefined,highestRetry=Math.max(0,...preview.quotes.map(q=>q.retryLevel??0));
  stop();const rawSend=await createGuardedSender({...context,client:retryReadClient(client),onBroadcast:hash=>{lastBroadcast=hash;context.onBroadcast(hash);}},()=>!hooks.shouldStop?.(),request=>['executePlanFromCallerAdvanced','execute','stake'].includes(request.functionName)?batchGas:undefined),hashes:Hash[]=[];
  const progress=(text:string)=>{context.onProgress?.(text);hooks.onProgress?.(text);};
  const send=async(address:Address,abi:readonly unknown[],name:string,args:readonly unknown[],title:string,token:string,amount:bigint,decimals:number|null=18)=>{
    stop();progress(title);lastBroadcast=undefined;const hash=await rawSend(address,abi,name,args);hashes.push(hash);
    const activity:Activity={id:hash,hash,title,token:name==='approve'?'':token,amount:name==='approve'?'Allowance only':decimals===null?amount.toString()+' raw units':formatUnits(amount,decimals),direction:name==='approve'?'out':'in',time:Date.now()};context.onConfirmed?.(activity);hooks.onConfirmed?.(activity);return hash;
  };
  const balance=async(token:Address)=>client.readContract({address:token,abi:STAKING_ERC20_ABI,functionName:'balanceOf',args:[user]});
  const approve=async(input:SweepInput,spender:Address)=>{
    stop();if(input.amount>await balance(input.token))throw Error(input.symbol+' balance changed. Refresh the selection.');
    const allowance=await client.readContract({address:input.token,abi:STAKING_ERC20_ABI,functionName:'allowance',args:[user,spender]});
    if(allowance>=input.amount)return;
    if(allowance>0n)await send(input.token,STAKING_ERC20_ABI,'approve',[spender,0n],'Reset '+input.symbol+' allowance',input.symbol,0n,input.decimals);
    await send(input.token,STAKING_ERC20_ABI,'approve',[spender,input.amount],'Approve exact '+input.symbol+' amount',input.symbol,input.amount,input.decimals);
  };
  let outputAmount=preview.existingOutput,iaero=0n,staked=0n,swapped=0,batches=0,runtimeSkipped=0;
  const skipped=preview.skipped.slice();
  const retrying=(stage:SweepRetryEvent['stage'],attempt:number,hash?:Hash)=>{stop();highestRetry=Math.max(highestRetry,attempt);const slippageBps=retrySlippage(preview.slippageBps,stage==='conversion'?highestRetry:attempt);hooks.onRetry?.({stage,attempt,slippageBps,hash});progress('Retry '+attempt+' of '+maxAttempt+' · '+stage+' · boosted gas'+(stage==='stake'?'':' · '+slippageBps/100+'% slippage')+'…');};
  const exhausted=(stage:SweepRetryEvent['stage'],attempt:number)=>hooks.onRetry?.({stage,attempt,slippageBps:retrySlippage(preview.slippageBps,attempt),hash:lastBroadcast,exhausted:true});
  const skip=(input:SweepInput,stage:SweepSkipped['stage'],error:unknown)=>{runtimeSkipped++;skipped.push({input,stage,reason:stage==='simulation'?'Swap simulation did not pass. This token stays in your wallet.':publicError(error)});progress('Skipped '+input.symbol+'; continuing with eligible tokens…');};
  const receiptFor=async(hash:Hash)=>{const receipt=await client.getTransactionReceipt({hash});if(receipt.transactionHash.toLowerCase()!==hash.toLowerCase()||receipt.status!=='success')throw Error('The confirmed receipt changed. Review it before continuing.');return receipt;};
  const refreshPassing=async(reviews:SweepQuote[],withApprovals:boolean,requestedAttempt=0)=>{
    const passing:{review:SweepQuote;fresh:SweepQuote;attempt:number}[]=[];
    for(const review of reviews){
      stop();progress('Checking '+review.input.symbol+(withApprovals?' before approval…':' for the next batch…'));
      for(let attempt=Math.max(requestedAttempt,review.retryLevel??0);attempt<=maxAttempt;attempt++){
        let stage:SweepSkipped['stage']='quote';const bps=retrySlippage(preview.slippageBps,attempt),bound={...review,minimum:minimum(review.buyAmount,bps)};
        try{const fresh=await fetchSweepQuote(client,boot,review.input,bps,fetch,output.token);swapStep(fresh,bound,boot,bps);
          stage='simulation';await simulateSweepQuote(client,boot,user,fresh,bps,bound,withApprovals);passing.push({review,fresh,attempt});break;
        }catch(error){stop();if(error instanceof SweepPreflightRevert&&attempt<maxAttempt){retrying('swap',attempt+1);continue;}skip(review.input,stage,error);break;}
      }
    }
    return passing;
  };
  const executeBatch=async(reviews:SweepQuote[],requestedAttempt=0,previousGas=0n):Promise<void>=>{
    stop();const passing=await refreshPassing(reviews,false,requestedAttempt);if(!passing.length)return;
    const attempt=Math.max(requestedAttempt,...passing.map(p=>p.attempt)),bps=retrySlippage(preview.slippageBps,attempt);
    if(passing.some(p=>p.attempt!==attempt))return executeBatch(passing.map(p=>p.review),attempt,previousGas);
    highestRetry=Math.max(highestRetry,attempt);
    const current=passing.map(q=>q.fresh),original=passing.map(q=>q.review),reviewed=original.map(q=>({...q,minimum:minimum(q.buyAmount,bps)}));
    const plan=current.map((q,i)=>swapStep(q,reviewed[i],boot,bps)),floor=reviewed.reduce((sum,q)=>sum+q.minimum,0n);
    let gas:bigint;
    try{
      progress('Validating a batch of '+plan.length+' swaps…');
      await simulateSweepBatch(client,boot,user,current,bps,reviewed);
      const estimate=await client.estimateContractGas({address:boot.registry.sweep.swapper,abi:SWEEP_ABI,functionName:'executePlanFromCallerAdvanced',args:[plan,user,{minTotalOut:floor,allowPartial:false}],account:user,gas:SWEEP_GAS_LIMIT});
      gas=retryGas(estimate,attempt,previousGas);
    }catch(error){
      stop();
      if((error instanceof SweepPreflightRevert||contractReverted(error))&&attempt<maxAttempt){retrying('swap',attempt+1);return executeBatch(original,attempt+1,previousGas);}
      if(reviewed.length===1){skip(reviewed[0].input,'batch',Error('Batch simulation or gas estimation did not pass. This token stays in your wallet.'));return;}
      // [DECISION: adaptive batches] Split only before submission. Each child
      // obtains fresh quotes and independent combined simulation/gas checks.
      // Never split/retry a sent transaction or weaken its reviewed minimums.
      progress('Splitting this batch into smaller groups…');const middle=Math.ceil(reviewed.length/2);
      await executeBatch(original.slice(0,middle),attempt);await executeBatch(original.slice(middle),attempt);return;
    }
    stop();batchGas=gas;
    let hash:Hash;
    try{hash=await send(boot.registry.sweep.swapper,SWEEP_ABI,'executePlanFromCallerAdvanced',[plan,user,{minTotalOut:floor,allowPartial:false}],'Sweep batch '+(batches+1)+' · '+plan.length+' token'+(plan.length===1?'':'s')+' to '+output.symbol+(attempt?' · retry '+attempt:''),output.symbol,floor,output.decimals);}
    catch(error){if(!preview.retry||!await verifiedRevertedAttempt(client,user,boot.registry.sweep.swapper,lastBroadcast,error))throw error;
      if(attempt<maxAttempt){retrying('swap',attempt+1,lastBroadcast);batchGas=undefined;if(attempt+1===maxAttempt&&original.length>1){for(const row of original)await executeBatch([row],attempt+1);}else await executeBatch(original,attempt+1,gas);return;}
      exhausted('swap',attempt);for(const row of original)skip(row.input,'batch',Error('Retry limit reached after a confirmed failed attempt. This token remains in your wallet.'));return;
    }finally{batchGas=undefined;}
    // Successful or uncertain receipts are never caught by the retry handler.
    const receipt=await receiptFor(hash);outputAmount+=receiptOutput(receipt.logs,boot,reviewed);swapped+=reviewed.length;batches++;
  };
  // [VERIFIED: existing RewardsSection.tsx EXECUTION_BATCH_SIZE=10]
  // Exact approvals remain separate; only eligible swaps share a transaction.
  for(let start=0;start<preview.quotes.length;start+=SWEEP_BATCH_LIMIT){
    stop();const passing=await refreshPassing(preview.quotes.slice(start,start+SWEEP_BATCH_LIMIT),true);
    for(const {review} of passing)await approve(review.input,boot.registry.sweep.swapper);
    await executeBatch(passing.map(q=>q.review));
  }
  if(preview.mode!=='USDC'&&runtimeSkipped){
    // A smaller subset must never silently weaken the reviewed conversion floor.
    progress('Eligible swaps complete; review a new conversion for the remaining '+output.symbol+'.');
    return {hashes,outToken:output.token,outputAmount,iaero,staked,swapped,batches,skipped,conversionDeferred:'Some swaps were skipped after review. Your '+output.symbol+' remains liquid; review a fresh conversion for this smaller amount.'};
  }
  if(preview.mode!=='USDC'){
    stop();if(outputAmount<(preview.retry?.minimumOutputByAttempt[highestRetry]??preview.minimumOutput)||!preview.minimumIaero)throw Error('The confirmed AERO output is below the reviewed minimum.');
    let previousGas=0n;
    for(let attempt=0;attempt<=maxAttempt;attempt++){
      const level=Math.max(highestRetry,attempt);let protectedMinimum=preview.retry?.minimumIaeroByAttempt?.[level]??preview.minimumIaero;
      const protect=async()=>{const route=await quoteAeroIaeroRoute(client,boot,outputAmount);if(route.output<protectedMinimum)throw new SweepPreflightRevert('The Aero route moved beyond your reviewed minimum. Your AERO remains in your wallet.');protectedMinimum=route.costMinimum>protectedMinimum?route.costMinimum:protectedMinimum;return route.block;};
      let block;
      try{block=await protect();}catch(error){if(error instanceof SweepPreflightRevert&&attempt<maxAttempt){retrying('conversion',attempt+1);continue;}return {hashes,outToken:output.token,outputAmount,iaero,staked,swapped,batches,skipped,conversionDeferred:publicError(error)};}
      await approve({token:output.token,symbol:output.symbol,decimals:output.decimals,amount:outputAmount},boot.registry.sweep.metarouter);
      // Recheck both price and the unchanged 2% conversion-cost cap after any
      // approval. Retry floors were explicitly included in the user's review.
      try{block=await protect();}catch(error){if(error instanceof SweepPreflightRevert&&attempt<maxAttempt){retrying('conversion',attempt+1);continue;}return {hashes,outToken:output.token,outputAmount,iaero,staked,swapped,batches,skipped,conversionDeferred:publicError(error)};}
      const route=encodeAeroIaeroRoute(boot,user,outputAmount,protectedMinimum),args=[route.commands,route.inputs,block.timestamp+300n] as const;
      if(preview.retry){try{batchGas=retryGas(await client.estimateContractGas({address:boot.registry.sweep.metarouter,abi:METAROUTER_ABI,functionName:'execute',args,account:user,gas:SWEEP_GAS_LIMIT}),attempt,previousGas);}catch(error){if(contractReverted(error)&&attempt<maxAttempt){retrying('conversion',attempt+1);continue;}return {hashes,outToken:output.token,outputAmount,iaero,staked,swapped,batches,skipped,conversionDeferred:publicError(error)};}}
      let hash:Hash;
      try{hash=await send(boot.registry.sweep.metarouter,METAROUTER_ABI,'execute',args,'Convert sweep AERO to iAERO'+(attempt?' · retry '+attempt:''),'iAERO',protectedMinimum);}
      catch(error){if(!preview.retry||!await verifiedRevertedAttempt(client,user,boot.registry.sweep.metarouter,lastBroadcast,error))throw error;if(attempt<maxAttempt){previousGas=batchGas??0n;retrying('conversion',attempt+1,lastBroadcast);continue;}exhausted('conversion',attempt);return {hashes,outToken:output.token,outputAmount,iaero,staked,swapped,batches,skipped,conversionDeferred:'Conversion retry limit reached. Your AERO remains in your wallet.'};}
      finally{batchGas=undefined;}
      const receipt=await receiptFor(hash);iaero=receiptIaero(receipt.logs,boot.registry.legacy.iAERO,user);
      if(iaero<protectedMinimum)throw Error('The confirmed output is below the reviewed minimum. Review the receipt before staking.');
      break;
    }
    if(preview.mode==='stake'){
      previousGas=0n;
      for(let attempt=0;attempt<=maxAttempt;attempt++){
        stop();if(!boot.legacyReady||await client.readContract({address:boot.registry.legacy.epochDistributor,abi:LEGACY_DEPOSIT_ABI,functionName:'paused'}))throw Error('Previous staking is unavailable. Your converted iAERO remains liquid in your wallet.');
        await approve({token:boot.registry.legacy.iAERO,symbol:'iAERO',decimals:18,amount:iaero},boot.registry.legacy.epochDistributor);
        if(preview.retry)batchGas=retryGas(await client.estimateContractGas({address:boot.registry.legacy.epochDistributor,abi:LEGACY_DEPOSIT_ABI,functionName:'stake',args:[iaero],account:user,gas:SWEEP_GAS_LIMIT}),attempt,previousGas);
        try{await send(boot.registry.legacy.epochDistributor,LEGACY_DEPOSIT_ABI,'stake',[iaero],'Stake sweep output in previous staking'+(attempt?' · retry '+attempt:''),'iAERO',iaero);staked=iaero;break;}
        catch(error){if(!preview.retry||!await verifiedRevertedAttempt(client,user,boot.registry.legacy.epochDistributor,lastBroadcast,error))throw error;if(attempt<maxAttempt){previousGas=batchGas??0n;retrying('stake',attempt+1,lastBroadcast);continue;}exhausted('stake',attempt);return {hashes,outToken:output.token,outputAmount,iaero,staked,swapped,batches,skipped,stakingDeferred:'Staking retry limit reached. The converted iAERO remains liquid in your wallet.'};}
        finally{batchGas=undefined;}
      }
    }
  }
  progress('Sweep complete');return {hashes,outToken:output.token,outputAmount,iaero,staked,swapped,batches,skipped};
}
