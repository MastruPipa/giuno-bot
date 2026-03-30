// ─── Gemini Service ────────────────────────────────────────────────────────────
// Google Gemini AI init, askGemini, fetchNewsMarketing.

'use strict';

require('dotenv').config();

var logger = require('../utils/logger');
var { createCircuitBreaker } = require('../utils/circuitBreaker');

// ─── Init ──────────────────────────────────────────────────────────────────────

var GoogleGenerativeAI = null;
try { GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI; } catch(e) {
  logger.warn('Modulo @google/generative-ai non installato. Esegui: npm install @google/generative-ai');
}

var gemini = null;
var geminiModel = null;
var geminiBreaker = createCircuitBreaker('gemini', { failureThreshold: 3, cooldownMs: 20000 });

if (GoogleGenerativeAI && process.env.GEMINI_API_KEY) {
  gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  geminiModel = gemini.getGenerativeModel({ model: 'gemini-2.0-flash' });
  logger.info('Gemini configurato (gemini-2.0-flash)');
} else if (!process.env.GEMINI_API_KEY) {
  logger.warn('GEMINI_API_KEY non presente. Funzioni Gemini disabilitate.');
}

// ─── askGemini ─────────────────────────────────────────────────────────────────

async function askGemini(prompt, systemInstruction) {
  if (!geminiModel) return { error: 'Gemini non configurato. Aggiungi GEMINI_API_KEY al .env.' };
  try {
    var model = systemInstruction
      ? gemini.getGenerativeModel({ model: 'gemini-2.0-flash', systemInstruction: systemInstruction })
      : geminiModel;
    var result = await geminiBreaker.exec(function() { return model.generateContent(prompt); });
    return { response: result.response.text() };
  } catch(e) {
    logger.error('Errore Gemini:', e.message);
    return { error: 'Errore Gemini: ' + e.message };
  }
}

// ─── fetchNewsMarketing ────────────────────────────────────────────────────────

var _newsCache = { date: null, testo: null };

async function fetchNewsMarketing() {
  var oggi = new Date().toISOString().slice(0, 10);
  if (_newsCache.date === oggi && _newsCache.testo) return _newsCache.testo;

  try {
    if (!gemini) return null;
    var newsModel = gemini.getGenerativeModel({
      model: 'gemini-2.0-flash',
      tools: [{ googleSearch: {} }],
    });
    var result = await geminiBreaker.exec(function() { return newsModel.generateContent(
      'Dammi le 4 notizie più rilevanti di oggi nel mondo del marketing digitale, comunicazione, social media e advertising. ' +
      'Per ognuna: titolo breve, fonte e link. ' +
      'Rispondi SOLO con un elenco nel formato:\n' +
      '• *Titolo* — Fonte — <URL|Leggi>\n' +
      'Niente introduzioni, niente commenti. Solo le 4 notizie.'
    ); });
    var testo = result.response.text().trim();
    if (testo) {
      _newsCache = { date: oggi, testo: testo };
      return testo;
    }
  } catch(e) {
    logger.error('[NEWS] Errore Gemini news:', e.message);
  }
  return null;
}

// ─── callGeminiWithSearch ─────────────────────────────────────────────────────

async function callGeminiWithSearch(prompt, options) {
  if (!gemini) return { text: '', sources: [], error: 'Gemini non configurato.' };
  options = options || {};
  try {
    var searchModel = gemini.getGenerativeModel({
      model: 'gemini-2.0-flash',
      tools: [{ googleSearch: {} }],
    });
    var result = await geminiBreaker.exec(function() { return searchModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: options.maxTokens || 1024,
        temperature: options.temperature || 0.3,
      },
    }); });
    var text = result.response.text();
    var sources = [];
    try {
      var cand = result.response.candidates && result.response.candidates[0];
      if (cand && cand.groundingMetadata && cand.groundingMetadata.webSearchQueries) {
        sources = cand.groundingMetadata.webSearchQueries;
      }
    } catch(e) {
      logger.debug('[GEMINI] grounding metadata non disponibile:', e.message);
    }
    return { text: text, sources: sources };
  } catch(e) {
    logger.error('[GEMINI-SEARCH] Errore:', e.message);
    return { text: '', sources: [], error: e.message };
  }
}

module.exports = {
  gemini: gemini,
  geminiModel: geminiModel,
  askGemini: askGemini,
  callGeminiWithSearch: callGeminiWithSearch,
  fetchNewsMarketing: fetchNewsMarketing,
  getGeminiBreakerStatus: function() { return geminiBreaker.status(); },
};
