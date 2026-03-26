// ─── Sheets Tools ──────────────────────────────────────────────────────────────
// read_sheet, write_sheet

'use strict';

var logger = require('../utils/logger');
var { withTimeout } = require('../utils/timeout');
var { getSheetPerUtente, handleTokenScaduto } = require('../services/googleAuthService');
var { askGemini } = require('../services/geminiService');

// ─── Tool definitions ──────────────────────────────────────────────────────────

var definitions = [
  {
    name: 'read_sheet',
    description: 'Legge il contenuto di un Google Sheet. Restituisce righe come array di array. Se non specifichi sheet_name, restituisce la lista dei fogli disponibili + anteprima del primo.',
    input_schema: {
      type: 'object',
      properties: {
        sheet_id:    { type: 'string', description: 'ID del Google Sheet (dalla URL o da search_drive)' },
        range:       { type: 'string', description: 'Range da leggere, es. "A1:Z100" (default "A1:Z100")' },
        sheet_name:  { type: 'string', description: 'Nome del foglio specifico.' },
        list_sheets: { type: 'boolean', description: 'Se true, restituisce solo la lista dei fogli senza leggere dati' },
      },
      required: ['sheet_id'],
    },
  },
  {
    name: 'write_sheet',
    description: 'Scrive dati in un Google Sheet. Richiede conferma prima dell\'esecuzione.',
    input_schema: {
      type: 'object',
      properties: {
        sheet_id:   { type: 'string', description: 'ID del Google Sheet' },
        range:      { type: 'string', description: 'Range dove scrivere, es. "A1:C3" o "Foglio2!A1:B5"' },
        values:     { type: 'array', items: { type: 'array' }, description: 'Array di righe, ogni riga è un array di valori' },
        sheet_name: { type: 'string', description: 'Nome del foglio (opzionale, default primo foglio)' },
      },
      required: ['sheet_id', 'range', 'values'],
    },
  },
];

// ─── Tool execution ────────────────────────────────────────────────────────────

async function execute(toolName, input, userId) {
  var sheets = getSheetPerUtente(userId);
  if (!sheets) return { error: 'Google Sheets non collegato. Scrivi "collega il mio Google".' };

  try {
    if (toolName === 'read_sheet') {
      var meta = await withTimeout(sheets.spreadsheets.get({
        spreadsheetId: input.sheet_id,
        fields: 'sheets.properties',
      }), 8000, 'read_sheet_meta');
      var sheetNames = (meta.data.sheets || []).map(function(s) {
        return { name: s.properties.title, index: s.properties.index, rows: s.properties.gridProperties.rowCount, cols: s.properties.gridProperties.columnCount };
      });

      if (input.list_sheets) {
        return { sheet_id: input.sheet_id, sheets: sheetNames, sheet_count: sheetNames.length };
      }

      var targetSheet = input.sheet_name;
      if (!targetSheet && sheetNames.length > 0) {
        targetSheet = sheetNames[0].name;
      }

      var range = targetSheet
        ? "'" + targetSheet.replace(/'/g, "''") + "'!" + (input.range || 'A1:Z100')
        : (input.range || 'A1:Z100');

      var sheetRes = await withTimeout(sheets.spreadsheets.values.get({
        spreadsheetId: input.sheet_id,
        range: range,
      }), 8000, 'read_sheet');
      var rows = sheetRes.data.values || [];
      return {
        sheet_id: input.sheet_id,
        current_sheet: targetSheet,
        range: range,
        sheets_available: sheetNames.map(function(s) { return s.name; }),
        rows: rows,
        row_count: rows.length,
        preview: rows.slice(0, 5),
      };
    }

    if (toolName === 'write_sheet') {
      var writeRange = input.sheet_name
        ? "'" + input.sheet_name.replace(/'/g, "''") + "'!" + input.range
        : input.range;
      var writeRes = await sheets.spreadsheets.values.update({
        spreadsheetId: input.sheet_id,
        range: writeRange,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: input.values },
      });
      return {
        success: true,
        updated_range: writeRes.data.updatedRange,
        updated_rows: writeRes.data.updatedRows,
        updated_cols: writeRes.data.updatedColumns,
        updated_cells: writeRes.data.updatedCells,
      };
    }

  } catch(e) {
    if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
    return { error: e.message };
  }

  return { error: 'Tool sconosciuto nel modulo sheetsTools: ' + toolName };
}

// Gemini pre-review for write_sheet (called by registry before confirming)
async function reviewWriteSheet(input) {
  try {
    var sheetReview = await askGemini(
      'Controlla questi dati che stanno per essere scritti in un Google Sheet.\n' +
      'Range: ' + input.range + '\nDati:\n' + JSON.stringify(input.values).substring(0, 2000) +
      '\n\nControlla: numeri sensati, formati corretti, possibili errori di battitura. Se tutto ok rispondi "OK". Altrimenti segnala il problema in 1 riga.',
      'Sei un revisore dati. Rispondi in italiano, brevissimo.'
    );
    if (sheetReview && sheetReview.response && sheetReview.response.trim() !== 'OK') {
      return sheetReview.response;
    }
  } catch(e) { logger.error('Gemini write_sheet review error:', e.message); }
  return null;
}

module.exports = { definitions: definitions, execute: execute, reviewWriteSheet: reviewWriteSheet };
