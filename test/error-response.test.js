'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { toUserErrorMessage } = require('../src/utils/errorResponse');
var { PermissionError, TimeoutError, UserInputError } = require('../src/errors');

test('toUserErrorMessage maps known errors to friendly messages', function() {
  assert.equal(toUserErrorMessage(new PermissionError('x')), 'Non hai i permessi per questa operazione.');
  assert.equal(toUserErrorMessage(new TimeoutError('x')), 'Sto impiegando troppo tempo a rispondere. Riprova tra poco.');
  assert.equal(toUserErrorMessage(new UserInputError('Input errato')), 'Input errato');
  assert.equal(toUserErrorMessage(new Error('boom')), 'Si è verificato un errore inatteso. Riprova tra poco.');
});
