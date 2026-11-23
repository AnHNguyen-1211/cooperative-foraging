'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createStaticServer}=require('../scripts/serve.cjs');
const server=createStaticServer(),originalCwd=process.cwd();
function request(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: server.address().port, path: url, method}, res => {
      const chunks = [];
      res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.end();
  });
}
(async()=>{
 process.chdir(os.tmpdir());
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const page=await request('/');assert.equal(page.status,200);assert.match(page.headers['content-type'],/^text\/html/);
  assert.deepEqual(page.body,fs.readFileSync(path.join(__dirname,'../dist/index.html')));
  const worker=await request('/worker.js?v=2.0.3');assert.equal(worker.status,200);assert.match(worker.headers['content-type'],/^text\/javascript/);
  assert.deepEqual(worker.body,fs.readFileSync(path.join(__dirname,'../dist/worker.js')));
  assert.equal(worker.headers['cache-control'],'no-store');
  const head=await request('/engine.js','HEAD');assert.equal(head.status,200);assert.equal(head.body.length,0);
  for(const p of ['/missing-file','/tests/test_engine.cjs','/%2e%2e%2fpackage.json','/.openai/hosting.json','/%00'])assert.equal((await request(p)).status,404,p);
  assert.equal((await request('/bad%ZZ')).status,400);
  assert.equal((await request('/','POST')).status,405);
  assert.equal((await request('/scudem_source.zip')).status,404,'Source bundle must not be published');
  console.log('PASS: local server serves dist from any working directory, Worker MIME, HEAD, cache and path handling');
 }finally{await new Promise(resolve=>server.close(resolve));process.chdir(originalCwd);}
})().catch(e=>{console.error(e);process.exitCode=1;});
