// ─── Web Search Tool ──────────────────────────────────────────────────────────
// Uses Brave Search API for web searches.
// Requires BRAVE_SEARCH_API_KEY env var.

'use strict';

var logger = require('../utils/logger');

var definitions = [
  {
    name: 'web_search',
    description: 'Cerca informazioni aggiornate sul web. ' +
      'Usa per: notizie recenti su aziende/persone, prezzi, dati di mercato, ' +
      'verifica dati specifici, info che potrebbero essere cambiate. ' +
      'NON usare per dati già in KB, CRM o Slack.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query di ricerca. Sii specifico.' },
        max_results: { type: 'number', description: 'Numero risultati (default 5, max 10)' },
      },
      required: ['query'],
    },
  },
];

async function execute(toolName, input) {
  if (toolName !== 'web_search') return { error: 'Tool sconosciuto in webTools: ' + toolName };

  var query = input.query || '';
  var maxResults = Math.min(input.max_results || 5, 10);
  var apiKey = process.env.BRAVE_SEARCH_API_KEY;

  if (!apiKey) {
    return {
      error: 'Web search non configurato. Aggiungi BRAVE_SEARCH_API_KEY su Railway.',
      fallback: 'Cerca manualmente: https://www.google.com/search?q=' + encodeURIComponent(query),
    };
  }

  try {
    var https = require('https');
    var url = 'https://api.search.brave.com/res/v1/web/search?q=' +
      encodeURIComponent(query) + '&count=' + maxResults;

    var data = await new Promise(function(resolve, reject) {
      var req = https.get(url, {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey,
        },
      }, function(res) {
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          if (res.statusCode !== 200) {
            reject(new Error('HTTP ' + res.statusCode));
            return;
          }
          try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, function() { req.destroy(); reject(new Error('timeout')); });
    });

    var results = (data.web && data.web.results) || [];
    return {
      query: query,
      results: results.map(function(r) {
        return {
          title: r.title || '',
          url: r.url || '',
          description: (r.description || '').substring(0, 300),
        };
      }),
      count: results.length,
    };
  } catch(e) {
    logger.error('[WEB-SEARCH] Errore:', e.message);
    return { error: 'Errore ricerca web: ' + e.message };
  }
}

module.exports = { definitions: definitions, execute: execute };
