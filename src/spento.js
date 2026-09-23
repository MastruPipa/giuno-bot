'use strict';
// ─── Interruttore di spegnimento ─────────────────────────────────────────────
// Con la variabile d'ambiente SERVIZIO_SPENTO il processo NON avvia il bot:
// niente Slack, niente cron, niente Supabase. Resta vivo e risponde 200 a
// /healthz, così il deploy risulta riuscito e sostituisce quello precedente
// (un deploy fallito lascia in vita il container vecchio). Serve per il
// servizio duplicato su Railway (progetto imaginative-manifestation, 23/9):
// due bot in produzione si dividevano gli eventi Slack e i cron.
var http = require('node:http');

function avviaSpento(env, logger) {
  env = env || process.env;
  var motivo = String(env.SERVIZIO_SPENTO || '').trim();
  var port = Number(env.PORT) || 8080;
  var server = http.createServer(function(req, res) {
    var ok = req.url === '/healthz';
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'spento', motivo: motivo, uptime: Math.round(process.uptime()) }));
  });
  server.listen(port, function() {
    (logger || console).warn('[SPENTO] Servizio spento (SERVIZIO_SPENTO=' + motivo + '): il bot NON parte. Solo /healthz sulla porta ' + port + '.');
  });
  return server;
}

function isSpento(env) { return !!String((env || process.env).SERVIZIO_SPENTO || '').trim(); }

module.exports = { avviaSpento: avviaSpento, isSpento: isSpento };
