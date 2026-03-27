// ─── Scan Command ──────────────────────────────────────────────────────────────
// "avvia scan storico", "stato scan", "progresso scan"

'use strict';

var scanner = require('../jobs/historicalScanner');

async function run(message, ctx) {
  var msg = (message || '').toLowerCase();

  if (msg.includes('stato scan') || msg.includes('progresso scan')) {
    var progress = await scanner.getProgress();
    var done = progress.filter(function(r) { return r.status === 'done'; }).length;
    var pending = progress.filter(function(r) { return r.status === 'pending'; }).length;
    var errors = progress.filter(function(r) { return r.status === 'error'; }).length;
    var totalKB = progress.reduce(function(a, r) { return a + (r.kb_entries_created || 0); }, 0);
    var totalMsg = progress.reduce(function(a, r) { return a + (r.messages_scanned || 0); }, 0);

    return '*Scan storico:* ' + done + '/' + progress.length + ' canali completati\n' +
      'In attesa: ' + pending + ' | Errori: ' + errors + '\n' +
      'Messaggi analizzati: ' + totalMsg + '\n' +
      'KB entries create: ' + totalKB;
  }

  if (msg.includes('avvia scan') || msg.includes('inizia scan')) {
    if (ctx.userRole !== 'admin') {
      return 'Solo gli admin possono avviare lo scan storico.';
    }
    scanner.runHistoricalScan({ batchSize: 3, userId: ctx.userId })
      .catch(function(e) { console.error('[scanCommand] Error:', e.message); });
    return 'Scan storico avviato su 3 canali alla volta. Usa "stato scan" per monitorare.';
  }

  return '*Comandi scan:*\n• "avvia scan storico" — inizia\n• "stato scan" — progresso';
}

module.exports = { run: run };
