import {createPublicClient,custom} from 'viem';
import {base} from 'viem/chains';
import type {BaseClient} from './client';
import type {Bootstrap} from './types';

// Only balance/metadata/reward-preview getters use this client. Transaction
// simulation, quotes and sends keep the original unbatched execution client.
export function accountReadClient(client:BaseClient,boot:Bootstrap):BaseClient{
 if(!boot.contracts?.multicall3?.deployed||typeof client.request!=='function'||typeof client.multicall!=='function')return client;
 return createPublicClient({
  chain:{...base,contracts:{...base.contracts,multicall3:{address:boot.registry.sweep.multicall3}}},
  transport:custom({request:request=>client.request(request as any)},{retryCount:0}),
  batch:{multicall:{batchSize:16384,wait:0}},ccipRead:false,
 }) as unknown as BaseClient;
}

// One current header and chain check for all display readers in a refresh.
// This scope is never passed to transaction simulation or sending.
export async function accountReadScope(client:BaseClient,boot:Bootstrap):Promise<BaseClient>{
 const [chainId,block]=await Promise.all([client.getChainId(),client.getBlock()]);
 if(chainId!==8453)throw Error('The read connection is not on Base.');
 const reader=accountReadClient(client,boot);
 return {...reader,getChainId:async()=>chainId,getBlock:async()=>block} as BaseClient;
}
