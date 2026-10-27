// Produces SQL for a NEW, collector-disabled database. Existing facts or a live
// lease stop the import. Publication requires a full post-import hash comparison.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateLedger} from '../src/protocol-data/yield-model.ts';
import {expectedYieldPosition} from '../src/protocol-data/identity.ts';
const root='artifacts/portfolio-release/history',bytes=await readFile(root+'/PRODUCTION_HISTORY_SEED.json','utf8'),proof=JSON.parse(await readFile(root+'/EXPORT.json','utf8'));
if(createHash('sha256').update(bytes).digest('hex')!==proof.sha256)throw Error('History source seal changed.');const state=JSON.parse(bytes);validateLedger(state,expectedYieldPosition);
const literal=value=>"'"+String(value).replaceAll("'","''")+"'",position=literal(state.position),tables=['yield_claims','yield_snapshots','yield_valuations','yield_assessments'];
const empty=['yield_meta',...tables,'yield_reports','legacy_indexes'].map(table=>'NOT EXISTS(SELECT 1 FROM '+table+')').join(' AND ');
const statements=[`INSERT INTO yield_commit_guard VALUES(${position},CASE WHEN ${empty} AND NOT EXISTS(SELECT 1 FROM yield_leases WHERE expiresAt>${Date.now()}) THEN 1 ELSE 0 END);`];
for(const [key,table] of [['claims','yield_claims'],['snapshots','yield_snapshots'],['valuations','yield_valuations'],['assessments','yield_assessments']])for(const fact of state[key]??[])statements.push(`INSERT INTO ${table} VALUES(${position},${literal(fact.id)},${key==='claims'||key==='snapshots'?String(fact.timestamp):literal(fact.claimId)},${literal(JSON.stringify(fact))});`);
statements.push(`INSERT INTO yield_meta VALUES(${position},1,${literal(JSON.stringify(state.cursors))});`,`DELETE FROM yield_commit_guard WHERE position=${position};`);
if(statements.some(s=>Buffer.byteLength(s)>95000))throw Error('An import statement exceeds the D1 query budget.');
const sql=statements.join('\n')+'\n';await writeFile(root+'/IMPORT_NEW_DATABASE.sql',sql,{flag:'wx'});console.log(JSON.stringify({prepared:true,statements:statements.length,bytes:Buffer.byteLength(sql),sourceSha256:proof.sha256,sqlSha256:createHash('sha256').update(sql).digest('hex'),imported:false}));
