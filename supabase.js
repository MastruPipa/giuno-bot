// ─── Supabase facade ─────────────────────────────────────────────────────────
// All logic lives in src/services/db/. This file exists so that existing
// require('../../supabase') and require('../supabase') paths keep working.

'use strict';

module.exports = require('./src/services/db');
