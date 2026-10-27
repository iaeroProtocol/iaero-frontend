import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({init:vi.fn()}));
vi.mock('@walletconnect/ethereum-provider',()=>({EthereumProvider:{init:mocks.init}}));
beforeEach(()=>{vi.resetModules();mocks.init.mockReset();vi.stubGlobal('window',{location:{origin:'https://app.example'}});});
afterEach(()=>vi.unstubAllGlobals());
const provider=()=>({session:{test:true},request:vi.fn(),connect:vi.fn(),disconnect:vi.fn(),on:vi.fn(),removeListener:vi.fn()});
it('does not reuse the previous provider after a failed SDK disconnect',async()=>{const first=provider(),second=provider();first.disconnect.mockRejectedValue(Error('Relay unavailable'));mocks.init.mockResolvedValueOnce(first).mockResolvedValueOnce(second);const wallet=await import('../src/live/walletconnect');expect(await wallet.mobileWalletProvider()).toBe(first);await expect(wallet.disconnectMobileWallet()).rejects.toThrow('Relay unavailable');expect(await wallet.mobileWalletProvider()).toBe(second);expect(mocks.init).toHaveBeenCalledTimes(2);});
it('allows a retry after SDK initialization fails',async()=>{mocks.init.mockRejectedValueOnce(Error('Offline')).mockResolvedValueOnce(provider());const wallet=await import('../src/live/walletconnect');await expect(wallet.mobileWalletProvider()).rejects.toThrow('could not initialize');expect(await wallet.mobileWalletProvider()).toBeDefined();expect(mocks.init).toHaveBeenCalledTimes(2);});
