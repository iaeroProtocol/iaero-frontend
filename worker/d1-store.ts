import {blankLedger,validateLedger,receiptFields,type YieldLedger} from '../src/protocol-data/yield-model.ts';
import policy from '../config/protocol-yield.json' with {type:'json'};
// Small structural interfaces also allow the real D1 adapter to run in Miniflare.
export type Statement={bind:(...values:any[])=>Statement;all:<T=any>()=>Promise<{results:T[]}>;first:<T=any>(column?:string)=>Promise<T|null>;run:()=>Promise<{meta:{changes:number}}>};
export type YieldDB={prepare:(sql:string)=>Statement;batch:(statements:Statement[])=>Promise<{results:any[]}[]>;exec:(sql:string)=>Promise<unknown>};
export class D1YieldStore{
 private boundary:number|undefined;
 private chainIds:number[]=[];
 prepare(boundary:number,chainIds:number[]=[]){this.boundary=boundary;this.chainIds=chainIds;}
 readonly db:YieldDB;readonly position:string;readonly owner:string;readonly now:()=>number;
 constructor(db:YieldDB,position:string,owner:string,now:()=>number=Date.now){this.db=db;this.position=position;this.owner=owner;this.now=now;}
 async acquire(){const at=this.now(),out=await this.db.prepare('INSERT INTO yield_leases VALUES(?,?,?) ON CONFLICT(position) DO UPDATE SET owner=excluded.owner,expiresAt=excluded.expiresAt WHERE yield_leases.expiresAt<=?').bind(this.position,this.owner,at+12*60000,at).run();return out.meta.changes===1;}
 async release(){await this.db.prepare('DELETE FROM yield_leases WHERE position=? AND owner=?').bind(this.position,this.owner).run();}
 private async read(){
  // Calculations need the rolling window, not a rewrite of every historic row.
  // Intermediate snapshots are read as capital-only calculation projections.
  // The exact boundary and newest assets are loaded in full. Stored facts and
  // public paginated exports always retain every original asset.
  const cutoff=Math.floor(this.now()/1000)-8*86400;
  const rows=await this.db.batch([
   this.db.prepare('SELECT revision,cursors FROM yield_meta WHERE position=?').bind(this.position),
   this.db.prepare('SELECT data FROM yield_claims WHERE position=? AND timestamp>=? ORDER BY rowid').bind(this.position,cutoff),
   this.db.prepare(`SELECT CASE WHEN timestamp=(SELECT max(timestamp) FROM yield_snapshots WHERE position=?) OR (json_extract(data,'$.recordedAt')>=? AND (EXISTS(SELECT 1 FROM json_each(json_extract(data,'$.assets')) p WHERE json_type(p.value,'$.price')='object') OR EXISTS(SELECT 1 FROM json_each(json_extract(data,'$.prices')) p WHERE json_type(p.value,'$.price')='object'))) OR id IN (?,?) OR id LIKE ? OR id LIKE ? OR id=(SELECT id FROM yield_snapshots WHERE position=? AND timestamp>=? AND CAST(json_extract(data,'$.tvlUsdcWad') AS REAL)>0 AND (json_extract(data,'$.observedComplete')=1 OR json_extract(data,'$.pendingComplete')=1) AND NOT EXISTS (SELECT 1 FROM json_each(?) required WHERE NOT EXISTS (SELECT 1 FROM json_each(json_extract(yield_snapshots.data,'$.chains')) observed WHERE observed.value=required.value)) ORDER BY timestamp,rowid DESC LIMIT 1) THEN data ELSE json_object('id',id,'timestamp',timestamp,'recordedAt',json_extract(data,'$.recordedAt'),'backingAero',json_extract(data,'$.backingAero'),'tvlUsdcWad',json_extract(data,'$.tvlUsdcWad'),'assets',json('[]'),'pendingComplete',json(CASE WHEN json_extract(data,'$.pendingComplete') THEN 'true' ELSE 'false' END),'chains',json_extract(data,'$.chains'),'errors',json_extract(data,'$.errors')) END data FROM yield_snapshots WHERE position=? AND timestamp>=? ORDER BY rowid`).bind(this.position,this.now()-policy.pricing.maxAgeSeconds*1000,'boundary:'+this.boundary,'observed-boundary:'+this.boundary,'boundary:'+this.boundary+':retry:%','observed-boundary:'+this.boundary+':retry:%',this.position,cutoff,JSON.stringify(this.chainIds),this.position,cutoff),
   this.db.prepare('SELECT v.data FROM yield_valuations v JOIN yield_claims c ON v.position=c.position AND v.claimId=c.id WHERE v.position=? AND c.timestamp>=? ORDER BY v.rowid').bind(this.position,cutoff),
   this.db.prepare('SELECT a.data FROM yield_assessments a JOIN yield_claims c ON a.position=c.position AND a.claimId=c.id WHERE a.position=? AND c.timestamp>=? ORDER BY a.rowid').bind(this.position,cutoff)
  ]),meta=rows[0].results[0],state=blankLedger(this.position);
  if(meta)state.cursors=JSON.parse(meta.cursors);state.claims=rows[1].results.map(r=>JSON.parse(r.data));state.snapshots=rows[2].results.map(r=>JSON.parse(r.data));state.valuations=rows[3].results.map(r=>JSON.parse(r.data));state.assessments=rows[4].results.map(r=>JSON.parse(r.data));validateLedger(state,this.position);return {state,revision:Number(meta?.revision??0)};
 }
 async load(){return (await this.read()).state;}
 async update<T>(change:(state:YieldLedger)=>Promise<T>){
  const before=await this.read(),state=structuredClone(before.state),out=await change(state);
  for(const key of ['claims','snapshots','valuations','assessments'] as const){const current=new Map((state[key]??[]).map(v=>[v.id,v]));for(const old of before.state[key]??[])if(JSON.stringify(current.get(old.id))!==JSON.stringify(old))throw Error('yield_'+key+'_history_changed');}
  for(const [id,c] of Object.entries(before.state.cursors))if(!state.cursors[id]||BigInt(state.cursors[id].block)<BigInt(c.block))throw Error('yield_cursor_rewound');
  validateLedger(state,this.position);
  const queries=[this.db.prepare('INSERT INTO yield_commit_guard VALUES(?,CASE WHEN COALESCE((SELECT revision FROM yield_meta WHERE position=?),0)=? AND EXISTS(SELECT 1 FROM yield_leases WHERE position=? AND owner=? AND expiresAt>?) THEN 1 ELSE 0 END)').bind(this.position,this.position,before.revision,this.position,this.owner,this.now())];
  const oldClaims=new Set(before.state.claims.map(c=>c.id)),oldSnaps=new Set(before.state.snapshots.map(s=>s.id)),oldValues=new Set((before.state.valuations??[]).map(v=>v.id));
  const sameReceipt=receiptFields.map(k=>`lower(CAST(json_extract(yield_claims.data,'$.${k}') AS TEXT)) IS lower(CAST(json_extract(excluded.data,'$.${k}') AS TEXT))`).join(' AND ');
  for(const c of state.claims)if(!oldClaims.has(c.id))queries.push(this.db.prepare(`INSERT INTO yield_claims VALUES(?,?,?,?) ON CONFLICT(position,id) DO UPDATE SET data=CASE WHEN ${sameReceipt} THEN yield_claims.data ELSE excluded.data END`).bind(this.position,c.id,c.timestamp,JSON.stringify(c)));
  for(const s of state.snapshots)if(!oldSnaps.has(s.id))queries.push(this.db.prepare('INSERT INTO yield_snapshots VALUES(?,?,?,?) ON CONFLICT(position,id) DO UPDATE SET data=excluded.data').bind(this.position,s.id,s.timestamp,JSON.stringify(s)));
  for(const v of state.valuations??[])if(!oldValues.has(v.id))queries.push(this.db.prepare('INSERT INTO yield_valuations VALUES(?,?,?,?) ON CONFLICT(position,id) DO UPDATE SET data=excluded.data').bind(this.position,v.id,v.claimId,JSON.stringify(v)));
  const oldAssessments=new Set((before.state.assessments??[]).map(a=>a.id));for(const a of state.assessments??[])if(!oldAssessments.has(a.id))queries.push(this.db.prepare('INSERT INTO yield_assessments VALUES(?,?,?,?) ON CONFLICT(position,id) DO NOTHING').bind(this.position,a.id,a.claimId,JSON.stringify(a)));
  queries.push(this.db.prepare('INSERT INTO yield_meta VALUES(?,?,?) ON CONFLICT(position) DO UPDATE SET revision=excluded.revision,cursors=excluded.cursors').bind(this.position,before.revision+1,JSON.stringify(state.cursors)),this.db.prepare('DELETE FROM yield_commit_guard WHERE position=?').bind(this.position));
  await this.db.batch(queries);return out;
 }
 async saveReport(report:any){
  const [claims,snaps]=await this.db.batch([this.db.prepare('SELECT count(*) n FROM yield_claims WHERE position=?').bind(this.position),this.db.prepare('SELECT count(*) n FROM yield_snapshots WHERE position=?').bind(this.position)]);
  const value={...report,storedClaims:Number(claims.results[0].n),storedObservations:Number(snaps.results[0].n),storage:'Shared protocol history · scheduled collector · Cloudflare D1',status:'OBSERVED; NOT_RELEASE_ACCEPTANCE'};
  await this.db.prepare('INSERT INTO yield_reports VALUES(?,?,?) ON CONFLICT(position) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt WHERE excluded.updatedAt>=yield_reports.updatedAt').bind(this.position,JSON.stringify(value),report.readAtMs).run();
 }
}
