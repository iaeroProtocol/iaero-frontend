import {afterEach,expect,it,vi} from 'vitest';
import registry from '../config/base.registry.json';
import {fetchBootstrap,type BaseClient} from '../src/live/client';
import {accountReadScope} from '../src/live/account-read-client';
import type {Bootstrap} from '../src/live/types';
const boot={registry,snapshot:{independentProviders:2}} as unknown as Bootstrap;
afterEach(()=>vi.unstubAllGlobals());
it('shares only the in-flight bootstrap request and fetches again after it completes',async()=>{
 let release!:(response:Response)=>void;const held=new Promise<Response>(r=>release=r),fetcher=vi.fn().mockReturnValueOnce(held).mockResolvedValueOnce(Response.json(boot));vi.stubGlobal('fetch',fetcher);
 const a=fetchBootstrap(),b=fetchBootstrap();expect(a).toBe(b);expect(fetcher).toHaveBeenCalledTimes(1);release(Response.json(boot));expect(await a).toEqual(boot);expect(await b).toEqual(boot);expect(await fetchBootstrap()).toEqual(boot);expect(fetcher).toHaveBeenCalledTimes(2);
});
it('releases a failed shared bootstrap so a later request can recover',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({error:'Unavailable'},{status:503})).mockResolvedValueOnce(Response.json(boot));vi.stubGlobal('fetch',fetcher);const result=await Promise.allSettled([fetchBootstrap(),fetchBootstrap()]);expect(result.every(r=>r.status==='rejected')).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);expect(await fetchBootstrap()).toEqual(boot);expect(fetcher).toHaveBeenCalledTimes(2);
});
it('checks the current chain and header once for all display readers in a refresh',async()=>{
 const block={number:9000000n,timestamp:1793000000n},client={getChainId:vi.fn(async()=>8453),getBlock:vi.fn(async()=>block),readContract:vi.fn()} as unknown as BaseClient;
 const scope=await accountReadScope(client,boot);expect(await scope.getBlock()).toBe(block);expect(await scope.getBlock()).toBe(block);expect(await scope.getChainId()).toBe(8453);expect(client.getBlock).toHaveBeenCalledTimes(1);expect(client.getChainId).toHaveBeenCalledTimes(1);expect(scope).not.toBe(client);
});
it('does not start position reads for a connection on another chain',async()=>{
 const readContract=vi.fn(),client={getChainId:async()=>1,getBlock:async()=>({number:1n,timestamp:1n}),readContract} as unknown as BaseClient;await expect(accountReadScope(client,boot)).rejects.toThrow('not on Base');expect(readContract).not.toHaveBeenCalled();
});
