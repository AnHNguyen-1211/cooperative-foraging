'use strict';

const http=require('node:http');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const root=fs.realpathSync(path.resolve(__dirname,'../dist'));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
 '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8',
 '.md':'text/plain; charset=utf-8','.csv':'text/csv; charset=utf-8',
 '.zip':'application/zip','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};
function contained(file) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function createStaticServer() {
  return http.createServer(async(req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {Allow: 'GET, HEAD'});
      res.end();
      return ;
    }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(p => p.startsWith('.'))) {
        res.writeHead(404);
        res.end();
        return ;
      }
      let file = path.resolve(root, '.' + pathname);
      if (!contained(file)) {
        res.writeHead(404);
        res.end();
        return ;
      }
      file = await fsp.realpath(file);
      if (!contained(file)) {
        res.writeHead(404);
        res.end();
        return ;
      }
      let stat = await fsp.stat(file);
      if (stat.isDirectory()) {
        file = await fsp.realpath(path.join(file, 'index.html'));
        stat = await fsp.stat(file);
      }
      if (!contained(file) || !stat.isFile()) {
        res.writeHead(404);
        res.end();
        return ;
      }
      res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': stat.size});
      if (req.method === 'HEAD') {
        res.end();
        return ;
      }
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      res.writeHead(error instanceof URIError ? 400: ['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) ? 404: 500);
      res.end();
    }
  });
}
if(require.main===module){
 const port=Number(process.env.SCUDEM_PORT||8000),host=process.env.SCUDEM_HOST||'127.0.0.1';
 if(!Number.isInteger(port)||port<1||port>65535){console.error('SCUDEM_PORT must be between 1 and 65535.');process.exitCode=1;}
 else{
  const server=createStaticServer();
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port in use. Try SCUDEM_PORT=8001 npm start.':error.message);process.exitCode=1;});
  server.listen(port,host,()=>{
   console.log(`SCUDEM: http://${host==='0.0.0.0'?'localhost':host}:${port}`);
   console.log('Keep this window open. Press Ctrl+C to stop.');
  });
  process.on('SIGINT',()=>server.close());
 }
}
module.exports={createStaticServer};
