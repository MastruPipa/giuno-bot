// ─── Slack formatting utilities ────────────────────────────────────────────────

'use strict';

var SLACK_FORMAT_RULES =
  'Formattazione Slack: *grassetto* con singolo asterisco, _corsivo_, ' +
  '`codice`. MAI ** o ##. Liste con • o numeri. Risposte concise.';

function formatPerSlack(text) {
  if (!text) return '';
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .replace(/^[ \t]*-\s+/gm, '• ')
    .replace(/^[ \t]*\*\s+(?!\*)/gm, '• ')
    .replace(/```[a-zA-Z]+\n/g, '```\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  SLACK_FORMAT_RULES: SLACK_FORMAT_RULES,
  formatPerSlack: formatPerSlack,
};
