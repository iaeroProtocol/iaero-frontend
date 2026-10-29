import type {Hash} from 'viem';
import type {BaseClient} from './client';

type Anchor={number:bigint;hash:Hash};
// A receipt can reach one provider node before another node's "latest" view.
// Read subsequent balances/allowances and simulations at an explicit canonical
// header at or after our confirmed transaction, without fabricating state.
export function receiptReadClient(source:BaseClient){
 let anchor:Anchor|undefined,incomplete=false,revision=0,pending:Promise<any>|undefined;
 const missing=new Set<string>();
 const remember=(receipt:any,hash:Hash)=>{
  if(receipt.status!=='success'||receipt.transactionHash?.toLowerCase()!==hash.toLowerCase())return;
  if(typeof receipt.blockNumber!=='bigint'||!/^0x[0-9a-f]{64}$/i.test(receipt.blockHash??'')){missing.add(hash.toLowerCase());incomplete=true;revision++;pending=undefined;return;}
  if(!anchor||receipt.blockNumber>=anchor.number)anchor={number:receipt.blockNumber,hash:receipt.blockHash};
  missing.delete(hash.toLowerCase());incomplete=missing.size>0;revision++;pending=undefined;
 };
 const loadHead=async()=>{
  if(incomplete)throw Error('The confirmed transaction block is unavailable. Refresh before the next step.');
  const required=anchor;
  if(!required)return source.getBlock({blockTag:'latest'});
  for(let attempt=0;attempt<3;attempt++){
   try{
    const latest=await source.getBlock({blockTag:'latest'});
    const receiptBlock=await source.getBlock({blockNumber:required.number});
    if(receiptBlock.hash?.toLowerCase()!==required.hash.toLowerCase())throw Error('Confirmed transaction block changed. Review its receipt before continuing.');
    if(latest.number===required.number&&latest.hash?.toLowerCase()!==required.hash.toLowerCase())throw Error('Confirmed transaction block changed. Review its receipt before continuing.');
    return latest.number>=required.number?latest:receiptBlock;
   }catch(error){if(error instanceof Error&&error.message.startsWith('Confirmed transaction block changed'))throw error;if(attempt===2)throw Error('Base has not caught up with the confirmed transaction. Wait a moment and retry the next step.');await new Promise(r=>setTimeout(r,100*(attempt+1)));}
  }
  throw Error('The confirmed transaction state is unavailable.');
 };
 const head=():Promise<any>=>{if(!pending){const version=revision;const job=loadHead().then(value=>version===revision?value:head()).finally(()=>{if(version===revision)pending=undefined;});pending=job;}return pending;};
 const pinned=async(request:any)=>anchor||incomplete?request.blockNumber===undefined&&(!request.blockTag||request.blockTag==='latest')?{...request,blockNumber:(await head()).number,blockTag:undefined}:request:request;
 const client={...source,
  getBlock:async(request:any={})=>anchor||incomplete?request.blockNumber===undefined&&(!request.blockTag||request.blockTag==='latest')?head():source.getBlock(request):source.getBlock(request),
  readContract:async(request:any)=>source.readContract(await pinned(request)),
  simulateContract:async(request:any)=>source.simulateContract(await pinned(request)),
  waitForTransactionReceipt:async(request:any)=>{const receipt=await source.waitForTransactionReceipt(request);remember(receipt,request.hash);return receipt;},
 } as BaseClient;
 return {client,remember,reset:()=>{anchor=undefined;incomplete=false;missing.clear();revision++;pending=undefined;},anchor:()=>anchor};
}
