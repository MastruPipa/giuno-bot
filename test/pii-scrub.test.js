'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { scrubPII, hasPII } = require('../src/utils/piiScrub');

test('scrubPII replaces emails, phones, IBANs, codice fiscale, carte', function() {
  var input = 'Mail antonio@katania.studio, tel +39 333 1234567, IBAN IT60X0542811101000000123456, CF RSSMRA85L01H501Z, carta 4111 1111 1111 1111';
  var out = scrubPII(input);
  assert.ok(out.includes('[email]'), 'email masked');
  assert.ok(out.includes('[telefono]'), 'phone masked');
  assert.ok(out.includes('[iban]'), 'iban masked');
  assert.ok(out.includes('[cf]'), 'codice fiscale masked');
  assert.ok(out.includes('[carta]'), 'credit card masked');
  assert.ok(!out.includes('antonio@katania.studio'), 'no raw email');
  assert.ok(!out.includes('IT60X0542811101000000123456'), 'no raw iban');
});

test('scrubPII leaves non-PII content untouched', function() {
  var clean = 'Oggi ho parlato con il cliente, budget 15000 euro.';
  assert.equal(scrubPII(clean), clean);
});

test('scrubPII does not mangle timestamps or ids', function() {
  var slackTs = '1712345678.987654';
  var uuid = 'abc-123-def-456';
  var out = scrubPII('ref ' + slackTs + ' ' + uuid);
  // Slack ts has only digits — phone regex might hit but digits.length == 16
  // is outside 8..12 so should pass through. UUID has dashes / letters, not PII.
  assert.ok(out.includes(uuid), 'uuid preserved');
});

test('hasPII returns true only for actual PII patterns', function() {
  assert.equal(hasPII('email: test@example.com'), true);
  assert.equal(hasPII('IBAN IT60X0542811101000000123456'), true);
  assert.equal(hasPII('nessun dato sensibile qui'), false);
});
