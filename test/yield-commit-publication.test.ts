import {it,expect,vi} from 'vitest';
import {createYieldService} from '../server/yield-engine';
import {blankLedger} from '../src/protocol-data/yield-model';
it('never publishes an observation whose store commit failed',async()=>{
 let saved=blankLedger('test'),fail=false,clock=1793100000000;
 const now=vi.spyOn(Date,'now').mockImplementation(()=>clock);
 const store={load:async()=>structuredClone(saved),update:async <T>(change:(state:typeof saved)=>Promise<T>)=>{const draft=structuredClone(saved),result=await change(draft);if(fail)throw Error('commit_failed');saved=draft;return result;}};
 const service=createYieldService(store,{sources:()=>[],automaticCatchup:false}),boot=async()=>({snapshot:{timestamp:clock/1000},metrics:{backingAero:'100',market:{tvlUsdcWad:'1000'}}});
 try{await service.syncProtocolYield([],boot);const before=await service.protocolYield([],boot);fail=true;clock+=10000;await expect(service.syncProtocolYield([],boot)).rejects.toThrow('yield_sync_unavailable');const after=await service.protocolYield([],boot);expect(after.readAtMs).toBe(before.readAtMs);expect(after.storedObservations).toBe(before.storedObservations);expect(after.syncUnavailable).toBe(true);}finally{now.mockRestore();}
});
