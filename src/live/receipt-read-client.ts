import {isAddress,type Hash} from 'viem';
import type {BaseClient} from './client';

type Anchor={number:bigint;hash:Hash};
type KnownReceipt={transactionHash:Hash;blockNumber?:bigint;blockHash?:Hash;from?:string;to?:string};
// A receipt can reach one provider node before another node's "latest" view.
// Read subsequent balances/allowances and simulations at an explicit canonical
// header at or after our confirmed transaction, without fabricating state.
export function receiptReadClient(source:BaseClient){
 let anchor:Anchor|undefined,incomplete=false,revision=0,scope=0,pending:Promise<any>|undefined,repairing:Promise<void>|undefined;
 const missing=new Set<string>();
 const known=new Map<string,KnownReceipt>();
 const validHash=(hash:unknown):hash is Hash=>typeof hash==='string'&&/^0x[0-9a-f]{64}$/i.test(hash)&&!/^0x0{64}$/i.test(hash);
 const remember=(receipt:any,hash:Hash)=>{
  if(receipt.status!=='success'||receipt.transactionHash?.toLowerCase()!==hash.toLowerCase())return;
  known.set(hash.toLowerCase(),{transactionHash:hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,from:receipt.from,to:receipt.to});
  if(typeof receipt.blockNumber!=='bigint'||receipt.blockNumber<0n||!validHash(receipt.blockHash)){missing.add(hash.toLowerCase());incomplete=true;revision++;pending=undefined;return;}
  if(!anchor||receipt.blockNumber>=anchor.number)anchor={number:receipt.blockNumber,hash:receipt.blockHash};
  missing.delete(hash.toLowerCase());incomplete=missing.size>0;revision++;pending=undefined;
 };
 // Reconcile exact known transaction hashes, never erase a confirmation floor
 // or replay a write. A changed receipt must still be successful and match its
 // original sender/target, and its new header must agree with the canonical
 // block. Validate all known confirmations before adopting a changed anchor.
 const reconcile=():Promise<void>=>{
  if(repairing)return repairing;
  const beganIn=scope,entries=[...known.entries()];
  const job=(async()=>{
   if(!entries.length)return;
   if(typeof source.getTransactionReceipt!=='function')throw Error('Confirmed transaction block changed. Its receipt must be checked before continuing.');
   const proofs:({key:string;original:KnownReceipt;receipt:any}|undefined)[]=new Array(entries.length);let next=0;
   await Promise.all(Array.from({length:Math.min(4,entries.length)},async()=>{while(next<entries.length){const i=next++,[key,original]=entries[i];let receipt:any;
    try{receipt=await source.getTransactionReceipt({hash:original.transactionHash});}catch{throw Error('The confirmed transaction receipt is unavailable. Retry Base reads; no transaction will be repeated.');}
    if(beganIn!==scope)return;
    if(receipt.status!=='success'||receipt.transactionHash?.toLowerCase()!==key||typeof receipt.blockNumber!=='bigint'||receipt.blockNumber<0n||!validHash(receipt.blockHash)||!isAddress(receipt.from??'',{strict:false})||!isAddress(receipt.to??'',{strict:false})||(original.from&&original.from.toLowerCase()!==receipt.from.toLowerCase())||(original.to&&original.to.toLowerCase()!==receipt.to.toLowerCase()))throw Error('A confirmed transaction receipt changed or is incomplete. Review its wallet history before continuing.');
    const header=await source.getBlock({blockNumber:receipt.blockNumber});
    if(header.number!==receipt.blockNumber||!validHash(header.hash)||header.hash.toLowerCase()!==receipt.blockHash.toLowerCase())throw Error('The receipt and canonical Base block still disagree. Wait a moment and retry Base reads.');
    proofs[i]={key,original,receipt};
   }}));
   if(beganIn!==scope)return;
   const usable=proofs.filter((p):p is NonNullable<typeof p>=>!!p&&known.get(p.key)===p.original);
   const number=usable.reduce((n,p)=>p.receipt.blockNumber>n?p.receipt.blockNumber:n,anchor?.number??0n);
   const header=await source.getBlock({blockNumber:number});
   if(header.number!==number||!validHash(header.hash))throw Error('The confirmed transaction header is invalid. Retry Base reads before continuing.');
   if(usable.some(p=>p.receipt.blockNumber===number&&p.receipt.blockHash.toLowerCase()!==header.hash.toLowerCase()))throw Error('The receipt and canonical Base block still disagree. Wait a moment and retry Base reads.');
   if(beganIn!==scope)return;
   // New confirmations during the read retain their higher floor and are
   // checked by the next head proof; an old account response cannot restore it.
   for(const p of usable)if(known.get(p.key)===p.original){known.set(p.key,{transactionHash:p.original.transactionHash,blockNumber:p.receipt.blockNumber,blockHash:p.receipt.blockHash,from:p.receipt.from,to:p.receipt.to});missing.delete(p.key);}
   if(!anchor||number>=anchor.number)anchor={number,hash:header.hash};
   incomplete=missing.size>0;revision++;pending=undefined;
  })().finally(()=>{if(repairing===job)repairing=undefined;});repairing=job;return job;
 };
 const loadHead=async(repairs=0):Promise<any>=>{
  if(incomplete){
   const beganIn=scope;let tries=0;
   while(incomplete&&tries<4){const rows=await Promise.all([...missing].map(async hash=>{try{return {hash:hash as Hash,receipt:await source.getTransactionReceipt({hash:hash as Hash})};}catch{return undefined;}}));
   // A read retry reconciles known transaction hashes; it never resubmits a
   // transaction or clears an unverified receipt floor. Account resets win.
   if(beganIn!==scope)return loadHead();
   for(const row of rows)if(row?.receipt.status==='success'&&row.receipt.transactionHash?.toLowerCase()===row.hash.toLowerCase()&&typeof row.receipt.blockNumber==='bigint'&&row.receipt.blockNumber>=0n&&validHash(row.receipt.blockHash)){
    const original=known.get(row.hash.toLowerCase());
    if(original?.from&&original.from.toLowerCase()!==row.receipt.from?.toLowerCase()||original?.to&&original.to.toLowerCase()!==row.receipt.to?.toLowerCase())throw Error('A confirmed transaction receipt changed identity. Review its wallet history before continuing.');
    remember(row.receipt,row.hash);
   }
   if(incomplete&&++tries<4)await new Promise(r=>setTimeout(r,250*tries));}
   if(incomplete)throw Error('The confirmed transaction block is unavailable. Retry Base reads once its receipt is available.');
  }
  const required=anchor;
  if(!required)return source.getBlock({blockTag:'latest'});
  for(let attempt=0;attempt<3;attempt++){
   try{
    const [latest,receiptBlock]=await Promise.all([source.getBlock({blockTag:'latest'}),source.getBlock({blockNumber:required.number})]);
    if(typeof latest.number!=='bigint'||latest.number<0n||receiptBlock.number!==required.number||!validHash(latest.hash))throw Error('Confirmed transaction header is invalid. Refresh before continuing.');
    if(receiptBlock.hash?.toLowerCase()!==required.hash.toLowerCase()||latest.number===required.number&&latest.hash?.toLowerCase()!==required.hash.toLowerCase()){
     if(repairs>=2)throw Error('Confirmed transaction block changed. The current receipt and Base header must agree before continuing.');
     await reconcile();return loadHead(repairs+1);
    }
    if(anchor!==required||incomplete)return loadHead(repairs);
    return latest.number>=required.number?latest:receiptBlock;
   }catch(error){if(error instanceof Error&&(error.message.startsWith('Confirmed transaction block changed')||error.message.startsWith('Confirmed transaction header is invalid')))throw error;if(attempt===2)throw Error('Base has not caught up with the confirmed transaction. Wait a moment and retry the next step.');await new Promise(r=>setTimeout(r,100*(attempt+1)));}
  }
  throw Error('The confirmed transaction state is unavailable.');
 };
 const head=():Promise<any>=>{if(!pending){const job=loadHead().finally(()=>{if(pending===job)pending=undefined;});pending=job;}return pending;};
 const pinned=async(request:any)=>anchor||incomplete?request.blockNumber===undefined&&(!request.blockTag||request.blockTag==='latest')?{...request,blockNumber:(await head()).number,blockTag:undefined}:request:request;
 const client={...source,
  getBlock:async(request:any={})=>anchor||incomplete?request.blockNumber===undefined&&(!request.blockTag||request.blockTag==='latest')?head():source.getBlock(request):source.getBlock(request),
  readContract:async(request:any)=>source.readContract(await pinned(request)),
  simulateContract:async(request:any)=>source.simulateContract(await pinned(request)),
  estimateContractGas:async(request:any)=>source.estimateContractGas(await pinned(request)),
  waitForTransactionReceipt:async(request:any)=>{const startedIn=scope,receipt=await source.waitForTransactionReceipt(request);if(startedIn===scope)remember(receipt,request.hash);return receipt;},
 } as BaseClient;
 return {client,remember,reconcile,reset:()=>{anchor=undefined;incomplete=false;missing.clear();known.clear();scope++;revision++;pending=undefined;repairing=undefined;},anchor:()=>anchor};
}
