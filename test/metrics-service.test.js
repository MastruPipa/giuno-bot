'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var metrics = require('../src/services/metricsService');

test('metrics increment/get/snapshot/reset', function() {
  metrics.reset();
  assert.equal(metrics.get('request_total'), 0);

  metrics.increment('request_total');
  metrics.increment('request_total', 2);
  metrics.increment('request_failed_total');

  assert.equal(metrics.get('request_total'), 3);
  assert.equal(metrics.get('request_failed_total'), 1);

  var snap = metrics.snapshot();
  assert.deepEqual(snap, {
    request_total: 3,
    request_failed_total: 1,
  });

  metrics.reset();
  assert.deepEqual(metrics.snapshot(), {});
  assert.equal(fs.existsSync(metrics.getMetricsFilePath()), true);
});
