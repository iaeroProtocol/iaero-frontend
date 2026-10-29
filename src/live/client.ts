import {createPublicClient,createWalletClient,custom,getAddress,http,isAddress,parseAbi,type Address,type EIP1193Provider,type Hash} from 'viem';
import {base} from 'viem/chains';
import type {Action,Activity,DemoWallet} from '../domain';
import {tokenText} from '../domain';
import {LEGACY_STAKING_ABI,STAKING_ERC20_ABI,walletSender,type ReadClient} from '../protocol/streamingClient';
import {OLD_AUTO_ABI} from '../protocol/autoVaultClient';
import type {SaeroAddresses} from '../protocol/saeroAddresses';
import {executeNew} from './new-stack';
import {executeLiq} from './liq';
import {emptyWallet,liveReason,type Bootstrap,type LegacyReward,type LiveState,type WalletField} from './types';
import {CLAIM_MANY_ABI,sendRewardClaims} from './rewards';
import {acceptedReadCoverage} from '../protocol-data/read-coverage';
import {mapReadBatches} from './read-concurrency';
import {readApprovalChecks,approvalKey} from './approval-checks';
import {accountReadClient} from './account-read-client';

export const META_ABI=parseAbi(['function symbol() view returns(string)','function decimals() view returns(uint8)']);
export const PRINCIPAL_ABI=parseAbi(['function stake(uint256)','function unstake(uint256)','function balanceOf(address) view returns(uint256)','function paused() view returns(bool)']);
export const publicBaseClient=()=>createPublicClient({chain:base,transport:http(new URL('/api/base',window.location.origin).href,{timeout:45000,retryCount:0}),batch:{multicall:false},ccipRead:false});
export type BaseClient=ReturnType<typeof publicBaseClient>;
export function publicError(error:unknown){
  for(let e:any=error,n=0;e&&n<12;e=e.cause,n++)if(e.code===4001)return 'You declined the wallet request. No further action was sent.';
  if(error instanceof Error&&error.message.length<220&&!/https?:|request body|details:/i.test(error.message))return error.message;
  return 'The contract read or wallet request could not complete. Check the network, balances and pending transaction notice before retrying.';
}
let bootstrapRead:Promise<Bootstrap>|undefined;
// Share only the pending browser read. A completed proof is never cached here.
export function fetchBootstrap():Promise<Bootstrap>{
 if(!bootstrapRead)bootstrapRead=loadBootstrap().finally(()=>{bootstrapRead=undefined;});return bootstrapRead;
}
async function loadBootstrap():Promise<Bootstrap>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),25000);
  let response:Response,data:any;
  try{response=await fetch('/api/contracts',{cache:'no-store',signal:abort.signal});data=await response.json();}
  catch(error){if(abort.signal.aborted)throw Error('Base verification timed out. Refresh to retry.');throw error;}
  finally{clearTimeout(timer);}
  if(!response.ok||data.registry?.chainId!==8453||!acceptedReadCoverage(data.snapshot?.independentProviders,data.readCoverage))throw Error('Verified Base contract data is unavailable. Refresh to retry.');
  for(const address of Object.values(data.registry.legacy))if(typeof address!=='string'||!isAddress(address))throw Error('Invalid Base contract registry.');
  return data;
}

export function legacyConfig(boot:Bootstrap):SaeroAddresses{
  // Only legacy routes consume this configuration while the new stack is absent.
  // Missing new addresses remain undefined: they are never replaced by old contracts
  // or predicted CREATE addresses. The guarded legacy helpers do not read them.
  return {...boot.registry.legacy,chainId:8453} as unknown as SaeroAddresses;
}
const metaCache=new Map<string,Promise<{symbol:string;decimals:number|null}>>();
export async function tokenMetadata(client:BaseClient,address:Address){
  // [VERIFIED: EpochStakingDistributor._claim] address(0) is the native ETH leg.
  if(BigInt(address)===0n)return {symbol:'ETH',decimals:18};
  const key=address.toLowerCase();
  if(!metaCache.has(key))metaCache.set(key,(async()=>{
    const results=await Promise.allSettled([
      client.readContract({address,abi:META_ABI,functionName:'symbol'}),client.readContract({address,abi:META_ABI,functionName:'decimals'})
    ]);
    const symbol=results[0].status==='fulfilled'?String(results[0].value).replace(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,32):address.slice(0,6)+'…'+address.slice(-4);
    const decimals=results[1].status==='fulfilled'&&Number(results[1].value)<=36?Number(results[1].value):null;
    if(results.some(r=>r.status==='rejected'))metaCache.delete(key);
    return {symbol,decimals};
  })());
  return metaCache.get(key)!;
}

