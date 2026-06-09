'use strict';

var test = require('node:test');
var assert = require('node:assert');

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'x';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'x';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'x';

var cb = require('../src/orchestrator/contextBuilder');

test('formatContextForPrompt renders an ATTIO section from attioContext', function() {
  var out = cb.formatContextForPrompt({
    attioContext: {
      companies: [{ record_id: 'c1', values: { name: 'Tomarchio Bibite', description: 'Bibite siciliane' } }],
      deals: [{ record_id: 'd1', values: { name: 'rebranding cola', stage: 'Won 🎉', value: 3799 } }],
    },
  });
  assert.match(out, /ATTIO \(CRM/);
  assert.match(out, /AZIENDA Tomarchio Bibite/);
  assert.match(out, /DEAL rebranding cola/);
  assert.match(out, /Won/);
});

test('formatContextForPrompt omits ATTIO when there is nothing to show', function() {
  var out = cb.formatContextForPrompt({ attioContext: { companies: [], deals: [] } });
  assert.ok(!/ATTIO/.test(out), 'should not render an empty ATTIO section');
});
