'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHmac,createHash,timingSafeEqual}=require('node:crypto');
const {periodBounds,buildSnapshot}=require('./model');
const {loadRaw}=require('./data');
const assets={'/giunos':'index.html','/giunos/':'index.html','/giunos/app.js':'app.js','/giunos/ux.js':'ux.js','/giunos/style.css':'style.css'};
// ─── Sessione con cookie ─────────────────────────────────────────────────────
// La chiave si digita una volta: POST /giunos/api/login la verifica con lo
// stesso authorize dell'API e risponde con un cookie firmato (HMAC della
// scadenza con un segreto derivato dalla chiave), HttpOnly, SameSite=Strict,
// Secure su https, 12 ore. L'API accetta il cookie o l'header x-admin-token.
// Niente stato lato server: cambiare la chiave invalida tutte le sessioni.
const SESSION_COOKIE='giunos_session';
const SESSION_TTL_MS=12*3600000;
const sessionKey=secret=>createHash('sha256').update('giunos-session:'+secret).digest();
function signSession(secret,exp) { return exp+'.'+createHmac('sha256',sessionKey(secret)).update(String(exp)).digest('base64url'); }
function verifySession(secret,value,now) {
  if(!secret||typeof value!=='string') return false;
  const dot=value.indexOf('.'); if(dot<1) return false;
  const exp=Number(value.slice(0,dot));
  if(!Number.isFinite(exp)||exp<=now) return false;
  const expected=Buffer.from(signSession(secret,exp)), actual=Buffer.from(value);
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
function cookieOf(req) {
  const m=/(?:^|;\s*)giunos_session=([^;]+)/.exec(String(req.headers.cookie||''));
  return m?decodeURIComponent(m[1]):null;
}
function isHttps(req) { return String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https'; }
function sessionCookie(value,maxAge,req) {
  return SESSION_COOKIE+'='+encodeURIComponent(value)+'; Path=/giunos; HttpOnly; SameSite=Strict; Max-Age='+maxAge+(isHttps(req)?'; Secure':'');
}
async function readJsonBody(req,limit=4096) {
  if(req.body!==undefined) return typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
  if(typeof req.on!=='function') return {};
  return new Promise((resolve,reject)=>{
    let data='';
    req.on('data',c=>{data+=c;if(data.length>limit){reject(new Error('Body troppo grande'));req.destroy();}});
    req.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch(e){reject(e);}});
    req.on('error',reject);
  });
}
const security={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' https://framerusercontent.com; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
function send(res,status,body,type='application/json',extra={}) {res.writeHead(status,{...security,...extra,'Content-Type':type+'; charset=utf-8'});res.end(type==='application/json'?JSON.stringify(body):body);}
// I dati grezzi (14 tabelle intere) valgono per ogni periodo: si tengono in
// memoria per CACHE_MS, così cambiare periodo o pagina non rilegge Supabase
// (23/9: 5,4 s a chiamata). "Aggiorna" passa refresh=1 e forza la rilettura.
const CACHE_MS=120000;
function createHandler({getClient,authorize,load=loadRaw,clock=()=>new Date(),cacheMs=CACHE_MS,sessionSecret=null}) {
  let cache=null;
  const authorized=req=>authorize(req,{query:{}})||(!!sessionSecret&&verifySession(sessionSecret,cookieOf(req),clock().getTime()));
  async function loadCached(client,force) {
    const now=clock().getTime();
    if(!force&&cache&&cache.client===client&&now-cache.at<cacheMs) return cache.raw;
    const raw=await load(client);
    cache={client,at:now,raw};
    return raw;
  }
  return async function(req,res,parsed) {
    if(!assets[parsed.pathname] && !['/giunos/api/snapshot','/giunos/api/login','/giunos/api/logout'].includes(parsed.pathname)) return false;
    if(parsed.pathname==='/giunos/api/login'||parsed.pathname==='/giunos/api/logout') {
      if(req.method!=='POST'){send(res,405,{error:'Metodo non consentito'});return true;}
      if(parsed.pathname==='/giunos/api/logout'){send(res,200,{ok:true},'application/json',{'Set-Cookie':sessionCookie('',0,req)});return true;}
      if(!sessionSecret){send(res,404,{error:'Sessioni non disponibili: chiave di accesso non configurata'});return true;}
      let key='';
      try {key=String((await readJsonBody(req)).key||'');} catch(e){send(res,400,{error:'Richiesta non valida'});return true;}
      // Stessa verifica dell'API: la chiave viaggia solo nel corpo, mai nell'URL.
      if(!key||!authorize({headers:{'x-admin-token':key}},{query:{}})){send(res,401,{error:'Chiave non valida'});return true;}
      const exp=clock().getTime()+SESSION_TTL_MS;
      send(res,200,{ok:true,expiresAt:new Date(exp).toISOString()},'application/json',{'Set-Cookie':sessionCookie(signSession(sessionSecret,exp),Math.floor(SESSION_TTL_MS/1000),req)});
      return true;
    }
    if(req.method!=='GET'){send(res,405,{error:'Metodo non consentito'});return true;}
    if(assets[parsed.pathname]) {
      const file=assets[parsed.pathname];send(res,200,fs.readFileSync(path.join(__dirname,'public',file),'utf8'),file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');return true;
    }
    // API never accepts URL credentials. Keep the admin secret out of history/referrers.
    if(!authorized(req)){send(res,401,{error:'Accesso richiesto'});return true;}
    let period;
    try {period=periodBounds(parsed.query.period||'month',parsed.query.date);}
    catch(e){send(res,400,{error:'Periodo non valido'});return true;}
    try {const raw=await loadCached(getClient(),parsed.query.refresh==='1');send(res,200,{...buildSnapshot(raw,period,clock()),cachedAt:new Date(cache.at).toISOString()});}
    catch(e){send(res,503,{error:'Dati temporaneamente non disponibili. Riprova tra poco.'});}
    return true;
  };
}
module.exports={createHandler,signSession,verifySession};
