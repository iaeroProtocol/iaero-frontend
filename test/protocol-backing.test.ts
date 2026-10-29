import {describe,expect,it,vi} from 'vitest';
import {readProtocolBacking} from '../server/protocol-backing';
import registry from '../config/base.registry.json';
import manifest from '../config/aero-deposit.json';
const c={verified:true,reason:'verified',vault:manifest.vault as `0x${string}`},config=registry as any;
function reader(ids:bigint[],owner=manifest.vault){return vi.fn(async(_at:string,signature:string,args:readonly any[]=[])=>{if(signature.includes('heldTokenIds'))return ids;if(signature.includes('ownerOf'))return owner;if(signature.includes('isHeld'))return true;if(signature.includes('staked'))return {amount:args[0]===1584n?100n:10n};throw Error('Unexpected read');});}
describe('all protocol backing after new deposits',()=>{
 it('adds separate deposit stakes without counting the primary or duplicate ids twice',async()=>{const read=reader([1584n,700n,701n,700n]),value=await readProtocolBacking(read,config,c,100n);expect(value.total).toBe(120n);expect(value.additional).toBe(20n);expect(value.heldTokenIds).toEqual(['1584','700','701']);expect(value.complete).toBe(true);});
 it('keeps the primary when the vault holds no additional stakes',async()=>{expect((await readProtocolBacking(reader([]),config,c,100n)).total).toBe(100n);});
 it('labels a primary-only fallback when the vault connection is unverified',async()=>{const read=reader([]),value=await readProtocolBacking(read,config,{verified:false,reason:'unavailable'},100n);expect(value.scope).toBe('primary-only');expect(value.complete).toBe(false);expect(read).not.toHaveBeenCalled();});
 it('does not publish a partial sum when custody or a stake read fails',async()=>{for(const read of [reader([700n],'0x1111111111111111111111111111111111111111'),vi.fn(async()=>{throw Error('RPC unavailable');})]){const value=await readProtocolBacking(read,config,c,100n);expect(value.scope).toBe('unavailable');expect(value.total).toBeUndefined();}});
 it('bounds discovery and refuses malformed ids',async()=>{for(const ids of [[0n],[2n**256n],Array(1025).fill(700n)]){const value=await readProtocolBacking(reader(ids),config,c,100n);expect(value.total).toBeUndefined();expect(value.complete).toBe(false);}});
});
