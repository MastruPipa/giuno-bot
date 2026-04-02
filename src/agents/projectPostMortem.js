// ─── Project Post-Mortem Agent ───────────────────────────────────────────────
// Triggered when a project status changes to "completed".
// Calculates: margin, time accuracy, team effort, and saves as KB case study.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { app } = require('../services/slackService');
var { formatPerSlack } = require('../utils/slackFormat');

async function generatePostMortem(projectId) {
  try {
    var project = await db.getProject(projectId);
    if (!project) return null;

    var allocations = await db.getProjectAllocations(projectId);
    var now = new Date();

    // Calculate metrics
    var budgetQuoted = parseFloat(project.budget_quoted) || 0;
    var budgetActual = parseFloat(project.budget_actual) || 0;
    var margin = budgetQuoted > 0 ? Math.round(((budgetQuoted - budgetActual) / budgetQuoted) * 100) : null;
    var budgetDelta = budgetActual - budgetQuoted;
    var budgetDeltaPct = budgetQuoted > 0 ? Math.round((budgetDelta / budgetQuoted) * 100) : null;

    var totalAllocated = 0, totalLogged = 0;
    allocations.forEach(function(a) {
      totalAllocated += parseFloat(a.hours_allocated) || 0;
      totalLogged += parseFloat(a.hours_logged) || 0;
    });
    var effortAccuracy = totalAllocated > 0 ? Math.round((totalLogged / totalAllocated) * 100) : null;

    var startDate = project.start_date ? new Date(project.start_date) : null;
    var endDate = project.end_date ? new Date(project.end_date) : null;
    var plannedDays = startDate && endDate ? Math.ceil((endDate - startDate) / 86400000) : null;
    var actualDays = startDate ? Math.ceil((now - startDate) / 86400000) : null;
    var timeAccuracy = plannedDays && actualDays ? Math.round((actualDays / plannedDays) * 100) : null;

    // Build report
    var report = [];
    report.push('*📊 Post-Mortem: ' + project.name + '*');
    if (project.client_name) report.push('Cliente: ' + project.client_name);
    if (project.service_category) report.push('Categoria: ' + project.service_category);
    report.push('');

    // Budget
    report.push('*Budget:*');
    if (budgetQuoted > 0) {
      var budgetIcon = Math.abs(budgetDeltaPct) <= 10 ? '🟢' : (Math.abs(budgetDeltaPct) <= 25 ? '🟡' : '🔴');
      report.push(budgetIcon + ' Quotato: €' + Math.round(budgetQuoted) + ' | Effettivo: €' + Math.round(budgetActual) + ' | Delta: ' + (budgetDelta > 0 ? '+' : '') + '€' + Math.round(budgetDelta) + ' (' + (budgetDeltaPct > 0 ? '+' : '') + budgetDeltaPct + '%)');
      if (margin !== null) report.push('Margine: ' + margin + '%');
    } else {
      report.push('⚫ Budget non tracciato');
    }

    // Effort
    report.push('');
    report.push('*Effort:*');
    if (totalAllocated > 0) {
      var effortIcon = Math.abs(effortAccuracy - 100) <= 20 ? '🟢' : (Math.abs(effortAccuracy - 100) <= 40 ? '🟡' : '🔴');
      report.push(effortIcon + ' Stimate: ' + Math.round(totalAllocated) + 'h | Lavorate: ' + Math.round(totalLogged) + 'h (' + effortAccuracy + '%)');
    } else {
      report.push('⚫ Ore non tracciate');
    }

    // Team
    if (allocations.length > 0) {
      report.push('');
      report.push('*Team:*');
      allocations.forEach(function(a) {
        report.push('• <@' + a.slack_user_id + '> (' + (a.role || 'N/A') + '): ' + Math.round(a.hours_logged || 0) + '/' + Math.round(a.hours_allocated || 0) + 'h');
      });
    }

    // Timeline
    report.push('');
    report.push('*Timeline:*');
    if (startDate && endDate) {
      var timeIcon = timeAccuracy <= 110 ? '🟢' : (timeAccuracy <= 130 ? '🟡' : '🔴');
      report.push(timeIcon + ' Pianificato: ' + plannedDays + 'gg | Effettivo: ' + actualDays + 'gg (' + timeAccuracy + '%)');
    } else {
      report.push('⚫ Date non tracciate');
    }

    // Save as KB case study
    var caseStudy = 'CASE STUDY: ' + project.name +
      (project.client_name ? ' (' + project.client_name + ')' : '') +
      ' | Categoria: ' + (project.service_category || 'N/A') +
      ' | Budget: €' + Math.round(budgetQuoted) + '→€' + Math.round(budgetActual) +
      ' | Ore: ' + Math.round(totalAllocated) + 'h→' + Math.round(totalLogged) + 'h' +
      ' | Margine: ' + (margin || 'N/A') + '%' +
      ' | Durata: ' + (actualDays || 'N/A') + 'gg' +
      ' | Team: ' + allocations.length + ' persone';

    var tags = ['case_study', 'post_mortem'];
    if (project.service_category) tags.push('categoria:' + project.service_category);
    if (project.client_name) tags.push('cliente:' + project.client_name.toLowerCase());

    await db.addKBEntry(caseStudy, tags, 'system', {
      confidenceTier: 'official',
      sourceType: 'post_mortem',
    });

    logger.info('[POST-MORTEM] Case study salvato per', project.name);

    // Notify owner
    if (project.owner_slack_id) {
      await app.client.chat.postMessage({
        channel: project.owner_slack_id,
        text: formatPerSlack(report.join('\n')),
        unfurl_links: false,
      });
    }

    return report.join('\n');
  } catch(e) {
    logger.error('[POST-MORTEM] Errore:', e.message);
    return null;
  }
}

module.exports = { generatePostMortem: generatePostMortem };
