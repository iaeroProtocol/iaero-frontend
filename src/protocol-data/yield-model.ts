import yieldPolicy from '../../config/protocol-yield.json' with {type:'json'};
import type {PriceProof} from '../../server/yield-prices.ts';
import {validYieldPrice,yieldPriceObservedAt,type YieldPrice} from './yield-price.ts';
export const WEEK=604800;
export type YieldClaim={id:string;chainId:number;block:string;blockHash:string;timestamp:number;transactionHash:string;logIndex:number;manager:string;recipient:string;token:string;amount:string;decimals:number|null;symbol:string;kind:'fees'|'incentive';programId:string|null;recipientRecognised?:boolean;valueUsdcWad:string|null;valuation:'exact-usdc'|'unpriced';providers:number};
export type YieldAssessment={id:string;claimId:string;decimals:number|null;symbol:string;recipientRecognised:boolean;providers:number;valueUsdcWad:string|null;recordedAt:number};
export type YieldValuation={id:string;claimId:string;valueUsdcWad:string;recordedAt:number;proof:PriceProof};
export type YieldAsset={chainId:number;token:string;amount:string;decimals:number|null;symbol:string;valueUsdcWad:string|null;price?:YieldPrice};
export type ChainCursor={block:string;hash:string;timestamp:number;fromBlock:string;providers:number;complete:boolean;auditBlock?:string;gauges:string[]};
export type YieldSnapshot={id:string;timestamp:number;recordedAt:number;backingAero:string;tvlUsdcWad:string|null;assets:YieldAsset[];prices?:YieldAsset[];pendingComplete:boolean;observedComplete?:boolean;observationProviders?:Record<string,number>;chains:number[];errors:string[]};
export type AnnualisedYield={windowStart:number|null;windowEnd:number;windowSeconds:number|null;provisional:boolean;qualification:'verified'|'provisional'|'unavailable';unverifiedChainIds:number[];earnedApy:number|null;receivedApy:number|null;earnedIncomeUsdcWad:string|null;receivedIncomeUsdcWad:string|null;capitalUsdcWad:string|null;earnedUnavailableReason:string|null;receivedUnavailableReason:string|null;earnedPriceObservedAt?:number|null};
export type YieldLedger={version:1;position:string;claims:YieldClaim[];snapshots:YieldSnapshot[];valuations?:YieldValuation[];assessments?:YieldAssessment[];cursors:Record<string,ChainCursor>};
export const blankLedger=(position:string):YieldLedger=>({version:1,position,claims:[],snapshots:[],valuations:[],assessments:[],cursors:{}});
const uint=(s:unknown)=>typeof s==='string'&&/^\d+$/.test(s)&&BigInt(s)<2n**256n;
export function validateLedger(value:unknown,position:string):asserts value is YieldLedger{
  const s=value as YieldLedger;if(!s||s.version!==1||s.position!==position||!Array.isArray(s.claims)||!Array.isArray(s.snapshots)||!s.cursors||typeof s.cursors!=='object')throw Error('yield_store_invalid');
  const address=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{40}$/i.test(v),decimals=(v:unknown)=>v===null||Number.isInteger(v)&&Number(v)>=0&&Number(v)<=36;
  const ids=new Set<string>();for(const c of s.claims){if(!c||typeof c.id!=='string'||!c.id||c.id.length>4096||!Number.isSafeInteger(c.chainId)||c.chainId<=0||!Number.isSafeInteger(c.logIndex)||c.logIndex<0||!address(c.manager)||!address(c.recipient)||!decimals(c.decimals)||typeof c.symbol!=='string'||c.symbol.length>64||/[\x00-\x1f]/.test(c.symbol)||!['exact-usdc','unpriced'].includes(c.valuation)||!Number.isInteger(c.providers)||c.providers<1||c.providers>2||c.programId!==null&&!uint(c.programId)||ids.has(c.id)||!uint(c.amount)||!uint(c.block)||!Number.isSafeInteger(c.timestamp)||c.timestamp<0||c.valueUsdcWad!==null&&!uint(c.valueUsdcWad)||!/^0x[0-9a-f]{64}$/i.test(c.transactionHash)||!/^0x[0-9a-f]{64}$/i.test(c.blockHash)||!/^0x[0-9a-f]{40}$/i.test(c.token))throw Error('yield_claim_invalid');ids.add(c.id);}
  const snaps=new Set<string>();for(const x of s.snapshots){if(!x||snaps.has(x.id)||!uint(x.backingAero)||x.tvlUsdcWad!==null&&!uint(x.tvlUsdcWad)||!Number.isSafeInteger(x.timestamp)||!Array.isArray(x.assets)||x.prices!==undefined&&!Array.isArray(x.prices))throw Error('yield_snapshot_invalid');snaps.add(x.id);for(const a of [...x.assets,...(x.prices??[])])if(!address(a.token)||!decimals(a.decimals)||!Number.isSafeInteger(a.chainId)||a.chainId<=0||!uint(a.amount)||a.valueUsdcWad!==null&&!uint(a.valueUsdcWad))throw Error('yield_asset_invalid');}
  for(const x of s.snapshots){
    if([...x.assets,...(x.prices??[])].some(a=>a.price!==undefined&&(!validYieldPrice(a.price)||a.valueUsdcWad===null||a.price.observedAt>x.recordedAt/1000+60)))throw Error('yield_price_provenance_invalid');
    if(typeof x.pendingComplete!=='boolean'||x.observedComplete!==undefined&&typeof x.observedComplete!=='boolean'||x.pendingComplete&&x.observedComplete===false)throw Error('yield_snapshot_provenance_invalid');
    if(x.observationProviders!==undefined){
      if(!x.observationProviders||typeof x.observationProviders!=='object'||Array.isArray(x.observationProviders)||Object.entries(x.observationProviders).some(([id,n])=>!/^\d+$/.test(id)||!x.chains.includes(Number(id))||!Number.isSafeInteger(n)||n<1||n>2)||x.observedComplete&&x.chains.some(id=>!(x.observationProviders![id]>=1))||x.pendingComplete&&x.chains.some(id=>x.observationProviders![id]!==2))throw Error('yield_snapshot_provenance_invalid');
    }else if(x.observedComplete&&!x.pendingComplete)throw Error('yield_snapshot_provenance_invalid');
  }
  for(const c of Object.values(s.cursors))if(!c||!uint(c.block)||!uint(c.fromBlock)||!/^0x[0-9a-f]{64}$/i.test(c.hash)||!Number.isSafeInteger(c.timestamp)||!Array.isArray(c.gauges))throw Error('yield_cursor_invalid');
  const assessmentIds=new Set<string>();if(s.assessments!==undefined&&!Array.isArray(s.assessments))throw Error('yield_assessment_invalid');
  for(const a of s.assessments??[]){const c=s.claims.find(c=>c.id===a.claimId);if(!c||assessmentIds.has(a.id))throw Error('yield_assessment_invalid');validateAssessment(c,a);assessmentIds.add(a.id);}
  for(const c of s.claims)effectiveClaim(s,c);
  if(s.valuations!==undefined&&!Array.isArray(s.valuations))throw Error('yield_valuation_invalid');
  const valued=new Set<string>(),valuationIds=new Set<string>();for(const v of s.valuations??[]){const c=s.claims.find(c=>c.id===v.claimId);if(!c||valued.has(v.claimId)||valuationIds.has(v.id))throw Error('yield_valuation_invalid');validateValuation(effectiveClaim(s,c),v);valued.add(v.claimId);valuationIds.add(v.id);}
}
// Raw receipt facts stay immutable; replayed metadata and provider attestations are append-only.
export const receiptFields=['id','chainId','block','blockHash','timestamp','transactionHash','logIndex','manager','recipient','token','amount','kind','programId'] as const;
const receiptFacts=(c:YieldClaim)=>JSON.stringify(receiptFields.map(k=>typeof c[k]==='string'&&String(c[k]).startsWith('0x')?String(c[k]).toLowerCase():c[k]));
const assessmentId=(a:Omit<YieldAssessment,'id'|'recordedAt'>)=>'assessment:'+JSON.stringify([a.claimId,a.decimals,a.symbol,a.recipientRecognised,a.providers,a.valueUsdcWad]);
function validateAssessment(c:YieldClaim,a:YieldAssessment){
 const canonical=Object.fromEntries(yieldPolicy.chains.filter(c=>c.usdc).map(c=>[c.chainId,c.usdc!.toLowerCase()]));
 if(a.id!==assessmentId(a)||a.decimals!==null&&(!Number.isInteger(a.decimals)||a.decimals<0||a.decimals>36)||typeof a.symbol!=='string'||a.symbol.length>64||/[\x00-\x1f]/.test(a.symbol)||typeof a.recipientRecognised!=='boolean'||!Number.isSafeInteger(a.providers)||a.providers<1||a.providers>2||!Number.isSafeInteger(a.recordedAt)||a.recordedAt<c.timestamp*1000||a.valueUsdcWad!==null&&(!uint(a.valueUsdcWad)||a.valueUsdcWad!==c.valueUsdcWad&&(!a.recipientRecognised||a.decimals!==6||canonical[c.chainId]!==c.token.toLowerCase()||a.valueUsdcWad!==(BigInt(c.amount)*10n**12n).toString())))throw Error('yield_assessment_invalid');
}
export function addAssessment(state:YieldLedger,a:YieldAssessment){const c=state.claims.find(c=>c.id===a.claimId);if(!c)throw Error('yield_assessment_invalid');validateAssessment(c,a);state.assessments??=[];if(!state.assessments.some(old=>old.id===a.id))state.assessments.push(a);}
export function addClaim(state:YieldLedger,claim:YieldClaim){
 const old=state.claims.find(c=>c.id===claim.id);if(old&&receiptFacts(old)!==receiptFacts(claim))throw Error('yield_claim_conflict');if(!old)state.claims.push(claim);
 const assessment={claimId:claim.id,decimals:claim.decimals,symbol:claim.symbol,recipientRecognised:claim.recipientRecognised!==false,providers:claim.providers,valueUsdcWad:claim.valueUsdcWad};
 addAssessment(state,{...assessment,id:assessmentId(assessment),recordedAt:Math.max(Date.now(),claim.timestamp*1000)});
}
export function effectiveClaim(state:YieldLedger,c:YieldClaim):YieldClaim{
 const rows=(state.assessments??[]).filter(a=>a.claimId===c.id).sort((a,b)=>a.providers-b.providers),out={...c};
 for(const a of rows){if(a.decimals!==null){if(out.decimals!==null&&out.decimals!==a.decimals)throw Error('yield_metadata_disagreement');out.decimals=a.decimals;out.symbol=a.symbol;}if(a.recipientRecognised)out.recipientRecognised=true;out.providers=Math.max(out.providers,a.providers);if(a.valueUsdcWad!==null){out.valueUsdcWad=a.valueUsdcWad;out.valuation='exact-usdc';}}
 return out;
}
export function claimValue(state:YieldLedger,claim:YieldClaim):string|null{return effectiveClaim(state,claim).valueUsdcWad??state.valuations?.find(v=>v.claimId===claim.id)?.valueUsdcWad??null;}
function validateValuation(claim:YieldClaim,value:YieldValuation){
 const p=value.proof;
 if(claim.recipientRecognised===false||claim.valueUsdcWad!==null||claim.decimals===null||typeof value.id!=='string'||!value.id||!uint(value.valueUsdcWad)||!Number.isSafeInteger(value.recordedAt)||value.recordedAt<claim.timestamp*1000||!p||p.kind!=='historical-estimate'||![p.timestamp,p.usdcTimestamp].every(t=>Number.isSafeInteger(t)&&Math.abs(t-claim.timestamp)<=1800)||![p.priceUsdWad,p.usdcPriceUsdWad].every(n=>uint(n)&&BigInt(n)>0n)||![p.source,p.usdcSource].every(id=>typeof id==='string'&&id.length<200&&!/[\x00-\x20]/.test(id))||p.confidence!==null&&(!Number.isFinite(p.confidence)||p.confidence<0.9||p.confidence>1))throw Error('yield_valuation_invalid');
 const expected=BigInt(claim.amount)*BigInt(p.priceUsdWad)*10n**18n/(10n**BigInt(claim.decimals)*BigInt(p.usdcPriceUsdWad));if(expected.toString()!==value.valueUsdcWad)throw Error('yield_valuation_invalid');
}
export function addValuation(state:YieldLedger,value:YieldValuation){
 const claim=state.claims.find(c=>c.id===value.claimId);if(!claim)throw Error('yield_valuation_invalid');validateValuation(effectiveClaim(state,claim),value);
 state.valuations??=[];const old=state.valuations.find(v=>v.claimId===value.claimId);if(old){if(JSON.stringify(old)!==JSON.stringify(value))throw Error('yield_valuation_conflict');return;}state.valuations.push(value);
}
export function yieldChainTotals(state:YieldLedger,assets:YieldAsset[],chains:{chainId:number;name:string;providers:number;status:string;historyComplete?:boolean;errors?:string[]}[],now:number){
 return chains.map(chain=>{const scoped=assets.filter(a=>a.chainId===chain.chainId),received=state.claims.filter(c=>c.chainId===chain.chainId&&c.timestamp>now-WEEK&&c.timestamp<=now),priced=scoped.filter(a=>a.valueUsdcWad!==null),unavailable=['unavailable','pending'].includes(chain.status),incomplete=unavailable||!!chain.errors?.length||chain.historyComplete===false;return {chainId:chain.chainId,name:chain.name,pendingValueUsdcWad:scoped.length||!incomplete?priced.reduce((n,a)=>n+BigInt(a.valueUsdcWad!),0n).toString():null,unpricedTokens:scoped.filter(a=>a.valueUsdcWad===null).map(a=>({token:a.token,symbol:a.symbol})),pendingPartial:incomplete||priced.length!==scoped.length,receivedValueUsdcWad:chain.historyComplete?received.reduce((n,c)=>n+BigInt(claimValue(state,c)??'0'),0n).toString():null,receivedPartial:!chain.historyComplete||received.some(c=>claimValue(state,c)===null),providers:chain.providers,status:chain.status};});
}
export function receivedYieldDays(state:YieldLedger,now:number,createdAt:number,chainIds:number[],days=7){
 const span=([7,30,90].includes(days)?days:7)*86400,day=86400,start=Math.floor((now-span+1)/day)*day,complete=chainIds.every(id=>state.cursors[id]?.complete);
 return Array.from({length:Math.ceil(span/day)+1},(_,i)=>start+i*day).filter(t=>t<=now&&t+day>createdAt).map(timestamp=>{const rows=state.claims.filter(c=>c.timestamp>=Math.max(timestamp,createdAt,now-span+1)&&c.timestamp<timestamp+day&&c.timestamp<=now),unpriced=rows.some(c=>claimValue(state,c)===null);return {timestamp,from:Math.max(timestamp,createdAt,now-span+1),to:Math.min(now,timestamp+day),claims:rows.length,valueUsdcWad:complete?rows.reduce((n,c)=>n+BigInt(claimValue(state,c)??'0'),0n).toString():null,partial:!complete||unpriced};});
}
export function addSnapshot(state:YieldLedger,snapshot:YieldSnapshot){if(!state.snapshots.some(x=>x.id===snapshot.id))state.snapshots.push(snapshot);}
export function annualisedApy(income:bigint,capital:bigint,seconds:number):number|null{
  if(capital<=0n||income<0n||!Number.isSafeInteger(seconds)||seconds<=0||seconds>WEEK)return null;
  const ratio=Number(income)/Number(capital);
  const pct=Math.expm1(Math.log1p(ratio)*365*86400/seconds)*100;return Number.isFinite(pct)?pct:null;
}
export const annualisedWeeklyApy=(income:bigint,capital:bigint)=>annualisedApy(income,capital,WEEK);
const snapshotOrder=(a:YieldSnapshot,b:YieldSnapshot)=>a.timestamp-b.timestamp||(Number(a.pendingComplete)*2+Number(a.observedComplete??a.pendingComplete))-(Number(b.pendingComplete)*2+Number(b.observedComplete??b.pendingComplete));
function summariseWeeklyYield(state:YieldLedger,now:number,chainIds:number[],assetAliases:Record<string,string>={}){
  const cutoff=now-WEEK,ordered=state.snapshots.filter(s=>s.timestamp<=now).sort(snapshotOrder),latest=ordered.at(-1),baseline=ordered.filter(s=>s.timestamp===cutoff).at(-1);
  const complete=chainIds.every(id=>state.cursors[id]?.complete),verified=chainIds.every(id=>(state.cursors[id]?.providers??0)>=2);
  const coveredFrom=Math.max(...chainIds.map(id=>state.cursors[id]?state.snapshots[0]?.timestamp??now:now));
  const received=state.claims.filter(c=>c.timestamp>cutoff&&c.timestamp<=now),unpriced=received.filter(c=>claimValue(state,c)===null&&BigInt(c.amount)>0n);
  const receivedValue=received.reduce((n,c)=>n+BigInt(claimValue(state,c)??'0'),0n),pendingValue=(latest?.assets??[]).reduce((n,c)=>n+BigInt(c.valueUsdcWad??'0'),0n);
  const partialPending=!latest?.pendingComplete||latest.assets.some(a=>a.valueUsdcWad===null&&BigInt(a.amount)>0n);
  let reason:string|null=null;
  if(!complete)reason='Claim history is still being indexed.';
  else if(!baseline)reason='Building a complete seven-day observation window.';
  else if(!verified)reason='An independent second provider is still required for every allocated chain.';
  else if(!baseline.pendingComplete||received.some(c=>effectiveClaim(state,c).providers<2))reason='Independent verification of this observation window is still pending.';
  else if(received.some(c=>BigInt(c.amount)>0n&&effectiveClaim(state,c).recipientRecognised===false))reason='Some claim recipients have not been verified.';
  else if(state.snapshots.some(s=>s.timestamp>cutoff&&s.timestamp<=now&&s.backingAero!==baseline.backingAero))reason='Backing changed during this window; a flow-adjusted basis is required.';
  const basis=baseline?.tvlUsdcWad?BigInt(baseline.tvlUsdcWad):0n;
  if(!reason&&basis<=0n)reason='The seven-day capital basis is unavailable.';
  // Received APY uses receipt-time values, never today's prices for old claims.
  const receivedReason=reason??(unpriced.length?'Some received tokens have no verified claim-time USDC valuation.':null),receivedApy=receivedReason===null?annualisedWeeklyApy(receivedValue,basis):null;
  if(!reason&&(!baseline?.pendingComplete||!latest?.pendingComplete||partialPending))reason='Some pending rewards or values are unavailable.';
  // Earned return is a token-unit delta; this avoids counting token price rises as income.
  let earned:bigint|null=null,earnedPriceObservedAt:number|null=null;
  if(!reason&&latest&&baseline){const key=(a:{chainId:number;token:string})=>{const raw=a.chainId+':'+a.token.toLowerCase();return assetAliases[raw]??raw;},deltas=new Map<string,bigint>(),prices=new Map<string,{amount:bigint;value:bigint;observedAt:number|null}>();
    for(const a of latest.prices??latest.assets)if(a.valueUsdcWad!==null&&BigInt(a.amount)>0n)prices.set(key(a),{amount:BigInt(a.amount),value:BigInt(a.valueUsdcWad),observedAt:yieldPriceObservedAt(a,latest.recordedAt)});
    for(const a of latest.assets){deltas.set(key(a),(deltas.get(key(a))??0n)+BigInt(a.amount));if(a.valueUsdcWad!==null&&BigInt(a.amount)>0n)prices.set(key(a),{amount:BigInt(a.amount),value:BigInt(a.valueUsdcWad),observedAt:yieldPriceObservedAt(a,latest.recordedAt)});}
    for(const a of baseline.assets)deltas.set(key(a),(deltas.get(key(a))??0n)-BigInt(a.amount));
    for(const c of received)deltas.set(key(c),(deltas.get(key(c))??0n)+BigInt(c.amount));
    earned=0n;for(const [k,delta] of deltas){const price=prices.get(k);if(delta<0n||delta>0n&&!price){earned=null;reason=delta<0n?'Reward balances fell without matching receipts; earned yield needs reconciliation.':'A current USDC price for a received or fully claimed token is unavailable.';break;}if(price){earned+=delta*price.value/price.amount;if(delta>0n&&price.observedAt!==null)earnedPriceObservedAt=earnedPriceObservedAt===null?price.observedAt:Math.min(earnedPriceObservedAt,price.observedAt);}}
  }
  return {windowSeconds:WEEK,windowEnd:now,cutoff,historyComplete:complete,independentCoverageComplete:verified,coveredFrom,claimCount:state.claims.length,receivedCount7d:received.length,receivedValueUsdcWad:complete?receivedValue.toString():null,receivedPartial:unpriced.length>0,pendingValueUsdcWad:latest?pendingValue.toString():null,pendingPartial:partialPending,receivedApy7d:receivedApy,earnedApy7d:earned===null?null:annualisedWeeklyApy(earned,basis),earnedPriceObservedAt:earned===null?null:earnedPriceObservedAt,apyUnavailableReason:reason,receivedApyUnavailableReason:receivedReason,formula:'((1 + sevenDayReturn) ** (365 / 7) - 1) × 100'};
}

