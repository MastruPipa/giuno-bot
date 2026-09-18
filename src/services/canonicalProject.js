'use strict';
// Resolve the whole merge chain. Missing targets and cycles are never posting accounts.
async function resolve(id, getProject) {
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const row = await getProject(id);
    if (!row) return null;
    if (!row.merged_into) return row.status === 'merged' ? null : row;
    id = row.merged_into;
  }
  return null;
}
module.exports = { resolve };
