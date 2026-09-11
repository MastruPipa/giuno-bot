'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {periodBounds,buildSnapshot}=require('./model');
const {loadRaw}=require('./data');
const assets={'/giunos':'index.html','/giunos/':'index.html','/giunos/app.js':'app.js','/giunos/style.css':'style.css'};
const security={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' https://framerusercontent.com; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
function send(res,status,body,type='application/json') {res.writeHead(status,{...security,'Content-Type':type+'; charset=utf-8'});res.end(type==='application/json'?JSON.stringify(body):body);}
function createHandler({getClient,authorize,load=loadRaw,clock=()=>new Date()}) {
  return async function(req,res,parsed) {
    if(!assets[parsed.pathname] && parsed.pathname!=='/giunos/api/snapshot') return false;
    if(req.method!=='GET'){send(res,405,{error:'Metodo non consentito'});return true;}
    if(assets[parsed.pathname]) {
      const file=assets[parsed.pathname];send(res,200,fs.readFileSync(path.join(__dirname,'public',file),'utf8'),file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');return true;
    }
    // API never accepts URL credentials. Keep the admin secret out of history/referrers.
    if(!authorize(req,{query:{}})){send(res,401,{error:'Accesso richiesto'});return true;}
    let period;
    try {period=periodBounds(parsed.query.period||'month',parsed.query.date);}
    catch(e){send(res,400,{error:'Periodo non valido'});return true;}
    try {send(res,200,buildSnapshot(await load(getClient()),period,clock()));}
    catch(e){send(res,503,{error:'Dati temporaneamente non disponibili. Riprova tra poco.'});}
    return true;
  };
}
module.exports={createHandler};