export async function readAccount(client:BaseClient,boot:Bootstrap,user:Address,date='',customToken='',preparedReader?:BaseClient){
  if(await client.getChainId()!==8453)throw Error('The read connection is not on Base.');
  const block=await client.getBlock(),wallet=emptyWallet(),known:Partial<Record<WalletField,boolean>>={},errors:string[]=[];
  const getterClient=preparedReader??accountReadClient(client,boot);
  wallet.checkpoint=Number(block.timestamp);
  const read=(address:Address,abi:readonly unknown[],functionName:string,args:readonly unknown[]=[]):Promise<any>=>getterClient.readContract({address,abi,functionName,args,blockNumber:block.number} as any);
  const fields:[WalletField,Address][]=[['aero',boot.registry.aero.token],['iaero',boot.registry.legacy.iAERO],['usdc',boot.registry.legacy.USDC],['liq',boot.registry.legacy.LIQ]];
  const balances=Promise.all(fields.map(async([field,address])=>{try{wallet[field]=await read(address,STAKING_ERC20_ABI,'balanceOf',[user]);known[field]=true;}catch{errors.push(field+' wallet balance could not be read.');}}));
  const get=async<T>(label:string,operation:()=>Promise<T>):Promise<T|undefined>=>{try{return await operation();}catch{errors.push(label+' could not be read.');}};
  const [legacyStake,legacyReceipts,legacyPaused,epoch,ethBalance,oldAutoShares]=await Promise.all([
    get('Legacy principal',()=>read(boot.registry.legacy.epochDistributor,LEGACY_STAKING_ABI,'balanceOf',[user])),
    get('Legacy receipt balance',()=>read(boot.registry.legacy.stiAERO,STAKING_ERC20_ABI,'balanceOf',[user])),
    get('Legacy pause status',()=>read(boot.registry.legacy.epochDistributor,LEGACY_STAKING_ABI,'paused')),
    get('Legacy current epoch',()=>read(boot.registry.legacy.epochDistributor,LEGACY_STAKING_ABI,'currentEpoch')),
    get('Base ETH balance',()=>client.getBalance({address:user,blockNumber:block.number})),
    get('Old AutoVault shares',()=>read(boot.registry.legacy.autoVault,OLD_AUTO_ABI,'sharesOf',[user]))
  ]);
  await balances;
  if(legacyStake!==undefined){wallet.legacyStake=BigInt(legacyStake);known.legacyStake=true;}
  const currentEpoch=epoch!==undefined?BigInt(epoch):undefined;
  let selected=currentEpoch,rewardSelectionError:string|undefined;
  if(date){const seconds=Date.parse(date+'T00:00:00Z')/1000;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isSafeInteger(seconds)||seconds<0||seconds>Number(block.timestamp)||new Date(seconds*1000).toISOString().slice(0,10)!==date){selected=undefined;rewardSelectionError='Select a valid date in the past. Principal reads are unaffected.';}
    else selected=BigInt(Math.floor(seconds/604800)*604800);
  }
  const epochs=selected===undefined?[]:Array.from({length:4},(_,i)=>selected!-BigInt(i)*604800n).filter(e=>e>=0n);
  // [VERIFIED: iAEROAutoUSDCVault.sol currentEpoch/previewUSDCMany] AutoVault
  // payouts have their own weekly ledger. A historical staking filter must
  // not hide current USDC or depend on the staking contract's epoch getter.
  const autoEpoch=block.timestamp/604800n*604800n;
  const oldAutoEpochs=Array.from({length:26},(_,i)=>autoEpoch-BigInt(i)*604800n).filter(e=>e>=0n);
  const autoRewards=oldAutoEpochs.length?get('Old AutoVault rewards',async()=>{const value=await read(boot.registry.legacy.autoVault,OLD_AUTO_ABI,'previewUSDCMany',[user,oldAutoEpochs]);return BigInt(value[1]);}):undefined;
  const tokens=[...boot.registry.knownLegacyRewardTokens.map(t=>t.address),...(boot.rewardTokenAddresses??[])];
  if(boot.rewardRegistryError)errors.push(boot.rewardRegistryError);
  if(customToken){if(!isAddress(customToken))rewardSelectionError='The additional token address is invalid. Only configured tokens were read; principal reads are unaffected.';else tokens.push(getAddress(customToken));}
  const unique=[...new Map(tokens.map(t=>[t.toLowerCase(),t])).values()];
  const rewards:LegacyReward[]=[];let rewardReadErrors=0;
  const batched=new Map<string,Map<bigint,bigint>>();
  if(boot.rewardTokenAddresses?.length){
    // [VERIFIED: EpochStakingDistributor.previewClaimsForEpoch] This getter
    // reads the same mappings without an external call to each reward token.
    // Bound chunks to avoid thousands of individual RPC calls for the registry.
    const jobs:{epoch:bigint;tokens:Address[]}[]=[];
    for(const epoch of epochs)for(let start=0;start<unique.length;start+=64)jobs.push({epoch,tokens:unique.slice(start,start+64)});
    let next=0;await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{
      while(next<jobs.length){const job=jobs[next++];try{
        const amounts=await read(boot.registry.legacy.epochDistributor,CLAIM_MANY_ABI,'previewClaimsForEpoch',[user,job.tokens,job.epoch]);
        if(!Array.isArray(amounts)||amounts.length!==job.tokens.length)throw Error('Invalid reward batch read');
        job.tokens.forEach((token,i)=>{const key=token.toLowerCase(),map=batched.get(key)??new Map<bigint,bigint>();map.set(job.epoch,BigInt(amounts[i]));batched.set(key,map);});
      }catch{/* Missing entries stay unknown below. */}}
    }));
  }
  await mapReadBatches(unique,async token=>{
    const results=await Promise.allSettled(epochs.map(async epoch=>{
      if(boot.rewardTokenAddresses?.length){const amount=batched.get(token.toLowerCase())?.get(epoch);if(amount===undefined)throw Error('Unknown reward entry');return {epoch,amount};}
      return {epoch,amount:BigInt(await read(boot.registry.legacy.epochDistributor,LEGACY_STAKING_ABI,'previewClaim',[user,token,epoch]))};
    }));
    const earned=results.flatMap(r=>r.status==='fulfilled'&&r.value.amount>0n?[r.value]:[]);rewardReadErrors+=results.filter(r=>r.status==='rejected').length;
    if(earned.length){const metadata=await tokenMetadata(getterClient,token);for(const row of earned)rewards.push({...row,token,...metadata});}
    if(token.toLowerCase()===boot.registry.legacy.USDC.toLowerCase()&&results.length&&results.every(r=>r.status==='fulfilled')){wallet.legacyRewards=earned.reduce((sum,r)=>sum+r.amount,0n);known.legacyRewards=true;}
  });
  const oldAutoEarned=await autoRewards;
  if(rewardReadErrors)errors.push(`${rewardReadErrors} selected reward entries could not be read; they are not treated as zero.`);
  return {wallet,known,errors,ethBalance,legacyReceipts:legacyReceipts===undefined?undefined:BigInt(legacyReceipts),legacyPaused:legacyPaused===undefined?undefined:Boolean(legacyPaused),oldAutoShares:oldAutoShares===undefined?undefined:BigInt(oldAutoShares),oldAutoEarned,oldAutoEpochs,rewardEpochs:epochs,rewards:rewards.sort((a,b)=>a.epoch===b.epoch?a.token.localeCompare(b.token):a.epoch>b.epoch?-1:1),rewardTokenCount:unique.length,rewardReadErrors,rewardSelectionError,readAt:Number(block.timestamp)};
}

