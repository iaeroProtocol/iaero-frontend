// [VERIFIED: StreamingDistributor.sol, EpochStakingDistributor.sol; REV-11]
import {parseAbi, parseUnits, type Address, type Hash} from 'viem';
import type {SaeroAddresses} from './saeroAddresses';
import {trackBrowserTransaction} from './pendingTransaction';

export const STREAMING_ABI = parseAbi([
  'function stake(uint256)', 'function withdraw(uint256)', 'function exit()', 'function getReward()',
  'function earned(address) view returns(uint256)', 'function balanceOf(address) view returns(uint256)',
  'function totalStaked() view returns(uint256)', 'function lastNotifiedAt() view returns(uint256)',
  'function periodFinish() view returns(uint256)', 'function rewardRate() view returns(uint256)',
  'function PRECISION() view returns(uint256)', 'function paused() view returns(bool)',
]);
export const STAKING_ERC20_ABI = parseAbi(['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)']);
export const LEGACY_STAKING_ABI = parseAbi([
  'function balanceOf(address) view returns(uint256)', 'function currentEpoch() view returns(uint256)',
  'function previewClaim(address,address,uint256) view returns(uint256)', 'function claim(address,uint256)',
  'function claimLatest(address[])', 'function exit()', 'function paused() view returns(bool)',
]);
export type ReadClient = {
  readContract: (request: any) => Promise<any>;
  getBlock: () => Promise<{number:bigint;timestamp:bigint}>;
  getChainId: () => Promise<number>;
  simulateContract: (request:any) => Promise<{request:any}>;
  waitForTransactionReceipt: (request:{hash:Hash;onReplaced?:(replacement:unknown)=>void}) => Promise<{status:string;transactionHash?:Hash}>;
  getTransactionReceipt?: (request:{hash:Hash}) => Promise<{status:string;transactionHash?:Hash}>;
};
export type StakingWriter = (request:any) => Promise<Hash>;
export function walletSender(client:ReadClient,write:StakingWriter,c:SaeroAddresses,user:Address,identity:()=>Promise<Address|undefined>) {
  const guard=async()=>{
    if(await client.getChainId()!==c.chainId || (await identity())?.toLowerCase()!==user.toLowerCase()) throw Error('Wallet or network changed. Refresh before continuing.');
  };
  return async(address:Address,abi:readonly unknown[],functionName:string,args:readonly unknown[]=[])=>{
    await guard();
    const simulation=await client.simulateContract({address,abi,functionName,args,account:user,chainId:c.chainId});
    // Simulation may be slow enough for the connected wallet or network to change.
    await guard();
    return trackBrowserTransaction(client,{chainId:c.chainId,user,to:address,action:functionName},async journal=>{
    try{await guard();}catch(error){journal.complete();throw error;}
    const hash=await write({...simulation.request,chainId:c.chainId,account:user});journal.broadcast(hash);
    let replaced=false;
    const receipt=await client.waitForTransactionReceipt({hash,onReplaced:()=>{replaced=true;journal.replaced();}});
    if(replaced||receipt.transactionHash?.toLowerCase()!==hash.toLowerCase()){
      journal.replaced();
      throw Error(`Transaction changed during confirmation. Check the wallet activity before continuing: ${hash}`);
    }
    if(!['success','reverted'].includes(receipt.status))throw Error(`The transaction receipt is not final: ${hash}`);
    journal.complete();
    if(receipt.status!=='success')throw Error(`Transaction reverted: ${hash}`);
    return hash;
    });
  };
}
export type StreamingSnapshot = {
  block:bigint; timestamp:number; earned?:bigint; balance:bigint; wallet:bigint; totalStaked:bigint;
  lastNotifiedAt?:number; periodFinish?:number; rewardRate?:bigint; precision?:bigint; paused:boolean; rewardError?:string;
};
export function stakeAmount(value:string):bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw Error('Enter a positive amount with at most 18 decimal places.');
  const amount = parseUnits(value,18);
  if (amount <= 0n || amount >= 2n ** 256n) throw Error('Enter a valid positive amount.');
  return amount;
}
export async function readStreaming(client:ReadClient,c:SaeroAddresses,user:Address):Promise<StreamingSnapshot> {
  const block=await client.getBlock();
  const read=(functionName:string,args:readonly unknown[]=[])=>client.readContract({address:c.streamingDistributor,abi:STREAMING_ABI,functionName,args,blockNumber:block.number});
  // An unavailable reward preview must not hide a known principal balance or its exit.
  const rewardRead=Promise.all([read('earned',[user]),read('lastNotifiedAt'),read('periodFinish'),read('rewardRate'),read('PRECISION')]).then(([earned,lastNotifiedAt,periodFinish,rewardRate,precision])=>{
    if(precision<=0n)throw Error('Invalid streaming precision.');
    return {earned,lastNotifiedAt:Number(lastNotifiedAt),periodFinish:Number(periodFinish),rewardRate,precision};
  }).catch(()=>({rewardError:'Reward information could not be read. Principal withdrawal remains available.'}));
  const [rewards,balance,totalStaked,paused,wallet]=await Promise.all([
    rewardRead,read('balanceOf',[user]),read('totalStaked'),read('paused'),
    client.readContract({address:c.iAERO,abi:STAKING_ERC20_ABI,functionName:'balanceOf',args:[user],blockNumber:block.number}),
  ]);
  return {block:block.number,timestamp:Number(block.timestamp),...rewards,balance,totalStaked,paused,wallet};
}
export function streamingApr(s:StreamingSnapshot,prices?:{iaeroUsd:number;usdcUsd:number;asOf:number}):number|null {
  if(s.periodFinish===undefined||s.rewardRate===undefined||s.precision===undefined)return null;
  if (s.timestamp >= s.periodFinish || s.totalStaked === 0n) return 0;
  if (!prices || ![prices.iaeroUsd,prices.usdcUsd].every(p=>Number.isFinite(p)&&p>0) || prices.asOf>s.timestamp+60 || s.timestamp-prices.asOf>900) return null;
  const apr=Number(s.rewardRate)/Number(s.precision)/1e6*31536000*prices.usdcUsd/(Number(s.totalStaked)/1e18*prices.iaeroUsd)*100;
  return Number.isFinite(apr)?apr:null;
}
export function stakingActions(client:ReadClient,write:StakingWriter,c:SaeroAddresses,user:Address,identity:()=>Promise<Address|undefined>) {
  const send=walletSender(client,write,c,user,identity);
  return {
    async stake(amount:bigint) {
      if (amount<=0n) throw Error('Amount must be positive.');
      const allowance=await client.readContract({address:c.iAERO,abi:STAKING_ERC20_ABI,functionName:'allowance',args:[user,c.streamingDistributor]}) as bigint;
      if (allowance<amount) await send(c.iAERO,STAKING_ERC20_ABI,'approve',[c.streamingDistributor,amount]);
      return send(c.streamingDistributor,STREAMING_ABI,'stake',[amount]);
    },
    withdraw:(amount:bigint)=>{if(amount<=0n)throw Error('Amount must be positive.');return send(c.streamingDistributor,STREAMING_ABI,'withdraw',[amount]);},
    exit:()=>send(c.streamingDistributor,STREAMING_ABI,'exit'),
    claim:()=>send(c.streamingDistributor,STREAMING_ABI,'getReward'),
    claimLegacy:(tokens:Address[])=>send(c.epochDistributor,LEGACY_STAKING_ABI,'claimLatest',[tokens]),
    claimLegacyEpoch:(token:Address,epoch:bigint)=>send(c.epochDistributor,LEGACY_STAKING_ABI,'claim',[token,epoch]),
    async exitLegacy() {
      const [staked,receipts]=await Promise.all([
        client.readContract({address:c.epochDistributor,abi:LEGACY_STAKING_ABI,functionName:'balanceOf',args:[user]}),
        client.readContract({address:c.stiAERO,abi:STAKING_ERC20_ABI,functionName:'balanceOf',args:[user]}),
      ]);
      if (receipts<staked) throw Error('Recover the transferred stiAERO receipts before withdrawing, or contact support.');
      return send(c.epochDistributor,LEGACY_STAKING_ABI,'exit');
    },
  };
}
