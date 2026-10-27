import {it,expect} from 'vitest';
import registry from '../config/base.registry.json';
import policy from '../config/protocol-yield.json';
import {recordBoundary,sharedYieldWindowStart} from '../server/yield-engine';
import {blankLedger} from '../src/protocol-data/yield-model';
it('starts the short all-chain window at the latest verified chain-history origin',()=>{expect(sharedYieldWindowStart(1792631969,1793082433,[1792631969,1792635131,1792635128])).toEqual({origin:1792635131,start:1792635131});});
it('switches to the exact rolling week after that common origin has a full week',()=>{const origin=1792635131,end=origin+604800+123;expect(sharedYieldWindowStart(1792631969,end,[1792631969,origin,1792635128])).toEqual({origin,start:end-604800});});
it('reads faster chains back to the shared finalized cutoff instead of including future reward state',async()=>{
 const origin=Date.parse(policy.positionCreatedAt)/1000+2*604800,at:number[]=[],E18=10n**18n;
 const contexts=policy.chains.map((source,i)=>({source:{...source,historyFromBlock:'0',seedGauges:[]},clients:[{},{}],block:BigInt(200+i*10),timestamp:origin+200+i*10,header:async(n:bigint)=>({timestamp:BigInt(origin)+n,hash:'0x'+'11'.repeat(32)}),read:async(address:string,signature:string,_args:unknown[],block:bigint)=>{const fn=signature.match(/^function (\w+)/)![1];at.push(Number(block));if(fn==='allocatedGauges')return [];if(fn==='staked')return {amount:1000n*E18};if(fn==='token0')return registry.aero.token;if(fn==='token1')return registry.legacy.USDC;if(fn==='getReserves')return [100n*E18,100000000n,0n];if(fn==='decimals')return address===registry.legacy.USDC?6:18;throw Error(fn);}}));
 const state=blankLedger('alignment'),point=await recordBoundary(state,contexts as any,origin+195,{id:'aligned:test'});expect(point?.timestamp).toBe(origin+195);expect(point?.pendingComplete).toBe(true);expect(at.every(block=>block===195)).toBe(true);expect(point?.tvlUsdcWad).toBe((1000n*E18).toString());
});
it('stores a one-provider read only as an explicitly observed boundary',async()=>{
 const origin=Date.parse(policy.positionCreatedAt)/1000,contexts=policy.chains.map(source=>({source:{...source,historyFromBlock:'0',seedGauges:[]},clients:source.key==='robinhood'?[{}]:[{},{}],block:200n,timestamp:origin+200,header:async(n:bigint)=>({timestamp:BigInt(origin)+n,hash:'0x'+'11'.repeat(32)}),read:async(address:string,signature:string)=>{const fn=signature.match(/^function (\w+)/)![1];if(fn==='allocatedGauges')return [];if(fn==='staked')return {amount:1000n};if(fn==='token0')return registry.aero.token;if(fn==='token1')return registry.legacy.USDC;if(fn==='getReserves')return [100n,100000000n,0n];if(fn==='decimals')return address===registry.legacy.USDC?6:18;throw Error(fn);}})),state=blankLedger('observed');
 expect(await recordBoundary(state,contexts as any,origin+100)).toBeUndefined();
 const point=await recordBoundary(state,contexts as any,origin+100,{id:'observed-boundary:'+String(origin+100),allowSingleProvider:true});
 expect(point?.pendingComplete).toBe(false);expect(point?.observedComplete).toBe(true);expect(point?.observationProviders?.[4663]).toBe(1);
 expect(await recordBoundary(state,contexts as any,origin+100,{id:point!.id})).toBeUndefined();
 const failed=blankLedger('retry');failed.snapshots.push({...point!,observedComplete:false});
 const recovered=await recordBoundary(failed,contexts as any,origin+100,{id:point!.id,allowSingleProvider:true});
 expect(recovered?.id).toContain(':retry:');expect(failed.snapshots).toHaveLength(2);expect(failed.snapshots[0].observedComplete).toBe(false);expect(failed.snapshots[1].observedComplete).toBe(true);
});
