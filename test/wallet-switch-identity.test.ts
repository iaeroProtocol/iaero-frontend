import {afterEach,describe,expect,it,vi} from 'vitest';
import {switchedWalletIdentity} from '../src/live/client';
const user='0x1111111111111111111111111111111111111111';
afterEach(()=>vi.useRealTimers());
describe('read-only identity checks after a network switch',()=>{
 it('waits for temporarily empty accounts and a delayed chain ID without prompting the wallet again',async()=>{vi.useFakeTimers();let calls=0;const p={request:vi.fn(async({method}:any)=>method==='eth_accounts'?++calls<3?[]:[user]:calls<3?'0x1':'0x2105')},job=switchedWalletIdentity(p as any,()=>true,8453);await vi.runAllTimersAsync();expect(await job).toEqual({address:user,chainId:8453});expect(p.request.mock.calls.every(([r])=>['eth_accounts','eth_chainId'].includes(r.method))).toBe(true);expect(calls).toBe(3);});
 it('bounds a persistently empty session rather than re-requesting account permissions',async()=>{vi.useFakeTimers();const p={request:vi.fn(async({method}:any)=>method==='eth_accounts'?[]:'0x2105')},job=switchedWalletIdentity(p as any,()=>true,8453);await vi.runAllTimersAsync();expect(await job).toEqual({address:undefined,chainId:8453});expect(p.request).toHaveBeenCalledTimes(8);});
 it('does not adopt an old account when the active connection changes during a retry',async()=>{vi.useFakeTimers();let active=true;const p={request:vi.fn(async({method}:any)=>method==='eth_accounts'?[]:'0x2105')},job=switchedWalletIdentity(p as any,()=>active,8453),check=expect(job).rejects.toThrow('connection changed');await Promise.resolve();active=false;await vi.runAllTimersAsync();await check;});
 it('retries a transient read error but leaves an unresponsive wallet blocked',async()=>{vi.useFakeTimers();const p={request:vi.fn(async()=>{throw Error('Wallet offline');})},job=switchedWalletIdentity(p as any,()=>true,8453),check=expect(job).rejects.toThrow('offline');await vi.runAllTimersAsync();await check;expect(p.request).toHaveBeenCalledTimes(8);});
});
