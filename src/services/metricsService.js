// ─── Metrics Service (in-memory counters) ───────────────────────────────────

'use strict';

var counters = Object.create(null);

function increment(name, by) {
  by = (typeof by === 'number' && !Number.isNaN(by)) ? by : 1;
  counters[name] = (counters[name] || 0) + by;
  return counters[name];
}

function get(name) {
  return counters[name] || 0;
}

function snapshot() {
  return Object.assign({}, counters);
}

function reset() {
  Object.keys(counters).forEach(function(k) { delete counters[k]; });
}

module.exports = {
  increment: increment,
  get: get,
  snapshot: snapshot,
  reset: reset,
};
