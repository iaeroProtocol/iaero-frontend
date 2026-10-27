import {describe,expect,it} from 'vitest';
import {stringToHex} from 'viem';
import registry from '../config/base.registry.json';
import {readLiqCirculation,readProtocolMarketMetrics,reservePrice,clSpotPrice} from '../server/protocol-metrics';
import {checkQuoteServiceResponse,SweepQuoteError} from '../server/sweep-quote';
const legacyRegistry={...registry,sweep:{...registry.sweep,aeroIaeroClPool:undefined}};
const E18=10n**18n,snapshot={block:'123',timestamp:1792992000,independentProviders:2};
function fixture(reverse=false){
  const pools=new Map([
    [registry.sweep.aeroUsdcPool,{tokens:[registry.aero.token,registry.legacy.USDC],reserves:[100n*E18,64000000n,0n],stable:false}],
    [registry.sweep.aeroIaeroPool,{tokens:[registry.legacy.iAERO,registry.aero.token],reserves:[100n*E18,95n*E18,0n],stable:false}],
    [registry.marketData.liqUsdcPool,{tokens:[registry.legacy.LIQ,registry.legacy.USDC],reserves:[100n*E18,10000000n,0n],stable:false}]
  ]);
  if(reverse)for(const p of pools.values()){p.tokens.reverse();[p.reserves[0],p.reserves[1]]=[p.reserves[1],p.reserves[0]];}
  const treasury='0x1111111111111111111111111111111111111111',beneficiary='0x2222222222222222222222222222222222222222';
  const amounts={treasury:1000000n*E18,vesting:20000000n*E18,vested:2000000n*E18};
  const read=async(address:string,signature:string,args:readonly unknown[]=[]):Promise<any>=>{
    const name=signature.match(/function (\w+)/)![1],pool=pools.get(address);
    if(name==='decimals')return address===registry.legacy.USDC?6:18;
    if(name==='totalSupply')return 20000000n*E18;
    if(name==='treasury')return treasury;
    if(name==='LIQ')return registry.legacy.LIQ;
    if(name==='balanceOf')return args[0]===treasury?amounts.treasury:amounts.vesting;
    if(name==='streams')return [beneficiary,10000000n*E18,0n,1n,2000000000n];
    if(name==='vested')return amounts.vested;
    if(pool){if(name==='token0')return pool.tokens[0];if(name==='token1')return pool.tokens[1];if(name==='POOL_TYPE')return stringToHex(pool.stable?'V2_STABLE':'V2_VOLATILE',{size:32});if(name==='getReserves')return pool.reserves;}
    throw Error('Unexpected read');
  };
  return {pools,read,amounts};
}
describe('finalized protocol reserve metrics',()=>{
  it.each([false,true])('handles token order reverse=%s and preserves USDC/token decimal scales',async reverse=>{
    const f=fixture(reverse),m=await readProtocolMarketMetrics(f.read,legacyRegistry,1000n*E18,snapshot);
    expect(m.aeroPriceUsdcWad).toBe('640000000000000000');expect(m.iaeroPegWad).toBe('950000000000000000');expect(m.tvlUsdcWad).toBe((640n*E18).toString());expect(m.liqMarketCapUsdcWad).toBe((300000n*E18).toString());expect(m.asOfBlock).toBe('123');expect(m.readProviders).toBe(2);expect(m.errors).toEqual([]);
  });
  it('does not invent a peg or price for an empty pool or invalid decimals',()=>{
    expect(reservePrice(0n,1n,18,6)).toBeNull();expect(reservePrice(1n,0n,18,6)).toBeNull();expect(reservePrice(1n,1n,37,6)).toBeNull();
  });
  it.each(['wrong pair','stable pool'])('rejects a %s without removing other available metrics',async condition=>{
    const f=fixture(),p=f.pools.get(registry.sweep.aeroUsdcPool)!;
    if(condition==='wrong pair')p.tokens[1]=registry.legacy.LIQ;else p.stable=true;
    const m=await readProtocolMarketMetrics(f.read,legacyRegistry,1000n*E18,snapshot);
    expect(m.aeroPriceUsdcWad).toBeNull();expect(m.tvlUsdcWad).toBeNull();expect(m.iaeroPegWad).toBeTruthy();expect(m.liqMarketCapUsdcWad).toBeTruthy();expect(m.errors).toHaveLength(1);
  });
  it('keeps market cap unknown when supply is unavailable and leaves other prices valid',async()=>{
    const f=fixture(),m=await readProtocolMarketMetrics(async(a,s)=>{if(s.includes('totalSupply'))throw Error('read failed');return f.read(a,s);},registry,1000n*E18,snapshot);
    expect(m.liqMarketCapUsdcWad).toBeNull();expect(m.liqPriceUsdcWad).toBeTruthy();expect(m.tvlUsdcWad).toBeTruthy();
  });
  it('returns unavailable metrics on failed reads without throwing or substituting prices',async()=>{
    const m=await readProtocolMarketMetrics(async()=>{throw Error('provider mismatch');},registry,1000n*E18,snapshot);
    expect(m.aeroPriceUsdcWad).toBeNull();expect(m.iaeroPegWad).toBeNull();expect(m.tvlUsdcWad).toBeNull();expect(m.liqMarketCapUsdcWad).toBeNull();expect(m.errors.length).toBeGreaterThan(0);
  });
  it('reports known zero backing and zero circulation as zero',async()=>{
    const f=fixture();f.amounts.treasury=4000000n*E18;
    const m=await readProtocolMarketMetrics(f.read,legacyRegistry,0n,snapshot);
    expect(m.tvlUsdcWad).toBe('0');expect(m.liqMarketCapUsdcWad).toBe('0');
  });
});
describe('LIQ circulating supply',()=>{
  it('excludes treasury and only unvested funds at the pinned timestamp, retaining vested unclaimed LIQ',async()=>{
    const f=fixture(),times:unknown[]=[];
    const c=await readLiqCirculation(async(a,s,args)=>{if(s.includes('function vested('))times.push(args?.[1]);return f.read(a,s,args);},registry,20000000n*E18,snapshot.timestamp);
    expect(c.circulating).toBe(3000000n*E18);expect(c.unvested).toBe(16000000n*E18);expect(c.treasuryBalance).toBe(1000000n*E18);
    expect(times).toEqual([BigInt(snapshot.timestamp),BigInt(snapshot.timestamp)]);
  });
  it.each(['treasury','vested','streams','balanceOf'])('keeps cap unknown if %s cannot be verified, preserving unrelated prices',async name=>{
    const f=fixture(),m=await readProtocolMarketMetrics(async(a,s,args)=>{if(s.includes('function '+name+'('))throw Error('unverified');return f.read(a,s,args);},registry,1000n*E18,snapshot);
    expect(m.liqMarketCapUsdcWad).toBeNull();expect(m.liqCirculatingSupply).toBeNull();expect(m.aeroPriceUsdcWad).toBeTruthy();
  });
  it('rejects incorrect token links and inconsistent exclusions instead of clamping',async()=>{
    const f=fixture();await expect(readLiqCirculation(async(a,s,args)=>s.includes('function LIQ(')?registry.legacy.USDC:f.read(a,s,args),registry,20000000n*E18,snapshot.timestamp)).rejects.toThrow('links');
    f.amounts.treasury=5000000n*E18;await expect(readLiqCirculation(f.read,registry,20000000n*E18,snapshot.timestamp)).rejects.toThrow('supply');
    f.amounts.treasury=0n;f.amounts.vesting=1n;await expect(readLiqCirculation(f.read,registry,20000000n*E18,snapshot.timestamp)).rejects.toThrow('supply');
  });
});
describe('safe quote failure reasons',()=>{
  it.each([[429,'RATE_LIMITED'],[401,'QUOTE_AUTHENTICATION'],[403,'QUOTE_ACCESS_DENIED'],[503,'QUOTE_SERVICE_UNAVAILABLE']] as const)('keeps HTTP %s separate from token liquidity', (status,code)=>{
    try{checkQuoteServiceResponse(status,{error:'untrusted upstream text https://private.invalid/key'});throw Error('Should fail');}catch(e){expect(e).toBeInstanceOf(SweepQuoteError);expect((e as SweepQuoteError).code).toBe(code);expect((e as Error).message).not.toContain('https:');}
  });
  it('identifies the exact VVV/wstETH no-route response separately from pricing',()=>{
    try{checkQuoteServiceResponse(200,{liquidityAvailable:false});throw Error('Should fail');}catch(e){expect((e as SweepQuoteError).code).toBe('NO_ROUTE_FOR_AMOUNT');expect((e as Error).message).toContain('exact amount');}
    expect(()=>checkQuoteServiceResponse(200,{liquidityAvailable:true})).not.toThrow();
  });
  it('keeps unsupported tokens distinct from a small-order no-route response',()=>{
    try{checkQuoteServiceResponse(422,{name:'SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE'});throw Error('Should fail');}catch(e){expect((e as SweepQuoteError).code).toBe('TOKEN_NOT_SUPPORTED');}
  });
});

