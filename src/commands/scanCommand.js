// ─── Scan Command V2 ─────────────────────────────────────────────────────────
// "avvia scan storico", "scan drive", "scan completo", "stato scan"
'use strict';

var scanner = require('../jobs/historicalScanner');

async function run(message, ctx) {
  var msg = (message || '').toLowerCase();

  // Status
  if (msg.includes('stato scan') || msg.includes('progresso scan')) {
    var progress = await scanner.getProgress();
    var done = progress.filter(function(r) { return r.status === 'done'; }).length;
    var pending = progress.filter(function(r) { return r.status === 'pending'; }).length;
    var errors = progress.filter(function(r) { return r.status === 'error'; }).length;
    var inProg = progress.filter(function(r) { return r.status === 'in_progress'; }).length;
    var totalKB = progress.reduce(function(a, r) { return a + (r.kb_entries_created || 0); }, 0);
    var totalMsg = progress.reduce(function(a, r) { return a + (r.messages_scanned || 0); }, 0);
    var emoji = done === progress.length ? '✅' : '🔄';

    var status = emoji + ' *Scan storico:* ' + done + '/' + progress.length + ' canali\n' +
      'In corso: ' + inProg + ' | Attesa: ' + pending + ' | Errori: ' + errors + '\n' +
      'Messaggi: ' + totalMsg.toLocaleString() + ' | KB entries: ' + totalKB;
    if (errors > 0) {
      status += '\nErrori: ' + progress.filter(function(r) { return r.status === 'error'; }).map(function(r) { return r.source_name; }).join(', ');
    }
    return status;
  }

  // Slack scan
  if (msg.includes('avvia scan') || msg.includes('inizia scan') || msg.includes('scan storico')) {
    if (ctx.userRole !== 'admin') return 'Solo admin possono avviare lo scan.';
    var batch = 3;
    var bm = msg.match(/scan\s+(?:storico\s+)?(\d+)/);
    if (bm) batch = Math.min(10, parseInt(bm[1]));
    var withDrive = msg.includes('completo') || msg.includes('drive');

    scanner.runHistoricalScan({ batchSize: batch, userId: ctx.userId, includeDrive: withDrive })
      .catch(function(e) { console.error('[scan]', e.message); });

    return '*Scan avviato*\nSlack: ' + batch + ' canali/batch' +
      (withDrive ? '\nDrive: incluso' : '') + '\nUsa "stato scan" per monitorare.';
  }

  // Drive-only scan
  if (msg.includes('scan drive') || msg.includes('indicizza drive')) {
    if (ctx.userRole !== 'admin' && ctx.userRole !== 'finance') return 'Solo admin/finance.';
    var max = 50;
    var dm = msg.match(/drive\s+(\d+)/);
    if (dm) max = Math.min(200, parseInt(dm[1]));

    scanner.runHistoricalScan({ batchSize: 0, userId: ctx.userId, includeDrive: true, driveMaxFiles: max })
      .catch(function(e) { console.error('[scan-drive]', e.message); });

    return '*Scan Drive avviato* — fino a ' + max + ' documenti\nUsa "stato scan" per monitorare.';
  }

  return '*Comandi scan:*\n• "avvia scan storico" / "avvia scan storico 5"\n• "scan drive" / "scan drive 100"\n• "scan completo"\n• "stato scan"';
}

module.exports = { run: run };
