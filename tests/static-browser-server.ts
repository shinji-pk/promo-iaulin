import express from 'express';
const app=express();
app.use('/api',(_req,res)=>res.status(404).json({error:'API não disponível nesta demonstração estática.'}));
app.use(express.static('apps/web/dist'));
const server=app.listen(4174,'127.0.0.1');
process.on('SIGTERM',()=>server.close());
