import {it,expect} from 'vitest';
import {configuredBaseReads} from '../server/read-rpc-policy';
import {readCoverage,acceptedReadCoverage} from '../src/protocol-data/read-coverage';
import {yieldReadSources} from '../server/yield-engine';
import {parseRpcSources} from '../worker/index';
const base='https://base-mainnet.g.alchemy.com/v2/test-read-key';
it('accepts the owner-approved single Alchemy source without accepting arbitrary single sources',()=>{expect(configuredBaseReads(JSON.stringify([base]))).toEqual([base]);for(const urls of [[],['https://one.example/key'],[base,base],['http://base-mainnet.g.alchemy.com/key']])expect(()=>configuredBaseReads(JSON.stringify(urls))).toThrow();});
it('labels one observer honestly and keeps independent launch acceptance at two',()=>{const coverage=readCoverage(1);expect(coverage).toMatchObject({provider:'Alchemy',providers:1,independentlyVerified:false,singleProviderAccepted:true,independentLaunchProvidersRequired:2});expect(acceptedReadCoverage(1,coverage)).toBe(true);expect(acceptedReadCoverage(1)).toBe(false);expect(acceptedReadCoverage(0,coverage)).toBe(false);expect(acceptedReadCoverage(2)).toBe(true);});
it('derives all three Alchemy sources without an Infura endpoint or key',()=>{const sources=yieldReadSources([base]);expect(sources).toHaveLength(3);expect(sources.map(s=>s.urls.length)).toEqual([1,1,1]);expect(sources.flatMap(s=>s.urls).every(u=>new URL(u).hostname.endsWith('.alchemy.com'))).toBe(true);const parsed=parseRpcSources(JSON.stringify(Object.fromEntries(sources.map(s=>[s.source.chainId,s.urls]))));expect(parsed[8453]).toEqual([base]);});
