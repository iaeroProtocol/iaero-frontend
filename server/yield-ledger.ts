import {mkdir,stat,chmod} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {dirname} from 'node:path';
export * from '../src/protocol-data/yield-model.ts';
import {blankLedger,validateLedger,type YieldLedger} from '../src/protocol-data/yield-model.ts';
function openStore(path:string){
  const db=new DatabaseSync(path);db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS ledger (position TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS yield_meta (position TEXT PRIMARY KEY, revision INTEGER NOT NULL, cursors TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS yield_claims (position TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(position,id)) STRICT;
    CREATE TABLE IF NOT EXISTS yield_snapshots (position TEXT NOT NULL,id TEXT NOT NULL,timestamp INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(position,id)) STRICT;
    CREATE TABLE IF NOT EXISTS yield_valuations (position TEXT NOT NULL,id TEXT NOT NULL,claimId TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(position,id),UNIQUE(position,claimId)) STRICT;
    CREATE TABLE IF NOT EXISTS yield_assessments (position TEXT NOT NULL,id TEXT NOT NULL,claimId TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(position,id)) STRICT;
    CREATE INDEX IF NOT EXISTS yield_snapshot_time ON yield_snapshots(position,timestamp);`);return db;
}
function readStore(db:DatabaseSync,position:string):{state:YieldLedger;revision:number}{
  let meta=db.prepare('SELECT revision,cursors FROM yield_meta WHERE position=?').get(position) as {revision:number;cursors:string}|undefined;
  if(!meta){
    // Preserve and migrate the original local format once; the legacy row stays intact.
    const legacy=db.prepare('SELECT revision,data FROM ledger WHERE position=?').get(position) as {revision:number;data:string}|undefined;
    if(!legacy)return {state:blankLedger(position),revision:0};
    let old:unknown;try{old=JSON.parse(legacy.data);}catch{throw Error('yield_store_corrupt');}validateLedger(old,position);
    db.exec('BEGIN IMMEDIATE');try{
      if(!db.prepare('SELECT position FROM yield_meta WHERE position=?').get(position)){
        for(const c of old.claims)db.prepare('INSERT INTO yield_claims VALUES(?,?,?)').run(position,c.id,JSON.stringify(c));
        for(const x of old.snapshots)db.prepare('INSERT INTO yield_snapshots VALUES(?,?,?,?)').run(position,x.id,x.timestamp,JSON.stringify(x));
        for(const v of old.valuations??[])db.prepare('INSERT INTO yield_valuations VALUES(?,?,?,?)').run(position,v.id,v.claimId,JSON.stringify(v));
        for(const a of old.assessments??[])db.prepare('INSERT INTO yield_assessments VALUES(?,?,?,?)').run(position,a.id,a.claimId,JSON.stringify(a));
      db.prepare('INSERT INTO yield_meta VALUES(?,?,?)').run(position,legacy.revision,JSON.stringify(old.cursors));
      }db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    meta=db.prepare('SELECT revision,cursors FROM yield_meta WHERE position=?').get(position) as {revision:number;cursors:string};
  }
  let state:YieldLedger;
  try{state={version:1,position,cursors:JSON.parse(meta.cursors),assessments:db.prepare('SELECT data FROM yield_assessments WHERE position=? ORDER BY rowid').all(position).map(r=>JSON.parse(String(r.data))),valuations:db.prepare('SELECT data FROM yield_valuations WHERE position=? ORDER BY rowid').all(position).map(r=>JSON.parse(String(r.data))),claims:db.prepare('SELECT data FROM yield_claims WHERE position=? ORDER BY rowid').all(position).map(r=>JSON.parse(String(r.data))),snapshots:db.prepare('SELECT data FROM yield_snapshots WHERE position=? ORDER BY rowid').all(position).map(r=>JSON.parse(String(r.data)))};}
  catch{throw Error('yield_store_corrupt');}validateLedger(state,position);return {state,revision:meta.revision};
}
export async function loadLedger(path:string,position:string):Promise<YieldLedger>{
  try{await stat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return blankLedger(position);throw Error('yield_store_read_failed');}
  const db=openStore(path);try{return readStore(db,position).state;}finally{db.close();}
}
export async function updateLedger<T>(path:string,position:string,change:(state:YieldLedger)=>Promise<T>):Promise<T>{
  await mkdir(dirname(path),{recursive:true,mode:0o700});const db=openStore(path);await chmod(path,0o600);
  try{const before=readStore(db,position),state=structuredClone(before.state),out=await change(state);
    const newClaims=new Map(state.claims.map(c=>[c.id,c])),newSnapshots=new Map(state.snapshots.map(x=>[x.id,x]));
    for(const c of before.state.claims)if(JSON.stringify(newClaims.get(c.id))!==JSON.stringify(c))throw Error('yield_claim_history_changed');
    for(const x of before.state.snapshots)if(JSON.stringify(newSnapshots.get(x.id))!==JSON.stringify(x))throw Error('yield_snapshot_history_changed');
    const newValuations=new Map((state.valuations??[]).map(v=>[v.id,v]));for(const v of before.state.valuations??[])if(JSON.stringify(newValuations.get(v.id))!==JSON.stringify(v))throw Error('yield_valuation_history_changed');
    const newAssessments=new Map((state.assessments??[]).map(a=>[a.id,a]));for(const a of before.state.assessments??[])if(JSON.stringify(newAssessments.get(a.id))!==JSON.stringify(a))throw Error('yield_assessment_history_changed');
    for(const [id,c] of Object.entries(before.state.cursors))if(!state.cursors[id]||BigInt(state.cursors[id].block)<BigInt(c.block))throw Error('yield_cursor_rewound');
    validateLedger(state,position);
    db.exec('BEGIN IMMEDIATE');try{if(readStore(db,position).revision!==before.revision)throw Error('yield_store_concurrent_update');
      const claimIds=new Set(before.state.claims.map(c=>c.id)),snapshotIds=new Set(before.state.snapshots.map(x=>x.id));
      for(const c of state.claims)if(!claimIds.has(c.id))db.prepare('INSERT INTO yield_claims VALUES(?,?,?)').run(position,c.id,JSON.stringify(c));
      for(const x of state.snapshots)if(!snapshotIds.has(x.id))db.prepare('INSERT INTO yield_snapshots VALUES(?,?,?,?)').run(position,x.id,x.timestamp,JSON.stringify(x));
      for(const v of state.valuations??[])if(!(before.state.valuations??[]).some(old=>old.id===v.id))db.prepare('INSERT INTO yield_valuations VALUES(?,?,?,?)').run(position,v.id,v.claimId,JSON.stringify(v));
      for(const a of state.assessments??[])if(!(before.state.assessments??[]).some(old=>old.id===a.id))db.prepare('INSERT INTO yield_assessments VALUES(?,?,?,?)').run(position,a.id,a.claimId,JSON.stringify(a));
      db.prepare('INSERT INTO yield_meta VALUES(?,?,?) ON CONFLICT(position) DO UPDATE SET revision=excluded.revision,cursors=excluded.cursors').run(position,before.revision+1,JSON.stringify(state.cursors));db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}return out;
  }finally{db.close();}
}