it.each([false,true])('uses the current CL pool spot for the iAERO peg, reverse=%s',async reverse=>{
 const f=fixture(),Q96=2n**96n,read=async(address:string,signature:string,args:readonly unknown[]=[])=>{if(address!==registry.sweep.aeroIaeroClPool)return f.read(address,signature,args);const fn=signature.match(/function (\w+)/)![1];if(fn==='token0')return reverse?registry.aero.token:registry.legacy.iAERO;if(fn==='token1')return reverse?registry.legacy.iAERO:registry.aero.token;if(fn==='slot0')return [reverse?Q96/2n:2n*Q96,0,0,0,0,true];if(fn==='liquidity')return 100n;throw Error(fn);};
 const m=await readProtocolMarketMetrics(read,registry,1000n*E18,snapshot);expect(m.iaeroPegWad).toBe((4n*E18).toString());expect(m.iaeroPriceUsdcWad).toBe('2560000000000000000');expect(m.errors).toEqual([]);
});
it('does not replace a failed configured CL spot with the old thin V2 price',async()=>{const f=fixture(),m=await readProtocolMarketMetrics(f.read,registry,1000n*E18,snapshot);expect(m.iaeroPegWad).toBeNull();expect(m.iaeroPriceUsdcWad).toBeNull();expect(m.aeroPriceUsdcWad).toBe('640000000000000000');expect(m.errors.some(e=>e.includes('CL pool'))).toBe(true);});
it('handles CL decimal scaling and invalid prices exactly',()=>{expect(clSpotPrice(2n**96n,true,18,6)).toBe(10n**30n);expect(clSpotPrice(0n,true,18,18)).toBeNull();expect(clSpotPrice(2n**160n,false,18,18)).toBeNull();expect(clSpotPrice(1n,false,37,18)).toBeNull();});
