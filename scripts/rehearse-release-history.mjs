import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Miniflare} from 'miniflare';
const root='artifacts/portfolio-release/history',bytes=await readFile(root+'/PRODUCTION_HISTORY_SEED.json','utf8'),state=JSON.parse(bytes),proof=JSON.parse(await readFile(root+'/EXPORT.json','utf8')),sql=await readFile(root+'/IMPORT_NEW_DATABASE.sql','utf8'),checks=[];
assert.equal(createHash('sha256').update(bytes).digest('hex'),proof.sha256);
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local import rehearsal")}}',host:'127.0.0.1',port:0,compatibilityDate:'2026-07-30',d1Databases:{YIELD_DB:'release-import-rehearsal'},d1Persist:await mkdtemp(join(tmpdir(),'iaero-import-'))});
try{
 const db=await mf.getD1Database('YIELD_DB');for(const migration of ['0001_yield.sql','0002_claim_assessments.sql']){const source=await readFile('worker/migrations/'+migration,'utf8');for(const statement of source.split(/;\s*\n/).filter(s=>s.trim()))await db.exec(statement+';');}
 await db.exec(sql);checks.push('complete frozen archive imports into a fresh migrated D1');
 for(const [key,table] of [['claims','yield_claims'],['snapshots','yield_snapshots'],['valuations','yield_valuations'],['assessments','yield_assessments']]){const rows=await db.prepare('SELECT data FROM '+table+' WHERE position=? ORDER BY rowid').bind(state.position).all();assert.equal(rows.results.length,state[key].length);const saved=new Map(rows.results.map(r=>{const fact=JSON.parse(r.data);return [fact.id,r.data]}));for(const fact of state[key])assert.equal(saved.get(fact.id),JSON.stringify(fact));checks.push(key+': every imported fact is byte-identical ('+rows.results.length+')');}
 const meta=await db.prepare('SELECT cursors FROM yield_meta WHERE position=?').bind(state.position).first();assert.deepEqual(JSON.parse(meta.cursors),state.cursors);checks.push('chain cursors preserved exactly');
 await assert.rejects(()=>db.exec(sql));checks.push('reimport refuses a populated database before changing saved facts');
 const first=state.snapshots[0];await assert.rejects(()=>db.prepare('UPDATE yield_snapshots SET data=? WHERE position=? AND id=?').bind('{}',state.position,first.id).run());checks.push('immutable-history trigger survives the migration');
 const saved=await db.prepare('SELECT data FROM yield_snapshots WHERE position=? AND id=?').bind(state.position,first.id).first();assert.equal(saved.data,JSON.stringify(first));
 const result={status:'PASS',checks,counts:proof.counts,sourceSha256:proof.sha256,productionImported:false};await writeFile(root+'/IMPORT_REHEARSAL.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks:checks.length,snapshots:proof.counts.snapshots,productionImported:false}));
}finally{await mf.dispose();}
