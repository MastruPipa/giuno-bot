// ─── Recap scanner helpers ─────────────────────────────────────────────────
// Pure helpers extracted so they can be unit-tested without pulling Google/
// Slack SDKs through the meetingRecapScanner require chain.
'use strict';

// Routine/recurring event titles — the LLM always returns SKIP on these, so we
// skip them earlier and save the API call.
var ROUTINE_TITLE_RX = /stand-?up|daily|sync|check-?in|scrum|weekly|1[:-]1|one.on.one|retrospective|retro|planning|sprint|huddle|coffee|pranzo|lunch|pausa/i;

// The summarizer prompt asks the LLM to reply with "SKIP" when the email/doc
// isn't a real meeting recap, but Haiku often wraps it in markdown
// ("**SKIP**", "_SKIP_", "Skip — il documento ..."). Strip formatting before
// matching so we don't store garbage entries in the KB.
function isSkipResponse(text) {
  if (!text) return true;
  var stripped = text.replace(/[*_`#>\s]+/g, '').toLowerCase();
  return stripped.indexOf('skip') === 0;
}

// O(n) tag scan over the in-memory KB cache. We use this instead of searchKB,
// which does keyword tokenization and never matched our `gmail_id:` /
// `cal_event_id:` synthetic ids.
function alreadySaved(kbCache, tag) {
  if (!kbCache || kbCache.length === 0) return false;
  for (var i = kbCache.length - 1; i >= 0; i--) {
    var t = kbCache[i].tags || [];
    for (var j = 0; j < t.length; j++) if (t[j] === tag) return true;
  }
  return false;
}

var CLIENT_STOPWORDS = ['del','dei','delle','della','alle','per','con','che','una','uno','ks','ed','non','sul','sulle','sulla','tra','fra','noi','voi','loro','call','meeting','sync','sal','recap','daily','weekly'];

// Old regex matched "con|per|x" inside any word, producing tags like
// "cliente:tainer" (from "container"). Require an actual word boundary before
// the preposition + a stopword/length filter on the captured name.
function extractClientTag(title) {
  if (!title) return null;
  var m = title.match(/(?:^|\s)(?:con|per|x|×|@)\s+([A-Za-zÀ-ÿ][\wÀ-ÿ'-]{2,})/i);
  if (!m) return null;
  var name = m[1].toLowerCase();
  if (CLIENT_STOPWORDS.indexOf(name) !== -1) return null;
  if (name.length < 3) return null;
  return 'cliente:' + name;
}

module.exports = {
  ROUTINE_TITLE_RX: ROUTINE_TITLE_RX,
  isSkipResponse: isSkipResponse,
  alreadySaved: alreadySaved,
  extractClientTag: extractClientTag,
};
