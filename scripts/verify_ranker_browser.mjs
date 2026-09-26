// Local-only integration harness for the actual production Worker and OPFS.
// Usage: node scripts/verify_ranker_browser.mjs MODEL FIXTURES RESULT
import http from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile, readdir, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
const [model, fixtureFile, resultFile] = process.argv.slice(2);
if (!resultFile) throw new Error('MODEL FIXTURES RESULT required');
const port = 8378;
const workerName = (await readdir('dist/client/assets')).find(n => /^model\.worker-.*\.js$/.test(n));
if (!workerName) throw new Error('Build the application before checking its Worker');
const manifest = JSON.parse(await readFile(path.join(model, 'browser-model-manifest.json'), 'utf8'));
for (const r of [manifest.browser_catalog, ...manifest.files]) r.url = '/assets/' + path.basename(r.path);
const fixtures = JSON.parse(await readFile(fixtureFile, 'utf8')).filter(r => r.name.startsWith('personal-'));
const html = `<!doctype html><meta charset="utf-8"><title>Model integration verification</title><button id="start">Verify download and recommendations</button><pre id="state">Ready</pre><script type="module">
const state = document.querySelector('#state');
let worker = new Worker('/worker.js', {type:'module'}), id=0;
const pending = new Map();
function listen(){ worker.onmessage=e=>{const r=e.data;if(r.type==='progress'){state.textContent='Downloading '+r.value.downloadedBytes;return;}const p=pending.get(r.id);pending.delete(r.id);r.type==='error'?p.reject(Error(r.error)):p.resolve(r.value);}; }
listen();
function call(type,data={}){return new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});worker.postMessage({id,type,...data});});}
document.querySelector('#start').onclick=async()=>{try{
 const started=performance.now();
 const testManifest=await (await fetch('/manifest.json')).json();
 const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('fanjian-model-v1',{create:true});
 try { await root.getFileHandle('versions.json'); } catch(e) {
   if(e.name!=='NotFoundError') throw e;
   const file=await root.getFileHandle('versions.json',{create:true}), stream=await file.createWritable();
   await stream.write(JSON.stringify({[testManifest.model_version]:{manifest:testManifest,directory:'versions/'+encodeURIComponent(testManifest.model_version),installed:false,verified:{}}}));
   await stream.close();
 }
 const initial=await call('status',{manifestUrl:'/manifest.json'});
 if(initial.state!=='ready') await call('download',{manifestUrl:'/manifest.json',version:testManifest.model_version});
 const status=await call('status',{manifestUrl:'/manifest.json'});
 if(status.state!=='ready') throw Error('Not ready after download');
 const fixtures=await (await fetch('/fixtures.json')).json();
 const rows=[];
 for(const f of fixtures){
   const payload={ratings:f.ratings,excluded:f.workerExcluded,negativeItems:[],limit:100,minSupport:5,allowSequels:true,formats:[],excludeRelated:f.excludeRelated};
   const start=performance.now(), result=await call('recommend',{payload});
   const actual=result.items.map(r=>r.anime.mal_id);
   if(JSON.stringify(actual)!==JSON.stringify(f.expected)) throw Error('Ranking mismatch '+f.name);
   const page=await call('recommend',{payload:{...payload,offset:20,limit:20}});
   if(JSON.stringify(page.items.map(r=>r.anime.mal_id))!==JSON.stringify(actual.slice(20,40))) throw Error('Paging mismatch');
   if(result.items.some(r=>r.score_kind!=='rank')) throw Error('Wrong score semantics');
   rows.push({name:f.name,count:actual.length,milliseconds:performance.now()-start});
 }
 const empty=await call('recommend',{payload:{ratings:{1:4},excluded:[],negativeItems:[],limit:20,minSupport:5,allowSequels:true,formats:[]}});
 if(empty.items.length||empty.hasMore) throw Error('No-liked profile must be empty');
 worker.terminate(); worker=new Worker('/worker.js',{type:'module'});listen();
 const reload=await call('status',{manifestUrl:'/manifest.json'});
 if(reload.state!=='ready') throw Error('Model not persistent');
 const report={passed:true,version:status.manifest.model_version,profiles:rows.length,rows,milliseconds:performance.now()-started,persistence:true,noLikedEmpty:true,pagination:true};
 await fetch('/result',{method:'POST',body:JSON.stringify(report)});state.textContent=JSON.stringify(report);
 }catch(e){state.textContent='FAILED '+e.message;await fetch('/result',{method:'POST',body:JSON.stringify({passed:false,error:e.message})});}};
</script>`;
http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
  if(url.pathname==='/manifest.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(manifest));return;}
  if(url.pathname==='/fixtures.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixtures));return;}
  if(url.pathname==='/result'&&req.method==='POST'){let body='';for await(const b of req)body+=b;await writeFile(resultFile,body);res.end('saved');return;}
  let file;
  if(url.pathname==='/worker.js'){const current=(await readdir('dist/client/assets')).find(n=>/^model\.worker-.*\.js$/.test(n));file=path.resolve('dist/client/assets',current);res.setHeader('Content-Type','text/javascript');}
  else if(url.pathname.startsWith('/assets/')){
    const name=url.pathname.slice(8);if(name!==path.basename(name))throw Error('Invalid path');file=path.resolve(model,name);
  }else {res.writeHead(404);res.end();return;}
  const size=(await stat(file)).size;
  const start=req.headers.range?Number(req.headers.range.match(/^bytes=(\d+)-$/)?.[1]):0;
  if(!Number.isInteger(start)||start<0||start>=size){res.writeHead(416);res.end();return;}
  res.setHeader('Content-Length',size-start);res.setHeader('Accept-Ranges','bytes');
  if(start){res.writeHead(206,{'Content-Range': 'bytes '+start+'-'+(size-1)+'/'+size});}
  createReadStream(file,{start}).pipe(res);
 }catch(e){res.writeHead(500);res.end(e.message);}
}).listen(port,'127.0.0.1',()=>console.log('Verification harness http://127.0.0.1:'+port));
