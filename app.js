(function () {
  'use strict';

  var ICON_BASE = 'https://pey-sjitech.github.io/CalLink-Studio/icons/';
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    title: $('evTitle'), start: $('evStart'), end: $('evEnd'), tz: $('evTz'), tzField: $('tzField'),
    allDay: $('evAllDay'), repeat: $('evRepeat'), times: $('evTimes'), timesField: $('timesField'),
    reminder: $('evReminder'), extra: $('evExtra'),
    loc: $('evLoc'), desc: $('evDesc'), count: $('charCount'),
    pvTitle: $('pvTitle'), pvWhen: $('pvWhen'), pvWhere: $('pvWhere'),
    google: $('btnGoogle'), outlook: $('btnOutlook'), office: $('btnOffice'), yahoo: $('btnYahoo'), ical: $('btnIcal'),
    status: $('status'), copyBtns: $('copyBtns'), copyHtml: $('copyHtml'), htmlOut: $('htmlOut'),
    toast: $('toast')
  };
  var allButtons = [el.google, el.outlook, el.office, el.yahoo, el.ical];

  var state = { ready: false, links: {}, ics: '', blobUrl: '' };
  var durationMs = 60 * 60000;

  // ─── Input hygiene ───
  function clean(s, keepNewlines) {
    var re = keepNewlines ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
    return String(s).replace(re, ' ').trim();
  }

  // Only http(s) URLs are ever turned into links.
  function safeUrl(s) {
    try {
      var u = new URL(s);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
    } catch (e) { return ''; }
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Dates and time zones ───
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function offsetMs(ms, tz) {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(ms));
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    return Date.UTC(+o.year, o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - ms;
  }

  // Treat a datetime-local value as wall-clock time in tz; return UTC ms.
  function wallToUtc(str, tz) {
    var m = DT_RE.exec(str || '');
    if (!m) return NaN;
    var asUtc = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
    var guess = asUtc;
    for (var i = 0; i < 2; i++) guess = asUtc - offsetMs(guess, tz);
    return guess;
  }

  function compact(ms) {
    return new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');
  }

  function toLocalValue(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function addWall(str, ms) {
    var m = DT_RE.exec(str);
    if (!m) return str;
    var d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) + ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }

  // All-day helpers: dates are plain YYYY-MM-DD, no time zone involved.
  function dateMs(str) {
    var m = DATE_RE.exec(str || '');
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3]) : NaN;
  }
  function dateStr(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function ymd(str) { return str.replace(/-/g, ''); }
  var DAY = 86400000;

  function populateTimeZones() {
    var zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch (e) { /* older browsers */ }
    if (!zones.length) {
      zones = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto',
        'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo',
        'Australia/Perth', 'Australia/Brisbane', 'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland'];
    }
    var mine = 'UTC';
    try { mine = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { /* keep UTC */ }
    if (zones.indexOf(mine) === -1) zones.unshift(mine);
    if (zones.indexOf('UTC') === -1) zones.unshift('UTC');
    zones.forEach(function (z) {
      var o = document.createElement('option');
      o.value = z; o.textContent = z.replace(/_/g, ' ');
      el.tz.appendChild(o);
    });
    el.tz.value = mine;
  }

  // ─── ICS ───
  function icsEscape(t) {
    return String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function icsFold(line) {
    var out = [];
    while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
    out.push(line);
    return out.join('\r\n');
  }
  function reminderTrigger(min) {
    if (min % 1440 === 0) return '-P' + (min / 1440) + 'D';
    if (min % 60 === 0) return '-PT' + (min / 60) + 'H';
    return '-PT' + min + 'M';
  }

  // ─── Options ───
  function repeatRule() {
    var f = el.repeat.value;
    if (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].indexOf(f) === -1) return '';
    var n = parseInt(el.times.value, 10);
    return 'FREQ=' + f + (n >= 1 && n <= 365 ? ';COUNT=' + n : '');
  }
  function reminderMinutes() {
    var n = parseInt(el.reminder.value, 10);
    return [10, 60, 1440].indexOf(n) === -1 ? 0 : n;
  }

  function setAllDay(on) {
    var s = el.start.value, e = el.end.value;
    el.start.type = on ? 'date' : 'datetime-local';
    el.end.type = on ? 'date' : 'datetime-local';
    if (on) {
      el.start.value = s.slice(0, 10);
      el.end.value = (e.slice(0, 10) >= s.slice(0, 10)) ? e.slice(0, 10) : s.slice(0, 10);
    } else {
      el.start.value = (s.slice(0, 10) || toLocalValue(new Date()).slice(0, 10)) + 'T09:00';
      el.end.value = addWall(el.start.value, durationMs);
    }
    el.tzField.hidden = on;
  }

  // ─── Rendering ───
  function setDisabled(a, off) {
    if (off) { a.setAttribute('aria-disabled', 'true'); a.tabIndex = -1; }
    else { a.removeAttribute('aria-disabled'); a.removeAttribute('tabindex'); }
  }

  function update() {
    var allDay = el.allDay.checked;
    var title = clean(el.title.value) || 'Scheduled Appointment';
    var loc = clean(el.loc.value);
    var desc = clean(el.desc.value, true);
    var tz = el.tz.value;
    var rule = repeatRule();
    var remind = reminderMinutes();
    var extra = el.extra.checked;

    el.count.textContent = el.desc.value.length + ' / 500';
    el.timesField.hidden = !el.repeat.value;
    el.office.hidden = !extra;
    el.yahoo.hidden = !extra;

    var s, e, problem = '';
    if (allDay) {
      s = dateMs(el.start.value); e = dateMs(el.end.value);
      if (isNaN(s) || isNaN(e)) problem = 'Choose a start and end date.';
      else if (e < s) problem = 'The end date cannot be before the start date.';
    } else {
      s = wallToUtc(el.start.value, tz); e = wallToUtc(el.end.value, tz);
      if (isNaN(s) || isNaN(e)) problem = 'Choose a start and end time.';
      else if (e <= s) problem = 'The end time must be after the start time.';
    }
    el.end.setAttribute('aria-invalid', problem ? 'true' : 'false');
    el.status.textContent = problem;

    state.ready = !problem;
    el.copyBtns.disabled = !state.ready;
    el.copyHtml.disabled = !state.ready;
    allButtons.forEach(function (a) { setDisabled(a, !state.ready); });

    el.pvTitle.textContent = title;
    el.pvWhen.textContent = '';
    el.pvWhere.textContent = '';
    if (!state.ready) { el.htmlOut.textContent = ''; return; }

    var when;
    if (allDay) {
      var f = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
      when = new Date(s).toLocaleDateString(undefined, f);
      if (e > s) when += ' to ' + new Date(e).toLocaleDateString(undefined, f);
      when += ' (all day)';
    } else {
      when = new Date(el.start.value + ':00Z').toLocaleString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC'
      }) + ' (' + tz.replace(/_/g, ' ') + ')';
    }
    if (rule) when += ', repeats ' + el.repeat.options[el.repeat.selectedIndex].text.toLowerCase();
    el.pvWhen.textContent = when;

    var url = safeUrl(loc);
    if (url) {
      var a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = loc;
      el.pvWhere.appendChild(a);
    } else if (loc) {
      el.pvWhere.textContent = loc;
    }

    // Build the provider values
    var gDates, oStart, oEnd, yStart, yEnd, us, ue;
    if (allDay) {
      var endExcl = e + DAY;                       // iCal/Google: end date is exclusive
      gDates = ymd(dateStr(s)) + '/' + ymd(dateStr(endExcl));
      oStart = dateStr(s); oEnd = dateStr(e);       // Outlook: date-only, flagged all-day
      yStart = ymd(dateStr(s));
      us = ymd(dateStr(s)); ue = ymd(dateStr(endExcl));
    } else {
      us = compact(s); ue = compact(e);
      gDates = us + '/' + ue;
      oStart = new Date(s).toISOString(); oEnd = new Date(e).toISOString();
      yStart = us; yEnd = ue;
    }

    var L = state.links;
    var gp = { action: 'TEMPLATE', text: title, dates: gDates, details: desc, location: loc };
    if (!allDay) gp.ctz = tz;
    if (rule) gp.recur = 'RRULE:' + rule;
    L.google = 'https://calendar.google.com/calendar/render?' + new URLSearchParams(gp);

    var op = { path: '/calendar/action/compose', rru: 'addevent', subject: title, startdt: oStart, enddt: oEnd, body: desc, location: loc };
    if (allDay) op.allday = 'true';
    var opq = new URLSearchParams(op);
    L.outlook = 'https://outlook.live.com/calendar/0/deeplink/compose?' + opq;
    L.office365 = 'https://outlook.office.com/calendar/0/deeplink/compose?' + opq;

    var yp = { v: '60', title: title, st: yStart, desc: desc, in_loc: loc };
    if (allDay) yp.dur = 'allday'; else yp.et = yEnd;
    L.yahoo = 'https://calendar.yahoo.com/?' + new URLSearchParams(yp);

    var lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CalLink Studio//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + us + '-' + ue + '@callink.studio',
      'DTSTAMP:' + compact(Date.now()),
      'SUMMARY:' + icsEscape(title),
      'DESCRIPTION:' + icsEscape(desc),
      'LOCATION:' + icsEscape(loc),
      allDay ? 'DTSTART;VALUE=DATE:' + us : 'DTSTART:' + us,
      allDay ? 'DTEND;VALUE=DATE:' + ue : 'DTEND:' + ue
    ];
    if (rule) lines.push('RRULE:' + rule);
    lines.push('STATUS:CONFIRMED');
    if (remind) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape(title), 'TRIGGER:' + reminderTrigger(remind), 'END:VALARM');
    lines.push('END:VEVENT', 'END:VCALENDAR');
    state.ics = lines.map(icsFold).join('\r\n');

    el.google.href = L.google;
    el.outlook.href = L.outlook;
    el.office.href = L.office365;
    el.yahoo.href = L.yahoo;
    if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
    state.blobUrl = URL.createObjectURL(new Blob([state.ics], { type: 'text/calendar;charset=utf-8' }));
    el.ical.href = state.blobUrl;

    el.htmlOut.textContent = buildEmailHtml(true);
  }

  // ─── Email-safe HTML ───
  // Inline styles + hosted PNG icons only (Gmail/Outlook strip classes, <style> and SVG).
  // Inline-block links wrap on their own, so the buttons fit narrow screens.
  function emailItems() {
    var blank = ' target="_blank" rel="noopener noreferrer"';
    var items = [
      { label: 'Google', icon: 'google', href: state.links.google, extra: blank },
      { label: 'Outlook', icon: 'outlook', href: state.links.outlook, extra: blank }
    ];
    if (el.extra.checked) {
      items.push({ label: 'Office 365', icon: 'office365', href: state.links.office365, extra: blank });
      items.push({ label: 'Yahoo', icon: 'yahoo', href: state.links.yahoo, extra: blank });
    }
    items.push({ label: 'iCal (Apple)', icon: 'ical', href: 'data:text/calendar;charset=utf-8,' + encodeURIComponent(state.ics), extra: ' download="event.ics"' });
    return items;
  }

  function buildEmailHtml(withComment) {
    var style = 'display:inline-block;margin:0 8px 8px 0;border:1px solid #d1d5db;border-radius:8px;padding:9px 14px;' +
      'text-decoration:none;color:#1f2937;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;background-color:#ffffff;';
    var links = emailItems().map(function (i) {
      return '  <a href="' + escHtml(i.href) + '"' + i.extra + ' style="' + style + '">' +
        '<img src="' + ICON_BASE + i.icon + '.png" width="18" height="18" alt="" style="display:inline-block;vertical-align:middle;border:0;width:18px;height:18px;">' +
        '&nbsp;<span style="vertical-align:middle;">' + escHtml(i.label) + '</span></a>';
    }).join('\n');
    return (withComment ? '<!-- Add to Calendar buttons - CalLink Studio -->\n' : '') +
      '<p style="font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#1f2937;margin:0 0 10px 0;">Add to Calendar</p>\n' +
      '<div>\n' + links + '\n</div>';
  }

  // ─── Clipboard + toast ───
  var toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 3200);
  }

  function legacyCopy(node) {
    var ok = false;
    try {
      var r = document.createRange(); r.selectNodeContents(node);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      ok = document.execCommand('copy'); sel.removeAllRanges();
    } catch (e) { ok = false; }
    return ok;
  }

  function copyButtons() {
    if (!state.ready) return;
    var html = buildEmailHtml(false);
    var plain = 'Add to Calendar\n' + emailItems().filter(function (i) { return i.icon !== 'ical'; })
      .map(function (i) { return i.label + ': ' + i.href; }).join('\n');
    var done = function () { toast('Copied. Paste into your email now.'); };
    var fallback = function () {
      var host = document.createElement('div');
      host.innerHTML = html; // built only from escaped values above
      host.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(host);
      var ok = legacyCopy(host);
      document.body.removeChild(host);
      if (ok) done(); else toast('Copy failed. Use "View HTML code" instead.');
    };
    if (navigator.clipboard && window.ClipboardItem) {
      navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' })
      })]).then(done, fallback);
    } else fallback();
  }

  function copyCode() {
    if (!state.ready) return;
    var text = buildEmailHtml(true);
    var done = function () { toast('HTML code copied.'); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) done(); else toast('Copy failed. Select the code and copy it manually.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  // ─── Guide popup ───
  var STEPS = [
    ['Enter your event', 'Add a title, the start and end, and your time zone. Tick All-day for whole-day events, or open More options to repeat the event or add a reminder.'],
    ['Check the preview', 'The buttons update as you type. Click Google, Outlook or iCal to test that the event looks right.'],
    ['Copy for your email', 'Press "Copy buttons for email", then paste (Ctrl+V or ⌘V) into Gmail or Outlook. Prefer code? Use "Copy HTML code".'],
    ['Apple Calendar', 'iCal downloads an event file that opens in Apple Calendar. Some email apps block that link, so you can also send the downloaded file as an attachment.']
  ];
  var guide = { dlg: $('guide'), i: 0 };
  var SEEN_KEY = 'callink_guide_seen';

  function renderGuide() {
    var n = STEPS.length, last = guide.i === n - 1;
    $('guideStep').textContent = 'Step ' + (guide.i + 1) + ' of ' + n;
    $('guideTitle').textContent = STEPS[guide.i][0];
    $('guideText').textContent = STEPS[guide.i][1];
    $('guideBack').hidden = guide.i === 0;
    $('guideSkip').hidden = last;
    $('guideNext').textContent = last ? 'Got it' : 'Next';
    var dots = $('guideDots');
    dots.textContent = '';
    for (var k = 0; k < n; k++) {
      var d = document.createElement('span');
      if (k === guide.i) d.className = 'on';
      dots.appendChild(d);
    }
  }
  function openGuide() {
    guide.i = 0; renderGuide();
    if (typeof guide.dlg.showModal === 'function') guide.dlg.showModal();
    else guide.dlg.setAttribute('open', '');
  }
  function closeGuide() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* storage unavailable */ }
    if (typeof guide.dlg.close === 'function') guide.dlg.close();
    else guide.dlg.removeAttribute('open');
  }

  // ─── Wire up ───
  function init() {
    populateTimeZones();

    var d = new Date();
    d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    el.start.value = toLocalValue(d);
    el.end.value = addWall(el.start.value, durationMs);

    el.start.addEventListener('input', function () {
      if (el.allDay.checked) {
        if (el.start.value && (!el.end.value || el.end.value < el.start.value)) el.end.value = el.start.value;
      } else if (el.start.value) {
        el.end.value = addWall(el.start.value, durationMs);
      }
      update();
    });
    el.end.addEventListener('input', function () {
      if (!el.allDay.checked) {
        var diff = wallToUtc(el.end.value, el.tz.value) - wallToUtc(el.start.value, el.tz.value);
        if (diff > 0) durationMs = diff;
      }
      update();
    });
    el.allDay.addEventListener('change', function () { setAllDay(el.allDay.checked); update(); });
    [el.title, el.tz, el.loc, el.desc, el.repeat, el.times, el.reminder, el.extra].forEach(function (n) {
      n.addEventListener('input', update);
      n.addEventListener('change', update);
    });
    $('form').addEventListener('submit', function (ev) { ev.preventDefault(); });

    allButtons.forEach(function (a) {
      a.addEventListener('click', function (ev) { if (!state.ready) ev.preventDefault(); });
    });
    el.copyBtns.addEventListener('click', copyButtons);
    el.copyHtml.addEventListener('click', copyCode);

    $('guideBtn').addEventListener('click', openGuide);
    $('guideSkip').addEventListener('click', closeGuide);
    $('guideBack').addEventListener('click', function () { if (guide.i > 0) { guide.i--; renderGuide(); } });
    $('guideNext').addEventListener('click', function () {
      if (guide.i < STEPS.length - 1) { guide.i++; renderGuide(); } else closeGuide();
    });
    guide.dlg.addEventListener('click', function (ev) { if (ev.target === guide.dlg) closeGuide(); });
    guide.dlg.addEventListener('cancel', function () {
      try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ }
    });

    update();

    var seen = false;
    try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { /* treat as unseen */ }
    if (!seen) openGuide();
  }

  init();
})();
