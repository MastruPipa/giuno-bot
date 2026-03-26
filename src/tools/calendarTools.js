// ─── Calendar Tools ────────────────────────────────────────────────────────────
// list_events, find_event, create_event, update_event, add_attendees,
// delete_event, find_free_slots

'use strict';

var { withTimeout } = require('../utils/timeout');
var { getCalendarPerUtente, handleTokenScaduto } = require('../services/googleAuthService');

// ─── Event mapper ──────────────────────────────────────────────────────────────

function mapEvent(e) {
  return {
    id: e.id,
    title: e.summary,
    start: e.start.dateTime || e.start.date,
    end: e.end.dateTime || e.end.date,
    location: e.location || null,
    attendees: (e.attendees || []).map(function(a) { return a.email; }),
  };
}

// ─── Tool definitions ──────────────────────────────────────────────────────────

var definitions = [
  {
    name: 'list_events',
    description: 'Elenca gli eventi del calendario nei prossimi N giorni.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Giorni da oggi (default 7)' },
      },
    },
  },
  {
    name: 'find_event',
    description: 'Cerca eventi nel calendario per titolo o intervallo di date. Usalo prima di update/delete per trovare l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        query:     { type: 'string', description: 'Testo nel titolo (opzionale)' },
        date_from: { type: 'string', description: 'Inizio ricerca ISO 8601 (opzionale)' },
        date_to:   { type: 'string', description: 'Fine ricerca ISO 8601 (opzionale)' },
      },
    },
  },
  {
    name: 'create_event',
    description: 'Crea un nuovo evento nel calendario. Date in ISO 8601 con timezone (es. 2025-03-25T10:00:00+01:00).',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Titolo' },
        start:       { type: 'string', description: 'Inizio ISO 8601' },
        end:         { type: 'string', description: 'Fine ISO 8601' },
        description: { type: 'string', description: 'Descrizione (opzionale)' },
        location:    { type: 'string', description: 'Luogo (opzionale)' },
        attendees:   { type: 'array', items: { type: 'string' }, description: 'Email invitati (opzionale)' },
        force:       { type: 'boolean', description: 'Se true, crea anche se ci sono conflitti di orario' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'update_event',
    description: 'Modifica titolo, orario, luogo o descrizione di un evento. Usa find_event prima per l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:    { type: 'string', description: 'ID evento' },
        title:       { type: 'string', description: 'Nuovo titolo (opzionale)' },
        start:       { type: 'string', description: 'Nuovo inizio ISO 8601 (opzionale)' },
        end:         { type: 'string', description: 'Nuova fine ISO 8601 (opzionale)' },
        description: { type: 'string', description: 'Nuova descrizione (opzionale)' },
        location:    { type: 'string', description: 'Nuovo luogo (opzionale)' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'add_attendees',
    description: 'Aggiunge invitati a un evento e manda notifiche email.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:  { type: 'string', description: 'ID evento' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email da aggiungere' },
      },
      required: ['event_id', 'attendees'],
    },
  },
  {
    name: 'delete_event',
    description: 'Elimina un evento. Usa find_event prima per l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'ID evento da eliminare' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'find_free_slots',
    description: 'Trova slot liberi comuni per più persone usando la FreeBusy API.',
    input_schema: {
      type: 'object',
      properties: {
        emails:    { type: 'array', items: { type: 'string' }, description: 'Email delle persone da controllare' },
        date_from: { type: 'string', description: 'Inizio ricerca ISO 8601' },
        date_to:   { type: 'string', description: 'Fine ricerca ISO 8601' },
        duration:  { type: 'number', description: 'Durata slot in minuti (default 60)' },
      },
      required: ['emails', 'date_from', 'date_to'],
    },
  },
];

// ─── Tool execution ────────────────────────────────────────────────────────────

