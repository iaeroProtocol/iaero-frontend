import {ContractFunctionRevertedError,type Address,type Hash} from 'viem';
import type {BaseClient} from './client';
import {pendingTransaction} from '../protocol/pendingTransaction';

export const SWEEP_GAS_LIMIT=16_000_000n;
export const SWEEP_MAX_RETRIES=2;
export const SWEEP_MAX_SLIPPAGE_BPS=1000;
export type SweepRetryPolicy={maxRetries:2;maxSlippageBps:number;minimumUsdcByAttempt:bigint[];minimumIaeroByAttempt?:bigint[]};
export type SweepRetryEvent={stage:'swap'|'conversion'|'stake';attempt:number;slippageBps:number;hash?:Hash;exhausted?:boolean};
export class SweepPreflightRevert extends Error {}
export function retrySlippage(base:number,attempt:number){
 if(!Number.isInteger(base)||base<10||base>500||!Number.isInteger(attempt)||attempt<0||attempt>SWEEP_MAX_RETRIES)throw Error('Invalid sweep retry limits.');
 let value=base;for(let n=0;n<attempt;n++)value=Math.min(SWEEP_MAX_SLIPPAGE_BPS,Math.ceil(value*1.5));return value;
}
export function retryGas(estimate:bigint,attempt:number,previous=0n){
 if(estimate<=0n||estimate*130n>SWEEP_GAS_LIMIT*100n||!Number.isInteger(attempt)||attempt<0||attempt>SWEEP_MAX_RETRIES)throw Error('The transaction exceeds the supported gas budget.');
 let value=(estimate*130n+99n)/100n;for(let n=0;n<attempt;n++)value=(value*3n+1n)/2n;
 const boosted=(previous*3n+1n)/2n;if(boosted>value)value=boosted;
 return value>SWEEP_GAS_LIMIT?SWEEP_GAS_LIMIT:value;
}
export function contractReverted(error:unknown){
 for(let e:any=error,n=0;e&&n<12;e=e.cause,n++)if(e instanceof ContractFunctionRevertedError)return true;
 return false;
}
// Only an actual simulation revert receives this marker. A wallet error with
// no returned hash can represent a broadcast, so it must never receive it.
export function retryReadClient(client:BaseClient):BaseClient{
 return {...client,simulateContract:async(request:any)=>{
  try{return await client.simulateContract(request);}
  catch(error){if(contractReverted(error))throw new SweepPreflightRevert('The transaction no longer passes simulation.');throw error;}
 }} as BaseClient;
}
export async function verifiedRevertedAttempt(client:BaseClient,user:Address,to:Address,hash:Hash|undefined,error:unknown){
 if(error instanceof SweepPreflightRevert)return !hash&&!pendingTransaction(8453,user);
 // [VERIFIED: walletSender] This exact error follows an exact reverted receipt
 // and journal clearance. Independently re-read that receipt before retrying.
 if(!hash||!(error instanceof Error)||error.message!==`Transaction reverted: ${hash}`||pendingTransaction(8453,user))return false;
 const receipt=await client.getTransactionReceipt({hash});
 return receipt.status==='reverted'&&receipt.transactionHash.toLowerCase()===hash.toLowerCase()&&receipt.from?.toLowerCase()===user.toLowerCase()&&receipt.to?.toLowerCase()===to.toLowerCase();
}
