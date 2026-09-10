'use strict';
// Starts ONLY the dashboard. Never starts Slack, cron or data-collection jobs.
require('dotenv').config();
const http=require('node:http');
const url=require('node:url');
const {createHandler}=require('../src/giunos/handler');
const client=require('../src/services/db/client');
const secret=process.env.OAUTH_ADMIN_TOKEN;
const handler=createHandler({getClient:()=>client.getClient(),authorize:req=>secret?req.headers['x-admin-token']===secret:process.env.NODE_ENV!=='production'});
http.createServer(async(req,res)=>{if(req.url==='/'){res.writeHead(302,{Location:'/giunos'});res.end();return;}if(!await handler(req,res,url.parse(req.url,true))){res.writeHead(404);res.end('Not found');}}).listen(Number(process.env.GIUNOS_PORT||8766),'127.0.0.1',()=>console.log('giun.os: http://127.0.0.1:'+(process.env.GIUNOS_PORT||8766)+'/giunos'));
