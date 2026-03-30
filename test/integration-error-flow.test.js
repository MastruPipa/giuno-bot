'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { toUserErrorMessage } = require('../src/utils/errorResponse');
var { PermissionError, TimeoutError, ExternalServiceError } = require('../src/errors');

test('integration: error taxonomy maps to stable user messages', function() {
  assert.equal(toUserErrorMessage(new PermissionError('x')), 'Non hai i permessi per questa operazione.');
  assert.equal(toUserErrorMessage(new TimeoutError('x')), 'Sto impiegando troppo tempo a rispondere. Riprova tra poco.');
  assert.equal(toUserErrorMessage(new ExternalServiceError('x')), 'Un servizio esterno non è disponibile in questo momento. Riprova tra poco.');
});
