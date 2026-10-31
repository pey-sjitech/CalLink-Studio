(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var MAX_ROWS = 200, CHUNK = 25, DAY = 86400000;
  var URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[A-Za-z0-9.-]+\/|macros\/)s\/[A-Za-z0-9_-]+\/exec$/;
  var EMAIL_RE = /^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]{2,}$/;
  var SETTINGS_KEY = 'callink_reminder_settings';
  var SEEN_KEY = 'callink_reminders_guide_seen';

  var el = {
    url: $('setUrl'), secret: $('setSecret'), clinic: $('setClinic'), contact: $('setContact'), location: $('setLocation'),
    test: $('testBtn'), conn: $('connStatus'),
    file: $('file'), paste: $('paste'), load: $('loadBtn'), clear: $('clearBtn'), template: $('templateBtn'),
    review: $('reviewCard'), summary: $('summary'), tbody: $('tbody'), send: $('sendBtn'), toast: $('toast')
  };
  var rows = [];       // { name, email, date, time, location, status, detail, week, day }
  var busy = false;

  // ─── Helpers ───
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
  function ms(date) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date); return m ? Date.UTC(+m[1], m[2] - 1, +m[3]) : NaN; }
  function iso(t) { var d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function todayMs() { var d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
  function nice(date) {
    return new Date(ms(date)).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  function niceTime(time) {
    var p = time.split(':'), h = +p[0];
    return (h % 12 || 12) + ':' + p[1] + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  var toastTimer;
  function toast(msg) {
    el.toast.textContent = msg; el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 3600);
  }
  function setConn(msg, ok) { el.conn.textContent = msg; el.conn.className = 'status ' + (ok ? 'ok' : 'err'); }

  // ─── Settings (never patient data, never the secret) ───
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      el.url.value = s.url || ''; el.clinic.value = s.clinic || '';
      el.contact.value = s.contact || ''; el.location.value = s.location || '';
    } catch (e) { /* storage unavailable */ }
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        url: el.url.value.trim(), clinic: el.clinic.value, contact: el.contact.value, location: el.location.value
      }));
    } catch (e) { /* ignore */ }
  }

  // ─── CSV ───
  function parseCsv(text) {
    text = String(text).replace(/^﻿/, '');
    var first = text.split(/\r?\n/, 1)[0] || '';
    var delim = ',';
    [',', ';', '\t'].forEach(function (d) { if (first.split(d).length > first.split(delim).length) delim = d; });
    var out = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = '';
        if (row.some(function (v) { return v.trim() !== ''; })) out.push(row);
        row = [];
      } else cur += c;
    }
    row.push(cur);
    if (row.some(function (v) { return v.trim() !== ''; })) out.push(row);
    return out;
  }

  var ALIASES = {
    name: ['name', 'patient', 'patient name', 'full name', 'fullname'],
    email: ['email', 'e-mail', 'email address', 'patient email'],
    date: ['date', 'appointment date', 'appt date', 'appointment'],
    time: ['time', 'appointment time', 'appt time', 'start time', 'start'],
    location: ['location', 'address', 'place', 'venue']
  };

  function mapColumns(table) {
    var head = table[0].map(function (h) { return h.trim().toLowerCase(); });
    var idx = {}, found = 0;
    Object.keys(ALIASES).forEach(function (k) {
      var i = head.findIndex(function (h) { return ALIASES[k].indexOf(h) !== -1; });
      if (i !== -1) { idx[k] = i; found++; }
    });
    if (idx.name !== undefined && idx.email !== undefined && idx.date !== undefined) return { idx: idx, skip: 1 };
    // No usable header row: assume name, email, date, time, location
    return { idx: { name: 0, email: 1, date: 2, time: 3, location: 4 }, skip: found ? 1 : 0 };
  }

  function parseDate(s) {
    s = String(s).trim();
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s), y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    else return '';
    var t = Date.UTC(y, mo - 1, d), dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
    return iso(t);
  }

  function parseTime(s) {
    var m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(s).trim());
    if (!m) return '';
    var h = +m[1], min = m[2] ? +m[2] : 0, ap = m[3] && m[3].toLowerCase();
    if (min > 59) return '';
    if (ap) { if (h < 1 || h > 12) return ''; h = (h % 12) + (ap === 'pm' ? 12 : 0); }
    else if (h > 23) return '';
    return pad(h) + ':' + pad(min);
  }

  function buildRows(table) {
    var map = mapColumns(table), out = [], seen = {};
    table.slice(map.skip).forEach(function (r) {
      var get = function (k) { return map.idx[k] === undefined ? '' : (r[map.idx[k]] || ''); };
      var row = {
        name: clean(get('name'), 80), email: String(get('email')).trim().toLowerCase(),
        date: parseDate(get('date')), time: parseTime(get('time')), location: clean(get('location'), 160),
        status: 'ready', detail: '', week: '', day: ''
      };
      var days = Math.round((ms(row.date) - todayMs()) / DAY);
      if (!row.name) { row.status = 'error'; row.detail = 'Name missing'; }
      else if (row.email.length > 254 || !EMAIL_RE.test(row.email)) { row.status = 'error'; row.detail = 'Email not valid'; }
      else if (!row.date) { row.status = 'error'; row.detail = 'Date not valid'; }
      else if (!row.time) { row.status = 'error'; row.detail = 'Time not valid'; }
      else if (days < 0) { row.status = 'error'; row.detail = 'Date is in the past'; }
      else {
        var key = row.email + '|' + row.date + '|' + row.time;
        if (seen[key]) { row.status = 'duplicate'; row.detail = 'Repeated in this file'; }
        seen[key] = true;
        row.week = days > 7 ? 'Week before: ' + nice(iso(ms(row.date) - 7 * DAY)) : 'Week before: skipped (too soon)';
        row.day = days > 1 ? 'Day before: ' + nice(iso(ms(row.date) - DAY)) : 'Day before: skipped (too soon)';
      }
      out.push(row);
    });
    return out;
  }

  // ─── Rendering ───
  function cell(tr, label, node) {
    var td = document.createElement('td');
    td.setAttribute('data-label', label);
    td.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
    tr.appendChild(td);
    return td;
  }
  function line(text, cls) {
    var s = document.createElement('span');
    s.className = cls || 'sub'; s.textContent = text;
    return s;
  }
  function tag(status, detail) {
    var wrap = document.createElement('div');
    var t = document.createElement('span');
    t.className = 'tag ' + status;
    t.textContent = { ready: 'Ready', error: 'Fix', duplicate: 'Duplicate', sent: 'Sent', failed: 'Failed', invalid: 'Rejected' }[status] || status;
    wrap.appendChild(t);
    if (detail) wrap.appendChild(line(detail));
    return wrap;
  }

  function render() {
    el.tbody.textContent = '';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      cell(tr, 'Patient', r.name || '(missing)');
      var e = cell(tr, 'Email', r.email || '(missing)'); e.className = 'em';
      var when = document.createElement('div');
      when.appendChild(document.createTextNode(r.date && r.time ? nice(r.date) + ', ' + niceTime(r.time) : '-'));
      if (r.location) when.appendChild(line(r.location));
      cell(tr, 'Appointment', when);
      var rem = document.createElement('div');
      if (r.week) { rem.appendChild(line(r.week)); rem.appendChild(line(r.day)); } else rem.appendChild(document.createTextNode('-'));
      cell(tr, 'Reminders', rem);
      cell(tr, 'Status', tag(r.status, r.detail));
      el.tbody.appendChild(tr);
    });
    var n = function (s) { return rows.filter(function (r) { return r.status === s; }).length; };
    var parts = [n('ready') + ' ready'];
    ['sent', 'failed', 'invalid', 'error', 'duplicate'].forEach(function (s) {
      if (n(s)) parts.push(n(s) + ' ' + { sent: 'sent', failed: 'failed', invalid: 'rejected', error: 'need fixing', duplicate: 'duplicate' }[s]);
    });
    el.summary.textContent = parts.join(' · ');
    el.review.hidden = !rows.length;
    el.send.disabled = busy || !(n('ready') + n('failed'));
    el.send.textContent = n('sent') ? 'Send remaining' : 'Send confirmations & schedule reminders';
  }

  // ─── Import ───
  function importText(text) {
    if (String(text).length > 1000000) { toast('That file is too large.'); return; }
    var table = parseCsv(text);
    if (!table.length) { toast('No rows found.'); return; }
    rows = buildRows(table);
    if (rows.length > MAX_ROWS) { rows = []; render(); toast('Please import ' + MAX_ROWS + ' rows or fewer at a time.'); return; }
    render();
    el.review.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function downloadTemplate() {
    var d = new Date(todayMs() + 14 * DAY);
    var csv = 'name,email,date,time,location\r\nJane Smith,jane@example.com,' + iso(d.getTime()) + ',09:30,\r\n';
    var a = document.createElement('a');
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.href = url; a.download = 'appointments-template.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ─── Talking to the user's script ───
  function post(payload) {
    return fetch(el.url.value.trim(), {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload),
      redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer'
    }).then(function (res) { return res.json(); });
  }
  function connectionProblem() {
    if (!URL_RE.test(el.url.value.trim())) return 'Enter the web app URL from your script (it ends in /exec).';
    if (el.secret.value.length < 12) return 'Enter your secret key (at least 12 characters).';
    return '';
  }

  function testConnection() {
    var p = connectionProblem();
    if (p) { setConn(p, false); return; }
    saveSettings();
    setConn('Connecting…', true);
    post({ action: 'ping', secret: el.secret.value }).then(function (r) {
      if (r && r.ok) setConn('Connected. Script time zone: ' + r.timeZone + '. Emails left today: ' + r.quotaLeft + '.', true);
      else setConn('The script rejected the secret key.', false);
    }).catch(function () {
      setConn('Could not reach the script. Check the URL, and that access is set to "Anyone".', false);
    });
  }

  function sendAll() {
    var p = connectionProblem();
    if (p) { setConn(p, false); el.url.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    var todo = rows.filter(function (r) { return r.status === 'ready' || r.status === 'failed'; });
    if (!todo.length) return;
    $('confirmCount').textContent = todo.length + (todo.length === 1 ? ' patient' : ' patients');
    openDialog($('confirm'));
  }

  function runSend() {
    saveSettings();
    var todo = rows.filter(function (r) { return r.status === 'ready' || r.status === 'failed'; });
    var settings = { clinic: clean(el.clinic.value, 80), contact: clean(el.contact.value, 160), location: clean(el.location.value, 160) };
    busy = true; render();
    var i = 0;
    (function next() {
      if (i >= todo.length) { busy = false; render(); toast('Finished. See the status column.'); return; }
      var batch = todo.slice(i, i + CHUNK);
      el.summary.textContent = 'Sending ' + Math.min(i + CHUNK, todo.length) + ' of ' + todo.length + '…';
      post({
        action: 'import', secret: el.secret.value, settings: settings,
        appointments: batch.map(function (r) { return { name: r.name, email: r.email, date: r.date, time: r.time, location: r.location }; })
      }).then(function (res) {
        if (!res || !res.ok) {
          batch.forEach(function (r) { r.status = 'failed'; r.detail = (res && res.error) || 'Not sent'; });
          busy = false; render(); toast((res && res.error) || 'The script refused the request.');
          return;
        }
        res.results.forEach(function (x) {
          var r = batch[x.row]; if (!r) return;
          r.status = x.status === 'sent' ? 'sent' : x.status === 'duplicate' ? 'duplicate' : x.status === 'invalid' ? 'invalid' : 'failed';
          r.detail = x.status === 'sent' ? '' : (x.detail || '');
        });
        i += CHUNK; render(); next();
      }).catch(function () {
        batch.forEach(function (r) { r.status = 'failed'; r.detail = 'No response. Check the sheet before retrying.'; });
        busy = false; render(); toast('Lost contact with the script. Check your sheet before sending again.');
      });
    })();
  }

  // ─── Dialogs ───
  function openDialog(d) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); }
  function closeDialog(d) { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); }

  var STEPS = [
    ['Connect your script', 'Set up the Google script once (use "Setup steps"). Then paste its URL and your secret key, and press Test connection.'],
    ['Import appointments', 'Upload a CSV with name, email, date and time, or paste rows. Use the template if you are not sure of the format.'],
    ['Review', 'Check each row. Fix anything marked "Fix". You can see the exact dates the 1-week and 1-day reminders will go out.'],
    ['Send', 'Press Send. Patients get a confirmation straight away, then reminders 1 week and 1 day before. Do not put medical details in the file.']
  ];
  var guide = { dlg: $('guide'), i: 0 };
  function renderGuide() {
    var n = STEPS.length, last = guide.i === n - 1;
    $('guideStep').textContent = 'Step ' + (guide.i + 1) + ' of ' + n;
    $('guideTitle').textContent = STEPS[guide.i][0];
    $('guideText').textContent = STEPS[guide.i][1];
    $('guideBack').hidden = guide.i === 0;
    $('guideSkip').hidden = last;
    $('guideNext').textContent = last ? 'Got it' : 'Next';
    var dots = $('guideDots'); dots.textContent = '';
    for (var k = 0; k < n; k++) { var s = document.createElement('span'); if (k === guide.i) s.className = 'on'; dots.appendChild(s); }
  }
  function openGuide() { guide.i = 0; renderGuide(); openDialog(guide.dlg); }
  function closeGuide() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ }
    closeDialog(guide.dlg);
  }

  function copyScript() {
    fetch('apps-script/Code.gs', { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('missing');
      return r.text();
    }).then(function (t) { return navigator.clipboard.writeText(t); })
      .then(function () { toast('Script copied. Paste it into the Apps Script editor.'); })
      .catch(function () { toast('Could not copy. Open apps-script/Code.gs on the site and copy it from there.'); });
  }

  // ─── Wire up ───
  function init() {
    loadSettings();
    [el.url, el.clinic, el.contact, el.location].forEach(function (n) { n.addEventListener('change', saveSettings); });
    el.test.addEventListener('click', testConnection);
    el.file.addEventListener('change', function () {
      var f = el.file.files && el.file.files[0];
      if (!f) return;
      if (f.size > 1000000) { toast('That file is too large.'); el.file.value = ''; return; }
      f.text().then(importText, function () { toast('Could not read that file.'); });
      el.file.value = '';
    });
    el.load.addEventListener('click', function () { if (el.paste.value.trim()) importText(el.paste.value); else toast('Paste some rows first.'); });
    el.clear.addEventListener('click', function () { rows = []; el.paste.value = ''; busy = false; render(); });
    el.template.addEventListener('click', downloadTemplate);
    el.send.addEventListener('click', sendAll);

    $('confirmNo').addEventListener('click', function () { closeDialog($('confirm')); });
    $('confirmYes').addEventListener('click', function () { closeDialog($('confirm')); runSend(); });
    $('setupBtn').addEventListener('click', function () { openDialog($('setup')); });
    $('setupClose').addEventListener('click', function () { closeDialog($('setup')); });
    $('copyScript').addEventListener('click', copyScript);

    $('guideBtn').addEventListener('click', openGuide);
    $('guideSkip').addEventListener('click', closeGuide);
    $('guideBack').addEventListener('click', function () { if (guide.i > 0) { guide.i--; renderGuide(); } });
    $('guideNext').addEventListener('click', function () { if (guide.i < STEPS.length - 1) { guide.i++; renderGuide(); } else closeGuide(); });
    ['guide', 'confirm', 'setup'].forEach(function (id) {
      var d = $(id);
      d.addEventListener('click', function (ev) { if (ev.target === d) { if (id === 'guide') closeGuide(); else closeDialog(d); } });
    });
    guide.dlg.addEventListener('cancel', function () { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ } });

    render();
    var seen = false;
    try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { /* unseen */ }
    if (!seen) openGuide();
  }

  init();
})();