// This separate estimate never fills the strict seven-day fields with a shorter
// or single-provider return. Stored receipts and snapshots remain immutable.
function observedAnnualisedYield(state:YieldLedger,now:number,chainIds:number[],aliases:Record<string,string>,startedAt?:number):AnnualisedYield{
 const points=state.snapshots.filter(s=>s.timestamp<=now).sort(snapshotOrder),latest=points.at(-1);
 const firstComplete=points.find(s=>(s.observedComplete??s.pendingComplete)&&s.tvlUsdcWad!==null&&BigInt(s.tvlUsdcWad)>0n&&chainIds.every(id=>s.chains.includes(id)));
 const origin=firstComplete?Math.max(startedAt??firstComplete.timestamp,firstComplete.timestamp):startedAt;
 const start=origin!==undefined?Math.max(now-WEEK,origin):null,seconds=start!==null&&start<now?now-start:null;
 const baseline=points.filter(s=>s.timestamp===start).at(-1),received=start===null?[]:state.claims.filter(c=>c.timestamp>start&&c.timestamp<=now);
 const providers=(s:YieldSnapshot|undefined,id:number)=>s?.observationProviders?.[id]??(s?.pendingComplete&&s.chains.includes(id)?2:0);
 const unverified=chainIds.filter(id=>(state.cursors[id]?.providers??0)<2||providers(baseline,id)<2||providers(latest,id)<2||received.some(c=>c.chainId===id&&effectiveClaim(state,c).providers<2));
 let reason:string|null=null;
 if(!chainIds.length||chainIds.some(id=>!state.cursors[id]?.complete))reason='Claim history is still being indexed for every allocated chain.';
 else if(chainIds.some(id=>state.cursors[id].timestamp<now))reason='Claim history has not reached the shared finalized cutoff.';
 else if(seconds===null||!baseline||!latest||latest.timestamp!==now)reason='A complete starting and ending observation is required.';
 else if(chainIds.some(id=>!baseline.chains.includes(id)||!latest.chains.includes(id)))reason='An allocated chain is missing from this observation window.';
 else if(received.some(c=>BigInt(c.amount)>0n&&effectiveClaim(state,c).recipientRecognised===false))reason='Some claim recipients have not been verified.';
 else if(points.some(s=>s.timestamp>=start!&&s.timestamp<=now&&s.backingAero!==baseline.backingAero))reason='Backing changed during this window; a flow-adjusted basis is required.';
 const basis=baseline?.tvlUsdcWad?BigInt(baseline.tvlUsdcWad):0n;
 if(!reason&&basis<=0n)reason='The observation-window capital basis is unavailable.';
 const receivedValue=received.reduce((n,c)=>n+BigInt(claimValue(state,c)??'0'),0n);
 // Earned income reconciles token units at current prices. Historical receipt
 // valuations belong only to the independently calculated received return.
 const receivedReason=reason??(received.some(c=>BigInt(c.amount)>0n&&claimValue(state,c)===null)?'Some received tokens have no verified claim-time USDC valuation.':null),receivedApy=receivedReason===null?annualisedApy(receivedValue,basis,seconds!):null;
 if(!reason&&(!baseline||!(baseline.observedComplete??baseline.pendingComplete)||!latest||!(latest.observedComplete??latest.pendingComplete)||chainIds.some(id=>providers(baseline,id)<1||providers(latest,id)<1)||latest.assets.some(a=>BigInt(a.amount)>0n&&a.valueUsdcWad===null)))reason='Some pending rewards, chain observations or prices are unavailable.';
 let earned:bigint|null=null,earnedPriceObservedAt:number|null=null;
 if(!reason&&baseline&&latest){
  const key=(a:{chainId:number;token:string})=>{const raw=a.chainId+':'+a.token.toLowerCase();return aliases[raw]??raw;};
  const deltas=new Map<string,bigint>(),prices=new Map<string,{amount:bigint;value:bigint;observedAt:number|null}>();
  for(const a of latest.prices??latest.assets)if(a.valueUsdcWad!==null&&BigInt(a.amount)>0n)prices.set(key(a),{amount:BigInt(a.amount),value:BigInt(a.valueUsdcWad),observedAt:yieldPriceObservedAt(a,latest.recordedAt)});
  for(const a of latest.assets){deltas.set(key(a),(deltas.get(key(a))??0n)+BigInt(a.amount));if(a.valueUsdcWad!==null&&BigInt(a.amount)>0n)prices.set(key(a),{amount:BigInt(a.amount),value:BigInt(a.valueUsdcWad),observedAt:yieldPriceObservedAt(a,latest.recordedAt)});}
  for(const a of baseline.assets)deltas.set(key(a),(deltas.get(key(a))??0n)-BigInt(a.amount));
  for(const c of received)deltas.set(key(c),(deltas.get(key(c))??0n)+BigInt(c.amount));
  earned=0n;
  for(const [token,delta] of deltas){const price=prices.get(token);if(delta<0n||delta>0n&&!price){earned=null;reason=delta<0n?'Reward balances fell without matching receipts; earned yield needs reconciliation.':'A current USDC price for a received or fully claimed token is unavailable.';break;}if(price){earned+=delta*price.value/price.amount;if(delta>0n&&price.observedAt!==null)earnedPriceObservedAt=earnedPriceObservedAt===null?price.observedAt:Math.min(earnedPriceObservedAt,price.observedAt);}}
 }
 const earnedApy=earned===null?null:annualisedApy(earned,basis,seconds!);
 if(!reason&&earnedApy===null)reason='The observed return could not be annualised.';
 const provisional=seconds!==WEEK||unverified.length>0;
 return {windowStart:seconds===null?null:start,windowEnd:now,windowSeconds:seconds,provisional,qualification:earnedApy!==null||receivedApy!==null?provisional?'provisional':'verified':'unavailable',unverifiedChainIds:unverified,earnedApy,receivedApy,earnedPriceObservedAt:earnedApy===null?null:earnedPriceObservedAt,earnedIncomeUsdcWad:earned?.toString()??null,receivedIncomeUsdcWad:receivedReason===null?receivedValue.toString():null,capitalUsdcWad:basis>0n?basis.toString():null,earnedUnavailableReason:reason,receivedUnavailableReason:receivedReason??(receivedApy===null?'The observed return could not be annualised.':null)};
}
export function summariseYield(state:YieldLedger,now:number,chainIds:number[],assetAliases:Record<string,string>={},options:{startedAt?:number}={}){
 return {...summariseWeeklyYield(state,now,chainIds,assetAliases),annualised:observedAnnualisedYield(state,now,chainIds,assetAliases,options.startedAt),calculationVersion:'earned-token-growth-v2'};
}
export function invalidateAnnualised(summary:AnnualisedYield,reason:string){
 summary.earnedApy=null;summary.receivedApy=null;summary.earnedPriceObservedAt=null;summary.earnedIncomeUsdcWad=null;summary.receivedIncomeUsdcWad=null;summary.qualification='unavailable';summary.earnedUnavailableReason=reason;summary.receivedUnavailableReason=reason;
}
