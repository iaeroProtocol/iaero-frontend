import {isAddress,stringToHex} from 'viem';
export type ProtocolMarketMetrics={iaeroPriceUsdcWad?:string|null;iaeroTotalSupply?:string|null;iaeroDecimals?:number|null;backingPerIaeroWad?:string|null;aeroPriceUsdcWad:string|null;iaeroPegWad:string|null;tvlUsdcWad:string|null;liqPriceUsdcWad:string|null;liqMarketCapUsdcWad:string|null;liqTotalSupply:string|null;liqCirculatingSupply:string|null;liqUnvested:string|null;liqTreasuryBalance:string|null;liqTreasuryAddress:string|null;liqVestingAddress:string|null;liqDecimals:number|null;asOfBlock:string;blockTimestamp:number;readAtMs:number;readProviders:number;errors:string[]};
type Reader=(address:string,signature:string,args?:readonly unknown[])=>Promise<any>;
type Config={legacy:{USDC:string;iAERO:string;LIQ:string};aero:{token:string};sweep:{aeroUsdcPool:string;aeroIaeroPool:string;aeroIaeroClPool?:string};marketData:{liqUsdcPool:string;liqCirculation:{treasurySourceVault:string;vesting:string;streamIds:string[]}}};
type Pool={asset:bigint;quote:bigint};
const E18=10n**18n;
export function reservePrice(asset:bigint,quote:bigint,assetDecimals:number,quoteDecimals:number):bigint|null{
  if(asset<=0n||quote<=0n||![assetDecimals,quoteDecimals].every(d=>Number.isInteger(d)&&d>=0&&d<=36))return null;
  const rate=quote*10n**BigInt(assetDecimals)*E18/(asset*10n**BigInt(quoteDecimals));return rate>0n?rate:null;
}
export function clSpotPrice(sqrtPriceX96:bigint,assetIsToken0:boolean,assetDecimals:number,quoteDecimals:number):bigint|null{
 if(sqrtPriceX96<=0n||sqrtPriceX96>=2n**160n||![assetDecimals,quoteDecimals].every(d=>Number.isInteger(d)&&d>=0&&d<=36))return null;
 const ratio=sqrtPriceX96*sqrtPriceX96,Q192=2n**192n,rate=(assetIsToken0?ratio:Q192)*10n**BigInt(assetDecimals)*E18/((assetIsToken0?Q192:ratio)*10n**BigInt(quoteDecimals));return rate>0n&&rate<2n**256n?rate:null;
}
// [VERIFIED: ProtocolContext.tsx loadStats and LIQLinearVester.sol]
// Preserve the established circulating definition using pinned chain time and
// actual stream totals. Claimable vested funds remain in circulation.
export async function readLiqCirculation(read:Reader,c:Config,total:bigint,timestamp:number){
  const policy=c.marketData.liqCirculation;
  if(!policy||policy.streamIds.length!==2||new Set(policy.streamIds).size!==2||policy.streamIds.some(id=>!['0','1'].includes(id)))throw Error('Invalid LIQ circulation configuration');
  const [treasury,token]=await Promise.all([
    read(policy.treasurySourceVault,'function treasury() view returns(address)'),read(policy.vesting,'function LIQ() view returns(address)')
  ]);
  if(!isAddress(treasury)||BigInt(treasury)===0n||treasury.toLowerCase()===policy.vesting.toLowerCase()||String(token).toLowerCase()!==c.legacy.LIQ.toLowerCase())throw Error('Unverified LIQ exclusion links');
  const [treasuryBalance,vestingBalance,streams]=await Promise.all([
    read(c.legacy.LIQ,'function balanceOf(address) view returns(uint256)',[treasury]).then(BigInt),
    read(c.legacy.LIQ,'function balanceOf(address) view returns(uint256)',[policy.vesting]).then(BigInt),
    Promise.all(policy.streamIds.map(async id=>{
      const [info,rawVested]=await Promise.all([
        read(policy.vesting,'function streams(uint256) view returns(address,uint128,uint128,uint64,uint64)',[BigInt(id)]),
        read(policy.vesting,'function vested(uint256,uint256) view returns(uint256)',[BigInt(id),BigInt(timestamp)])
      ]);
      if(!Array.isArray(info)||info.length!==5||!isAddress(String(info[0]))||BigInt(info[0])===0n)throw Error('Invalid vesting stream');
      const allocated=BigInt(info[1]),released=BigInt(info[2]),vested=BigInt(rawVested),start=BigInt(info[3]),end=BigInt(info[4]);
      if(allocated<0n||released<0n||released>vested||vested>allocated||start>=end)throw Error('Inconsistent vesting amounts');
      return allocated-vested;
    }))
  ]);
  const unvested=streams.reduce((sum,value)=>sum+value,0n);
  if(treasuryBalance<0n||vestingBalance<unvested||unvested+treasuryBalance>total)throw Error('Inconsistent circulating supply');
  return {circulating:total-unvested-treasuryBalance,unvested,treasuryBalance,treasury,vesting:policy.vesting};
}
// [VERIFIED: existing client-prices.ts reserve ratios and api/stats/route.ts]
// Display-only volatile-pool spot prices. The injected reader compares both
// configured providers at one finalized block. No quote/API-key dependency.
// [VERIFIED: deployed-tree/V3/src/pools/VolatilePool.sol POOL_TYPE and
// interfaces/pools/IPool.sol getReserves uint256 tuple; no stable() getter]
export async function readProtocolMarketMetrics(read:Reader,c:Config,backingAero:bigint|undefined,snapshot:{block:string;timestamp:number;independentProviders:number}):Promise<ProtocolMarketMetrics>{
  const errors:string[]=[];
  const safe=async<T>(label:string,run:()=>Promise<T>):Promise<T|null>=>{try{return await run();}catch{errors.push(label+' could not be verified at this finalized block.');return null;}};
  const decimals=(address:string,label:string)=>safe(label+' decimals',async()=>{const d=Number(await read(address,'function decimals() view returns(uint8)'));if(!Number.isInteger(d)||d<0||d>36)throw Error('Invalid decimals');return d;});
  const pool=(address:string,asset:string,quote:string,label:string)=>safe<Pool>(label,async()=>{
    const [t0,t1,reserves,poolType]=await Promise.all([
      read(address,'function token0() view returns(address)'),read(address,'function token1() view returns(address)'),
      read(address,'function getReserves() view returns(uint256,uint256,uint256)'),read(address,'function POOL_TYPE() view returns(bytes32)')
    ]);
    if(String(poolType).toLowerCase()!==stringToHex('V2_VOLATILE',{size:32}).toLowerCase()||!Array.isArray(reserves)||reserves.length!==3)throw Error('Not a volatile reserve pair');
    const a=asset.toLowerCase(),q=quote.toLowerCase(),zero=String(t0).toLowerCase(),one=String(t1).toLowerCase();
    if(zero===a&&one===q)return {asset:BigInt(reserves[0]),quote:BigInt(reserves[1])};
    if(one===a&&zero===q)return {asset:BigInt(reserves[1]),quote:BigInt(reserves[0])};
    throw Error('Unexpected token pair');
  });
  const clPegRead=c.sweep.aeroIaeroClPool?safe('iAERO/AERO CL pool',async()=>{
    const [t0,t1,slot,liquidity]=await Promise.all([read(c.sweep.aeroIaeroClPool!,'function token0() view returns(address)'),read(c.sweep.aeroIaeroClPool!,'function token1() view returns(address)'),read(c.sweep.aeroIaeroClPool!,'function slot0() view returns(uint160,int24,uint16,uint16,uint16,bool)'),read(c.sweep.aeroIaeroClPool!,'function liquidity() view returns(uint128)')]);
    if([String(t0),String(t1)].map(a=>a.toLowerCase()).sort().join()!==[c.aero.token,c.legacy.iAERO].map(a=>a.toLowerCase()).sort().join()||!Array.isArray(slot)||slot[5]!==true||BigInt(liquidity)<=0n)throw Error('Invalid CL price state');return {sqrt:BigInt(slot[0]),assetIsToken0:String(t0).toLowerCase()===c.legacy.iAERO.toLowerCase()};
  }):null;
  const [ad,ud,id,ld,ap,ip,lp,supply,clPeg,iaeroSupply]=await Promise.all([
    decimals(c.aero.token,'AERO'),decimals(c.legacy.USDC,'USDC'),decimals(c.legacy.iAERO,'iAERO'),decimals(c.legacy.LIQ,'LIQ'),
    pool(c.sweep.aeroUsdcPool,c.aero.token,c.legacy.USDC,'AERO/USDC pool'),
    c.sweep.aeroIaeroClPool?Promise.resolve(null):pool(c.sweep.aeroIaeroPool,c.legacy.iAERO,c.aero.token,'iAERO/AERO pool'),
    pool(c.marketData.liqUsdcPool,c.legacy.LIQ,c.legacy.USDC,'LIQ/USDC pool'),
    safe('LIQ supply',async()=>{const s=BigInt(await read(c.legacy.LIQ,'function totalSupply() view returns(uint256)'));if(s<0n||s>=2n**256n)throw Error('Invalid supply');return s;}),clPegRead,
    safe('iAERO supply',async()=>BigInt(await read(c.legacy.iAERO,'function totalSupply() view returns(uint256)')))
  ]);
  const rate=(p:Pool|null,a:number|null,q:number|null)=>p&&a!==null&&q!==null?reservePrice(p.asset,p.quote,a,q):null;
  const aero=rate(ap,ad,ud),peg=c.sweep.aeroIaeroClPool?(clPeg&&id!==null&&ad!==null?clSpotPrice(clPeg.sqrt,clPeg.assetIsToken0,id,ad):null):rate(ip,id,ad),liq=rate(lp,ld,ud);
  const tvl=aero!==null&&ad!==null&&backingAero!==undefined&&backingAero>=0n?backingAero*aero/10n**BigInt(ad):null;
  const circulation=supply!==null?await safe('LIQ circulating supply',()=>readLiqCirculation(read,c,supply,snapshot.timestamp)):null;
  const cap=liq!==null&&ld!==null&&circulation!==null?circulation.circulating*liq/10n**BigInt(ld):null;
  return {iaeroPriceUsdcWad:aero!==null&&peg!==null?(aero*peg/E18).toString():null,iaeroTotalSupply:iaeroSupply?.toString()??null,iaeroDecimals:id,backingPerIaeroWad:iaeroSupply!==null&&iaeroSupply>0n&&ad!==null&&id!==null&&backingAero!==undefined?(backingAero*10n**BigInt(id)*E18/(iaeroSupply*10n**BigInt(ad))).toString():null,aeroPriceUsdcWad:aero?.toString()??null,iaeroPegWad:peg?.toString()??null,tvlUsdcWad:tvl?.toString()??null,liqPriceUsdcWad:liq?.toString()??null,liqMarketCapUsdcWad:cap?.toString()??null,liqTotalSupply:supply?.toString()??null,liqCirculatingSupply:circulation?.circulating.toString()??null,liqUnvested:circulation?.unvested.toString()??null,liqTreasuryBalance:circulation?.treasuryBalance.toString()??null,liqTreasuryAddress:circulation?.treasury??null,liqVestingAddress:circulation?.vesting??null,liqDecimals:ld,asOfBlock:snapshot.block,blockTimestamp:snapshot.timestamp,readAtMs:Date.now(),readProviders:snapshot.independentProviders,errors};
}
