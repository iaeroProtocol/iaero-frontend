import type {Address} from 'viem';
// The reviewed per-transaction journal remains the inner lock. This outer lock
// keeps another tab from interleaving a write between steps of one workflow.
export async function walletWorkflow<T>(user:Address,run:()=>Promise<T>):Promise<T>{
  if(!navigator.locks)throw Error('Update your browser before sending wallet transactions.');
  return navigator.locks.request('iaero:workflow:8453:'+user.toLowerCase(),{ifAvailable:true},lock=>{
    if(!lock)throw Error('Another tab is processing a wallet workflow. Finish it before continuing.');return run();
  });
}
