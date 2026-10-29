export type TransactionStage='checking-wallet'|'simulating'|'requesting-wallet';
export const WALLET_READ_TIMEOUT_MS=15000;
// Only account/network reads are bounded. A write may already have reached
// the wallet: never time it out, clear its journal or retry it here.
export async function boundedWalletRead<T>(read:()=>Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([Promise.resolve().then(read),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('The wallet did not answer its account or network check. Open your wallet, check its connection to Base, then retry. No new transaction request was sent.')),WALLET_READ_TIMEOUT_MS);})]);}
 finally{clearTimeout(timer);}
}
export function claimStageText(stage:TransactionStage,batch:{number:number;total:number}){
 const label='claim batch '+batch.number+' of '+batch.total;
 return stage==='checking-wallet'?'Checking your wallet for '+label+'…':stage==='simulating'?'Simulating '+label+' on Base…':'Confirm '+label+' in your wallet';
}