export async function walletIdentity(provider:EIP1193Provider):Promise<{address?:Address;chainId:number}>{
  const [accounts,chain]=await Promise.all([provider.request({method:'eth_accounts'}),provider.request({method:'eth_chainId'})]);
  return {address:accounts[0]?getAddress(accounts[0]):undefined,chainId:Number(BigInt(chain))};
}
// Network/session transitions can publish chainChanged before eth_accounts
// catches up. Only connection transitions use these bounded read retries;
// transaction guards continue to use the immediate identity check above.
export async function switchedWalletIdentity(provider:EIP1193Provider,current:()=>boolean,targetChain?:number){
  let identity:{address?:Address;chainId:number}|undefined,error:unknown;
  for(let attempt=0;attempt<4;attempt++){
    if(!current())throw Error('The wallet connection changed during the network switch.');
    try{identity=await walletIdentity(provider);error=undefined;if(identity.address&&(targetChain===undefined||identity.chainId===targetChain))return identity;}catch(e){error=e;}
    if(attempt<3)await new Promise(r=>setTimeout(r,150*(attempt+1)));
  }
  if(!current())throw Error('The wallet connection changed during the network switch.');
  if(error)throw error;return identity!;
}

export type ExecutionContext={client:BaseClient;provider:EIP1193Provider;state:LiveState;onBroadcast:(hash:Hash)=>void;onProgress?:(text:string)=>void;onConfirmed?:(activity:Activity)=>void;canContinue?:()=>boolean};
export async function createGuardedSender({client,provider,state,onBroadcast,canContinue:workflowCurrent}:ExecutionContext,canContinue=()=>true,gasLimit?:(request:any)=>bigint|undefined){
  const user=state.address!,c=legacyConfig(state.boot!);
  const identity=async()=>{const current=await walletIdentity(provider);return current.chainId===8453&&canContinue()&&(workflowCurrent?.()??true)?current.address:undefined;};
  if((await identity())?.toLowerCase()!==user.toLowerCase())throw Error('Wallet or network changed. Refresh before continuing.');
  const wallet=createWalletClient({account:user,chain:base,transport:custom(provider)});
  const reads=gasLimit?{...client,simulateContract:async(request:any)=>{
    const gas=gasLimit(request);
    if(gas!==undefined&&(gas<=0n||gas>16_000_000n))throw Error('The transaction gas limit is outside the supported budget.');
    return client.simulateContract(gas===undefined?request:{...request,gas});
  }}:client;
  return walletSender(reads as unknown as ReadClient,async request=>{const hash=await wallet.writeContract(request);onBroadcast(hash);return hash;},c,user,identity);
}
export async function executeLiveAction(context:ExecutionContext&{action:Action}){
  const {client,state,action,onProgress,onConfirmed}=context;
  const reason=liveReason(action.kind,state,!!state.address);if(reason)throw Error(reason);
  const boot=state.boot!,user=state.address!,c=legacyConfig(boot),send=await createGuardedSender(context);
  let hash:Hash;
  const observedSend=async(to:Address,abi:readonly unknown[],fn:string,args:readonly unknown[]=[])=>{
    const hash=await send(to,abi,fn,args),approval=fn==='approve',symbol=to.toLowerCase()===boot.registry.legacy.USDC.toLowerCase()?'USDC':to.toLowerCase()===boot.registry.legacy.LIQ.toLowerCase()?'LIQ':action.tokenSymbol??'iAERO',claim=fn==='claimMany'||fn==='withdrawCredit'||fn==='getReward'||fn==='claimUSDC';
    onConfirmed?.({id:hash,hash,title:approval?'Approve exact '+symbol+' allowance':fn==='withdrawCredit'?'Withdraw accrued reward credit':action.title,token:approval?'':claim?'rewards':action.tokenSymbol??'iAERO',amount:approval?'Allowance only':claim?'Contract-set amount':tokenText(action.amount,action.tokenDecimals??18,6),direction:approval||['stake','autoStake','mint','nft','collateralWrap'].includes(action.kind)?'out':'in',time:Date.now()});return hash;
  };
  if(['stake','unstake','claim','autoStake','autoUnstake','autoClaim','mint','nft','collateralWrap','collateralRedeem','collateralClaim'].includes(action.kind)){const hashes=await executeNew(context,action,observedSend);return {hashes,activities:[]};}
  if(action.kind.startsWith('liq')){const hashes=await executeLiq(context,action,observedSend);return {hashes,activities:[]};}
  if(action.kind==='legacyClaimMany')return sendRewardClaims({client,boot,distributor:c.epochDistributor,user,rows:action.rewardLegs??[],send,onProgress,onConfirmed});
  if(action.kind==='legacyStake'){
    const checks=await readApprovalChecks(client,boot,user,[{token:c.iAERO,spender:c.epochDistributor}]),check=checks.get(approvalKey(c.iAERO,c.epochDistributor));
    if(action.amount<=0n||!check||check.error||check.balance===undefined||check.allowance===undefined||action.amount>check.balance)throw Error(check?.error??'The available iAERO balance changed. Review the staking amount.');
    if(await client.readContract({address:c.epochDistributor,abi:PRINCIPAL_ABI,functionName:'paused'}))throw Error('Previous staking is paused. Your iAERO remains liquid.');
    if(check.allowance<action.amount){if(check.allowance>0n)await observedSend(c.iAERO,STAKING_ERC20_ABI,'approve',[c.epochDistributor,0n]);await observedSend(c.iAERO,STAKING_ERC20_ABI,'approve',[c.epochDistributor,action.amount]);}
    hash=await send(c.epochDistributor,PRINCIPAL_ABI,'stake',[action.amount]);
  }else if(action.kind==='legacyWithdraw'){
    if(action.amount<=0n)throw Error('No old principal to withdraw.');
    const [balance,receipts,paused]=await Promise.all([
      client.readContract({address:c.epochDistributor,abi:LEGACY_STAKING_ABI,functionName:'balanceOf',args:[user]}),
      client.readContract({address:c.stiAERO,abi:STAKING_ERC20_ABI,functionName:'balanceOf',args:[user]}),
      client.readContract({address:c.epochDistributor,abi:LEGACY_STAKING_ABI,functionName:'paused'})
    ]);
    if(paused||action.amount>balance||action.amount>receipts)throw Error('The old principal, receipts or pause status changed. Refresh and review the amount.');
    // Withdraw exactly the reviewed amount rather than an unbounded exit().
    hash=await send(c.epochDistributor,PRINCIPAL_ABI,'unstake',[action.amount]);
  }else if(action.kind==='legacyClaim'){
    const token=action.tokenAddress,epoch=action.epoch;
    if(!token||!isAddress(token)||epoch===undefined||epoch<0n||epoch%604800n!==0n)throw Error('Choose an exact reward token and week before claiming.');
    const claimable=await client.readContract({address:c.epochDistributor,abi:LEGACY_STAKING_ABI,functionName:'previewClaim',args:[user,token,epoch]});
    if(claimable<=0n)throw Error('This selected reward is no longer claimable. Refresh the history.');
    hash=await send(c.epochDistributor,LEGACY_STAKING_ABI,'claim',[token,epoch]);
  }else if(action.kind==='oldAutoWithdraw'){
    const shares=await client.readContract({address:c.autoVault,abi:OLD_AUTO_ABI,functionName:'sharesOf',args:[user]});
    if(action.amount<=0n||action.amount>shares)throw Error('Old AutoVault shares changed. Refresh before withdrawing.');
    hash=await send(c.autoVault,OLD_AUTO_ABI,'withdraw',[action.amount]);
  }else if(action.kind==='oldAutoClaim'){
    const epochs=action.epochs;
    if(!epochs?.length||epochs.length>5000||epochs.some(e=>e<0n||e%604800n!==0n))throw Error('Choose a valid old AutoVault reward window.');
    const hashes:Hash[]=[];for(let i=0;i<epochs.length;i+=50){const group=epochs.slice(i,i+50),preview=await client.readContract({address:c.autoVault,abi:OLD_AUTO_ABI,functionName:'previewUSDCMany',args:[user,group]});if(preview[1]<=0n)continue;const part=await send(c.autoVault,OLD_AUTO_ABI,'claimUSDC',[group]);hashes.push(part);onConfirmed?.({id:part,hash:part,title:action.title,token:'USDC',amount:tokenText(preview[1],6,6),direction:'in',time:Date.now()});}return {hashes,activities:[],noAction:hashes.length?undefined:'The selected AutoVault rewards are already settled. No transaction was sent.'};
  }else throw Error('This route has no accepted deployed contract yet.');
  const decimals=action.tokenDecimals===null?null:action.tokenDecimals??(['legacyClaim','oldAutoClaim'].includes(action.kind)?6:18);
  const activity:Activity={id:hash,hash,title:action.title,token:action.tokenSymbol??(action.kind==='legacyClaim'?'USDC':'iAERO'),amount:decimals===null?action.amount.toString()+' raw units':tokenText(action.amount,decimals,6),direction:action.kind==='legacyStake'?'out':'in',time:Date.now()};
  return {hash,activity};
}
