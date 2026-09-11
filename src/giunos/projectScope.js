'use strict';
function hasActiveEvidence(project, today = new Date().toISOString().slice(0,10)) {
  const e = project.lifecycle_evidence;
  const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
  return !!(e && e.state === 'active' && /^https:\/\//.test(e.source_url || '') &&
    date(e.observed_on) && date(e.valid_until) && e.observed_on <= today && today <= e.valid_until);
}
function isActiveProject(p, today) {
  if (p.merged_into || p.status !== 'active' || String(p.id).startsWith('cat_')) return false;
  const imported = /^(attio_|chan_)/.test(p.id) || (p.tags || []).some(t => ['attio-sync','channel-sync'].includes(t));
  if (!imported) return true;
  if (String(p.id).startsWith('attio_') && !(p.tags || []).includes('sales:won')) return false;
  return hasActiveEvidence(p, today);
}
module.exports = {hasActiveEvidence, isActiveProject};
