// Produce a separate publishable directory. Never overwrite the local preview,
// contact a Cloudflare account, or select credentials during a build.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile,rm,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const cloudflare=process.argv.includes('--cloudflare'),output=resolve(cloudflare?'.vercel/output/static':'.release/pages'),bundle=resolve('.release/pages-worker');
await rm(output,{recursive:true,force:true});await rm(bundle,{recursive:true,force:true});await mkdir(output,{recursive:true});
let commit=process.env.CF_PAGES_COMMIT_SHA??process.env.IAERO_RELEASE_COMMIT;
if(!commit)try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}catch{}
execFileSync('npm',['run','build','--','--outDir',output],{stdio:'inherit',env:{...process.env,VITE_PROTOCOL_DATA_URL:'',VITE_APP_STAGE:'production',IAERO_RELEASE_COMMIT:commit??''}});
const config=JSON.parse(await readFile(output+'/frontend-config.json','utf8'));if(config.protocolDataOrigin)throw Error('Release must use its same-origin shared-history API.');
execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--config','config/wrangler.pages-build.jsonc','--dry-run','--outdir',bundle],{stdio:'inherit'});
await copyFile(bundle+'/pages.js',output+'/_worker.js');
async function removeMaps(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;if(entry.isDirectory())await removeMaps(path);else if(entry.name.endsWith('.map'))await rm(path);}}await removeMaps(output);
await writeFile(output+'/_routes.json',JSON.stringify({version:1,include:['/api/*'],exclude:[]})+'\n');
await writeFile(output+'/_headers','/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/index.html\n  Cache-Control: no-cache\n');
const files=[];async function seal(dir,prefix=''){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=dir+'/'+entry.name,key=prefix+entry.name;if(entry.isDirectory())await seal(path,key+'/');else{const bytes=await readFile(path);files.push({path:key,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}}}await seal(output);
await writeFile(resolve('.release/PAGES_MANIFEST.json'),JSON.stringify({version:1,createdAt:new Date().toISOString(),status:'BUILT; PUBLICATION_AND_LIVE_SMOKE_TEST_PENDING',sameOriginHistory:true,files},null,2)+'\n');
console.log(JSON.stringify({status:'PAGES_BUILD_COMPLETE',files:files.length,directory:cloudflare?'.vercel/output/static':'.release/pages',published:false}));
