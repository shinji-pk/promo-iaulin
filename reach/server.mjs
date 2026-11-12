import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
  try{
    let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{"status":"ok"}');return;}
    const f=pathname==='/'?'/index.html':pathname;
    const resolved=path.resolve(root,'.'+f);
    if(!resolved.startsWith(root+path.sep))throw new Error('invalid path');
    const data=await readFile(resolved);
    res.writeHead(200,{'content-type':mime[path.extname(resolved)]||'application/octet-stream','cache-control':path.extname(resolved)==='.html'?'no-store':'public, max-age=300','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin'});
    res.end(data);
  }catch(e){res.writeHead(404,{'content-type':'text/plain'});res.end('Not found');}
}).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Shinji Reach ready'));