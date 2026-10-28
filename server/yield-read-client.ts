import {createPublicClient,custom,keccak256,type Address} from 'viem';

type Client=ReturnType<typeof createPublicClient>;
type BatchPolicy={address:string;runtimeHash:string;batchSize:number};
const canonical=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);

// [VERIFIED: YIELD_MULTICALL_PROBE.json, 2026-10-28] Every provider must
// attest the configured runtime at the exact requested block. This reader is
// scoped to one collection; it never signs, sends, or shares pending work
// between Worker requests. An unavailable batching proof retains direct reads.
export function yieldContractReader(clients:Client[],chainId:number,policy:BatchPolicy){
 const batched=clients.map(client=>createPublicClient({
  chain:{id:chainId,name:'Yield observation '+chainId,nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[]}},contracts:{multicall3:{address:policy.address as Address}}},
  transport:custom({request:request=>client.request(request as any)},{retryCount:0}),
  batch:{multicall:{batchSize:policy.batchSize,wait:0}},ccipRead:false,
 }));
 const proofs=new Map<bigint,Promise<Client[]>>();
 const readers=(block:bigint)=>{
  let proof=proofs.get(block);
  if(!proof){
   proof=Promise.all(clients.map(c=>c.getCode({address:policy.address as Address,blockNumber:block})))
    .then(codes=>codes.every(code=>code&&keccak256(code).toLowerCase()===policy.runtimeHash.toLowerCase())?batched:clients)
    .catch(()=>clients);
   proofs.set(block,proof);
  }
  return proof;
 };
 return async(parameters:any)=>{
  if(typeof parameters.blockNumber!=='bigint')throw Error('yield_read_block_required');
  const verified=await readers(parameters.blockNumber),values=await Promise.all(verified.map(async(c,index)=>{
   try{return await c.readContract(parameters);}
   catch(error){
    // A provider may cap the aggregate although each original getter fits.
    // Retry that observer directly once, at the same block. Real reverts and
    // unavailable providers still fail; no observer or reward is omitted.
    if(c===clients[index])throw error;
    return clients[index].readContract(parameters);
   }
  }));
  if(values.some(value=>canonical(value)!==canonical(values[0])))throw Error('yield_read_disagreement');
  return values[0];
 };
}
