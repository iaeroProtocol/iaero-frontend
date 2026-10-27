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
