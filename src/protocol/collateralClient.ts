import {parseAbi,parseUnits,type Address} from 'viem';
import type {SaeroAddresses} from './saeroAddresses';
import {STAKING_ERC20_ABI,walletSender,type ReadClient,type StakingWriter} from './streamingClient';
export const COLLATERAL_ABI=parseAbi([
  'function stream() view returns(address)','function receipt() view returns(address)','function USDC() view returns(address)',
  'function balanceOf(address) view returns(uint256)','function claimableUSDC(address) view returns(uint256)',
  'function paused() view returns(bool)','function pooledUSDC() view returns(uint256)',
  'function previewWrap(uint256) view returns(uint256)','function previewWrapUSDC(uint256) view returns(uint256)','function previewRedeem(uint256) view returns(uint256,uint256)',
  'function wrap(uint256,uint256,uint256,address) returns(uint256)','function redeem(uint256,uint256,uint256,address) returns(uint256,uint256)',
  'function harvestUSDC() returns(uint256)','function claimUSDC(address) returns(uint256)',
]);
function target(c:SaeroAddresses){if(!c.stakedCollateral)throw Error('The collateral wrapper is not configured.');return c.stakedCollateral;}
export function minimumWrapperShares(quote:bigint,percent:string):bigint{
  if(!/^\d{1,2}(\.\d{1,2})?$/.test(percent))throw Error('Enter a quote tolerance from 0 to 5 percent.');
  const bps=parseUnits(percent,2);if(bps>500n)throw Error('Enter a quote tolerance from 0 to 5 percent.');
  const minimum=quote*(10000n-bps)/10000n;if(minimum<=0n)throw Error('The wrapper quote is too small.');return minimum;
}
export function maximumWrapperUSDC(quote:bigint,percent:string):bigint{
  if(!/^\d{1,2}(\.\d{1,2})?$/.test(percent))throw Error('Enter a quote tolerance from 0 to 5 percent.');
  const bps=parseUnits(percent,2);if(bps>500n||quote<0n)throw Error('Invalid USDC quote or tolerance.');
  return (quote*(10000n+bps)+9999n)/10000n;
}
export function wrapperUSDCAmount(text:string):bigint{
  if(!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(text))throw Error('Enter a nonnegative USDC amount with up to 6 decimals.');
  return parseUnits(text,6);
}
async function links(client:ReadClient,c:SaeroAddresses,blockNumber?:bigint){
  const address=target(c);
  for(const [fn,expected] of [['stream',c.streamingDistributor],['receipt',c.streamingDistributor],['USDC',c.USDC]] as const){
    const actual=await client.readContract({address,abi:COLLATERAL_ABI,functionName:fn,blockNumber});
    if(typeof actual!=='string'||actual.toLowerCase()!==expected.toLowerCase())throw Error('The collateral wrapper links do not match this deployment.');
  }
  return address;
}
export type CollateralSnapshot={receipts:bigint;shares:bigint;credit:bigint;paused:boolean;principal?:bigint;usdc?:bigint;quoteError?:string};
export async function readCollateral(client:ReadClient,c:SaeroAddresses,user:Address):Promise<CollateralSnapshot>{
  const block=await client.getBlock(),address=await links(client,c,block.number);
  const read=(functionName:string,args:readonly unknown[]=[])=>client.readContract({address,abi:COLLATERAL_ABI,functionName,args,blockNumber:block.number});
  const [receipts,shares,credit,paused]=await Promise.all([
    client.readContract({address:c.streamingDistributor,abi:STAKING_ERC20_ABI,functionName:'balanceOf',args:[user],blockNumber:block.number}),
    read('balanceOf',[user]),read('claimableUSDC',[user]),read('paused'),
  ]);
  try{const [principal,usdc]=await read('previewRedeem',[shares]);return {receipts,shares,credit,paused,principal,usdc};}
  catch{return {receipts,shares,credit,paused,quoteError:'Basket preview unavailable. Principal redemption and existing USDC claims remain available.'};}
}
export function collateralActions(client:ReadClient,write:StakingWriter,c:SaeroAddresses,user:Address,identity:()=>Promise<Address|undefined>){
  const send=walletSender(client,write,c,user,identity);
  return {
    quoteWrap:async(amount:bigint)=>{
      if(amount<=0n)throw Error('Amount must be positive.');
      const block=await client.getBlock(),address=await links(client,c,block.number);
      const [shares,usdc]=await Promise.all(['previewWrap','previewWrapUSDC'].map(functionName=>client.readContract({address,abi:COLLATERAL_ABI,functionName,args:[amount],blockNumber:block.number})));
      return {shares:shares as bigint,usdc:usdc as bigint,blockNumber:block.number};
    },
    async wrap(amount:bigint,minShares:bigint,maxUSDC:bigint){
      if(amount<=0n||minShares<=0n||maxUSDC<0n)throw Error('Invalid receipt amount, minimum shares or maximum USDC.');
      const address=await links(client,c);
      const required=await client.readContract({address,abi:COLLATERAL_ABI,functionName:'previewWrapUSDC',args:[amount]});
      if(required>maxUSDC)throw Error('The USDC contribution increased. Refresh the wrapper quote.');
      const balance=await client.readContract({address:c.USDC,abi:STAKING_ERC20_ABI,functionName:'balanceOf',args:[user]});
      if(balance<required)throw Error('Not enough USDC for the proportional contribution.');
      const allowance=await client.readContract({address:c.streamingDistributor,abi:STAKING_ERC20_ABI,functionName:'allowance',args:[user,address]});
      if(allowance<amount)await send(c.streamingDistributor,STAKING_ERC20_ABI,'approve',[address,amount]);
      if(maxUSDC>0n){
        const cashAllowance=await client.readContract({address:c.USDC,abi:STAKING_ERC20_ABI,functionName:'allowance',args:[user,address]});
        if(cashAllowance<maxUSDC)await send(c.USDC,STAKING_ERC20_ABI,'approve',[address,maxUSDC]);
      }
      return send(address,COLLATERAL_ABI,'wrap',[amount,maxUSDC,minShares,user]);
    },
    async redeem(shares:bigint,minPrincipal=0n,minUSDC=0n){
      if(shares<=0n||minPrincipal<0n||minUSDC<0n)throw Error('Invalid redemption amount.');
      const address=await links(client,c);return send(address,COLLATERAL_ABI,'redeem',[shares,minPrincipal,minUSDC,user]);
    },
    async claim(){const address=await links(client,c);return send(address,COLLATERAL_ABI,'claimUSDC',[user]);},
    async harvest(){const address=await links(client,c);return send(address,COLLATERAL_ABI,'harvestUSDC',[]);},
  };
}