async function execute(toolName, input, userId) {
  var cal = getCalendarPerUtente(userId);
  if (!cal) return { error: 'Google Calendar non collegato. Scrivi "collega il mio Google".' };

  try {
    if (toolName === 'list_events') {
      var giorni = input.days || 7;
      var now = new Date();
      var fine = new Date();
      fine.setDate(fine.getDate() + giorni);
      var res = await withTimeout(
        cal.events.list({ calendarId: 'primary', timeMin: now.toISOString(), timeMax: fine.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 15 }),
        8000, 'list_events'
      );
      return { events: (res.data.items || []).map(mapEvent) };
    }

    if (toolName === 'find_event') {
      var from = input.date_from ? new Date(input.date_from) : new Date();
      var to   = input.date_to   ? new Date(input.date_to)   : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      var res  = await withTimeout(
        cal.events.list({ calendarId: 'primary', timeMin: from.toISOString(), timeMax: to.toISOString(), q: input.query || undefined, singleEvents: true, orderBy: 'startTime', maxResults: 10 }),
        8000, 'find_event'
      );
      return { events: (res.data.items || []).map(mapEvent) };
    }

    if (toolName === 'create_event') {
      // Conflict detection
      if (!input.force) {
        var conflictCheck = await withTimeout(
          cal.events.list({ calendarId: 'primary', timeMin: new Date(input.start).toISOString(), timeMax: new Date(input.end).toISOString(), singleEvents: true, maxResults: 5 }),
          8000, 'create_event_conflict_check'
        );
        var conflicts = (conflictCheck.data.items || []).filter(function(e) { return e.status !== 'cancelled'; });
        if (conflicts.length > 0) {
          var titles = conflicts.map(function(e) { return e.summary || 'Senza titolo'; }).join(', ');
          return { conflict: true, message: 'Hai già eventi in questo orario (' + titles + '). Usa force:true per creare comunque.', conflicting_events: conflicts.map(mapEvent) };
        }
      }

      var event = {
        summary: input.title,
        start: { dateTime: input.start, timeZone: 'Europe/Rome' },
        end:   { dateTime: input.end,   timeZone: 'Europe/Rome' },
        conferenceData: { createRequest: { requestId: 'giuno-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      };
      if (input.description) event.description = input.description;
      if (input.location)    event.location    = input.location;
      if (input.attendees && input.attendees.length > 0) {
        event.attendees = input.attendees.map(function(e) { return { email: e }; });
      }
      var res = await withTimeout(
        cal.events.insert({ calendarId: 'primary', requestBody: event, conferenceDataVersion: 1, sendUpdates: (input.attendees && input.attendees.length > 0) ? 'all' : 'none' }),
        8000, 'create_event'
      );
      var entryPoints = res.data.conferenceData && res.data.conferenceData.entryPoints;
      var meetLink = entryPoints && entryPoints[0] ? entryPoints[0].uri : null;
      return { success: true, event_id: res.data.id, link: res.data.htmlLink, meet_link: meetLink };
    }

    if (toolName === 'update_event') {
      var existing = await cal.events.get({ calendarId: 'primary', eventId: input.event_id });
      var event = existing.data;
      if (input.title)                   event.summary     = input.title;
      if (input.start)                   event.start       = { dateTime: input.start, timeZone: 'Europe/Rome' };
      if (input.end)                     event.end         = { dateTime: input.end,   timeZone: 'Europe/Rome' };
      if (input.description !== undefined) event.description = input.description;
      if (input.location    !== undefined) event.location    = input.location;
      await cal.events.update({ calendarId: 'primary', eventId: input.event_id, requestBody: event, sendUpdates: 'all' });
      return { success: true };
    }

    if (toolName === 'add_attendees') {
      var existing = await cal.events.get({ calendarId: 'primary', eventId: input.event_id });
      var event = existing.data;
      var currentEmails = (event.attendees || []).map(function(a) { return a.email; });
      var nuovi = input.attendees.filter(function(e) { return !currentEmails.includes(e); });
      event.attendees = (event.attendees || []).concat(nuovi.map(function(e) { return { email: e }; }));
      await cal.events.update({ calendarId: 'primary', eventId: input.event_id, requestBody: event, sendUpdates: 'all' });
      return { success: true, added: nuovi };
    }

    if (toolName === 'delete_event') {
      await cal.events.delete({ calendarId: 'primary', eventId: input.event_id });
      return { success: true };
    }

    if (toolName === 'find_free_slots') {
      var duration = (input.duration || 60) * 60 * 1000;
      var res = await cal.freebusy.query({
        requestBody: {
          timeMin: new Date(input.date_from).toISOString(),
          timeMax: new Date(input.date_to).toISOString(),
          timeZone: 'Europe/Rome',
          items: input.emails.map(function(e) { return { id: e }; }),
        },
      });
      var busyByUser = res.data.calendars;
      var allBusy = [];
      input.emails.forEach(function(email) {
        var userCal = busyByUser[email];
        if (userCal && userCal.busy) allBusy.push.apply(allBusy, userCal.busy);
      });
      allBusy.sort(function(a, b) { return new Date(a.start) - new Date(b.start); });
      var slots = [];
      var cursor = new Date(input.date_from);
      var endTime = new Date(input.date_to);
      while (cursor.getTime() + duration <= endTime.getTime() && slots.length < 5) {
        var h = cursor.getHours();
        if (h < 9) { cursor.setHours(9, 0, 0, 0); continue; }
        if (h >= 18) { cursor.setDate(cursor.getDate() + 1); cursor.setHours(9, 0, 0, 0); continue; }
        var slotEnd = new Date(cursor.getTime() + duration);
        var overlap = allBusy.some(function(b) {
          return new Date(b.start) < slotEnd && new Date(b.end) > cursor;
        });
        if (!overlap) {
          slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() });
          cursor = new Date(slotEnd);
        } else {
          var nextBusy = allBusy.find(function(b) { return new Date(b.end) > cursor; });
          if (nextBusy) cursor = new Date(nextBusy.end);
          else break;
        }
      }
      return { free_slots: slots };
    }

  } catch(e) {
    if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto. Utente notificato per riautenticarsi.' };
    return { error: e.message };
  }

  return { error: 'Tool sconosciuto nel modulo calendarTools: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute, mapEvent: mapEvent };
