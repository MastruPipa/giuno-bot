// ─── Slack retry classifier ──────────────────────────────────────────────────

'use strict';

var { isTransientError } = require('../errors');

function shouldRetrySlackError(e) {
  if (!e) return false;
  if (isTransientError(e)) return true;
  var msg = (e.message || '').toLowerCase();
  var code = ((e.data && e.data.error) || e.code || '').toString().toLowerCase();
  return code === 'ratelimited' || code === 'slack_webapi_platform_error' ||
    msg.includes('timeout') || msg.includes('socket hang up') || msg.includes('econnreset') || msg.includes('etimedout');
}

module.exports = {
  shouldRetrySlackError: shouldRetrySlackError,
};
