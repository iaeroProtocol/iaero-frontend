import {resolve} from 'node:path';
import {loadLedger,updateLedger} from './yield-ledger.ts';
import {createYieldService,yieldPosition} from './yield-engine.ts';
export {scanYieldHistory,verifyYieldReceipt,yieldReadSources} from './yield-engine.ts';
export const YIELD_STORE=resolve(process.cwd(),'.local-data','protocol-yield.sqlite');
const service=createYieldService({load:()=>loadLedger(YIELD_STORE,yieldPosition),update:change=>updateLedger(YIELD_STORE,yieldPosition,change)});
export const {syncProtocolYield,protocolYield,yieldHistory}=service;
