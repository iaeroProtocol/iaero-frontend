import {it,expect} from 'vitest';
import {liqPositionNote} from '../src/live/position-model';
const live=(patch:any={})=>({boot:{liqStakingReady:true},loading:false,liqPosition:{balance:10n,unlockTime:1000,timestamp:2000,paused:false,...patch}}) as any;
it('distinguishes known unlocked, locked, paused and zero stake states',()=>{expect(liqPositionNote(live())).toContain('withdrawals available');expect(liqPositionNote(live({unlockTime:3000}))).toContain('Locked until');expect(liqPositionNote(live({paused:true}))).toContain('contract paused');expect(liqPositionNote(live({balance:0n}))).toBe('No LIQ currently staked');});
it('does not infer zero or an unlocked state from failed reads',()=>{expect(liqPositionNote(live({balance:undefined}))).toBe('Staked balance unavailable');expect(liqPositionNote(live({unlockTime:undefined}))).toBe('Unlock status unavailable');expect(liqPositionNote({...live(),liqPosition:undefined,loading:true})).toContain('Reading');});
