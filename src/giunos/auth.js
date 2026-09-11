'use strict';
const {timingSafeEqual} = require('node:crypto');
function authorize(req, parsed, key, fallback) {
  if (!key) return fallback(req, parsed);
  const supplied = req.headers['x-admin-token'];
  if (typeof supplied !== 'string') return false;
  const actual = Buffer.from(supplied), expected = Buffer.from(key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
module.exports = {authorize};
