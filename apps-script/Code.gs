/**
 * CalLink Studio - Patient Reminders (Google Apps Script)
 *
 * Runs inside YOUR Google account. It receives appointments from the
 * patient-reminders page, emails a confirmation straight away, then sends a
 * reminder 1 week and 1 day before each appointment. Patient data lives only
 * in the "Appointments" sheet of the spreadsheet this script is attached to.
 *
 * Setup: see apps-script/README.md
 */

var CFG = {
  SHEET: 'Appointments',
  HEADERS: ['ID', 'Created', 'Name', 'Email', 'Appointment', 'Clinic', 'Location', 'Contact',
            'Status', 'Confirmation', 'Reminder 1 week', 'Reminder 1 day'],
  RETAIN_DAYS: 30,     // rows are deleted this many days after the appointment
  MAX_BATCH: 200,      // appointments accepted per request
  REMINDER_HOUR: 8     // daily reminder run, in the script's time zone
};
var COL = { ID: 0, CREATED: 1, NAME: 2, EMAIL: 3, APPT: 4, CLINIC: 5, LOCATION: 6, CONTACT: 7,
            STATUS: 8, CONFIRM: 9, WEEK: 10, DAY: 11 };

/* ───────────── Web app entry points ───────────── */

function doGet() {
  return json_({ ok: true, service: 'CalLink Studio reminders' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!secretOk_(body.secret)) return json_({ ok: false, error: 'Not authorised.' });

    if (body.action === 'ping') {
      return json_({ ok: true, timeZone: tz_(), quotaLeft: MailApp.getRemainingDailyQuota() });
    }
    if (body.action === 'import') return json_(importAppointments_(body));
    return json_({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    console.error(err && err.stack || err);          // detail stays in Apps Script logs only
    return json_({ ok: false, error: 'Request failed.' });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* not held */ }
  }
}

/* ───────────── Import + confirmation ───────────── */

function importAppointments_(body) {
  var list = Array.isArray(body.appointments) ? body.appointments : [];
  if (!list.length) return { ok: false, error: 'No appointments received.' };
  if (list.length > CFG.MAX_BATCH) return { ok: false, error: 'Too many at once (max ' + CFG.MAX_BATCH + ').' };

  var settings = body.settings || {};
  var sheet = sheet_();
  var existing = {};
  sheet.getDataRange().getValues().slice(1).forEach(function (r) {
    existing[key_(r[COL.EMAIL], r[COL.APPT])] = true;
  });

  var needed = list.length;
  var quota = MailApp.getRemainingDailyQuota();
  var results = [];

  list.forEach(function (a, i) {
    var v = validate_(a);
    if (v.error) { results.push({ row: i, status: 'invalid', detail: v.error }); return; }
    var appt = v.value;
    if (existing[key_(appt.email, appt.when)]) { results.push({ row: i, status: 'duplicate', detail: 'Already scheduled.' }); return; }
    if (quota < 1) { results.push({ row: i, status: 'failed', detail: 'Daily email limit reached.' }); return; }

    var item = {
      name: appt.name, email: appt.email, when: appt.when,
      clinic: clean_(settings.clinic, 80) || 'Our clinic',
      location: appt.location || clean_(settings.location, 160),
      contact: clean_(settings.contact, 160)
    };
    var days = daysUntil_(item.when);
    var id = Utilities.getUuid();
    var now = stamp_(new Date());

    var sent = false, detail = '';
    try { sendEmail_('confirm', item); sent = true; quota--; }
    catch (err) { console.error(err && err.stack || err); detail = 'Email could not be sent.'; }

    sheet.appendRow([
      id, now, cell_(item.name), item.email, item.when, cell_(item.clinic), cell_(item.location), cell_(item.contact),
      sent ? 'ACTIVE' : 'FAILED',
      sent ? now : 'FAILED',
      days <= 7 ? 'skipped' : '',     // too close for a 1-week reminder
      days <= 1 ? 'skipped' : ''      // too close for a 1-day reminder
    ]);
    existing[key_(item.email, item.when)] = true;
    results.push({ row: i, status: sent ? 'sent' : 'failed', detail: detail });
  });

  ensureTrigger_();
  return { ok: true, results: results, requested: needed };
}

/* ───────────── Daily reminders ───────────── */

function dailyReminders() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = sheet_();
    var values = sheet.getDataRange().getValues();
    var toDelete = [];

    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      if (!row[COL.EMAIL]) continue;
      var when = textWhen_(row[COL.APPT]);
      var days = daysUntil_(when);

      if (days < -CFG.RETAIN_DAYS) { toDelete.push(r + 1); continue; }
      if (String(row[COL.STATUS]).toUpperCase() !== 'ACTIVE') continue;

      var item = { name: String(row[COL.NAME]), email: String(row[COL.EMAIL]), when: when,
                   clinic: String(row[COL.CLINIC]), location: String(row[COL.LOCATION]), contact: String(row[COL.CONTACT]) };

      if (!row[COL.WEEK] && days >= 2 && days <= 7) {
        markSent_(sheet, r + 1, COL.WEEK, function () { sendEmail_('week', item); });
      }
      if (!row[COL.DAY] && days === 1) {
        markSent_(sheet, r + 1, COL.DAY, function () { sendEmail_('day', item); });
      }
    }
    toDelete.reverse().forEach(function (n) { sheet.deleteRow(n); });
  } finally {
    lock.releaseLock();
  }
}

function markSent_(sheet, rowNumber, col, fn) {
  try { fn(); sheet.getRange(rowNumber, col + 1).setValue(stamp_(new Date())); }
  catch (err) { console.error(err && err.stack || err); sheet.getRange(rowNumber, col + 1).setValue('FAILED'); }
}

/** Run once after pasting the script (also done automatically on first import). */
function installTrigger() { ensureTrigger_(); }

function ensureTrigger_() {
  var have = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'dailyReminders'; });
  if (!have) ScriptApp.newTrigger('dailyReminders').timeBased().everyDays(1).atHour(CFG.REMINDER_HOUR).create();
}

/* ───────────── Emails ───────────── */

function sendEmail_(kind, a) {
  var m = buildEmail_(kind, a);
  var opts = { name: a.clinic, htmlBody: m.html };
  if (kind === 'confirm') opts.attachments = [Utilities.newBlob(m.ics, 'text/calendar', 'appointment.ics')];
  MailApp.sendEmail(a.email, m.subject, m.text, opts);
}

function buildEmail_(kind, a) {
  var tz = tz_();
  var d = Utilities.parseDate(a.when, tz, 'yyyy-MM-dd HH:mm');
  var dateStr = Utilities.formatDate(d, tz, 'EEEE d MMMM yyyy');
  var timeStr = Utilities.formatDate(d, tz, 'h:mm a');
  var first = a.name.split(' ')[0];

  var subject, lead;
  if (kind === 'confirm') { subject = 'Appointment confirmed: ' + dateStr + ', ' + timeStr; lead = 'Your appointment has been booked.'; }
  else if (kind === 'week') { subject = 'Reminder: your appointment is in 1 week'; lead = 'This is a reminder that your appointment is in one week.'; }
  else { subject = 'Reminder: your appointment is tomorrow'; lead = 'This is a reminder that your appointment is tomorrow.'; }

  var lines = [
    'Hello ' + first + ',', '',
    lead, '',
    'When: ' + dateStr + ' at ' + timeStr,
    'Where: ' + (a.location || a.clinic)
  ];
  if (a.contact) lines.push('', 'To change or cancel, please contact: ' + a.contact);
  lines.push('', 'This is an automated message. Please do not reply with medical details.');
  var text = lines.join('\n');

  var end = new Date(d.getTime() + 60 * 60000);
  var gUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + enc_('Appointment - ' + a.clinic) +
    '&dates=' + utc_(d) + '/' + utc_(end) + '&location=' + enc_(a.location || a.clinic);
  var oUrl = 'https://outlook.live.com/calendar/0/deeplink/compose?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent&subject=' +
    enc_('Appointment - ' + a.clinic) + '&startdt=' + enc_(d.toISOString()) + '&enddt=' + enc_(end.toISOString()) +
    '&location=' + enc_(a.location || a.clinic);

  var btn = 'display:inline-block;margin:0 8px 8px 0;border:1px solid #d1d5db;border-radius:8px;padding:9px 14px;' +
            'text-decoration:none;color:#1f2937;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;background-color:#ffffff;';
  var html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.5;">' +
    '<p>Hello ' + esc_(first) + ',</p><p>' + esc_(lead) + '</p>' +
    '<p><strong>When:</strong> ' + esc_(dateStr) + ' at ' + esc_(timeStr) + '<br>' +
    '<strong>Where:</strong> ' + esc_(a.location || a.clinic) + '</p>' +
    (kind === 'confirm' ?
      '<p style="margin:16px 0 8px 0;font-weight:bold;">Add to your calendar</p><div>' +
      '<a href="' + esc_(gUrl) + '" style="' + btn + '">Google</a>' +
      '<a href="' + esc_(oUrl) + '" style="' + btn + '">Outlook</a>' +
      '<span style="' + btn.replace('text-decoration:none;', '') + 'color:#6b7280;">iCal: open the attached file</span></div>' : '') +
    (a.contact ? '<p>To change or cancel, please contact: ' + esc_(a.contact) + '</p>' : '') +
    '<p style="color:#6b7280;font-size:13px;">This is an automated message. Please do not reply with medical details.</p></div>';

  var ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CalLink Studio//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    'UID:' + utc_(d) + '-' + a.email.replace(/[^A-Za-z0-9]/g, '') + '@callink.studio',
    'DTSTAMP:' + utc_(new Date()), 'SUMMARY:' + icsEsc_('Appointment - ' + a.clinic),
    'LOCATION:' + icsEsc_(a.location || a.clinic), 'DTSTART:' + utc_(d), 'DTEND:' + utc_(end),
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Appointment reminder', 'TRIGGER:-P1D', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

  return { subject: subject, text: text, html: html, ics: ics };
}

/* ───────────── Validation and helpers ───────────── */

function validate_(a) {
  a = a || {};
  var name = clean_(a.name, 80);
  var email = String(a.email || '').trim().toLowerCase();
  var date = String(a.date || '').trim(), time = String(a.time || '').trim();
  if (!name) return { error: 'Name is missing.' };
  if (email.length > 254 || !/^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]{2,}$/.test(email)) return { error: 'Email is not valid.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return { error: 'Date or time is not valid.' };
  var chk = new Date(date + 'T' + time + ':00Z');
  if (isNaN(chk) || chk.toISOString().slice(0, 16) !== date + 'T' + time) return { error: 'Date or time is not valid.' };
  var when = date + ' ' + time;
  if (daysUntil_(when) < 0) return { error: 'Appointment is in the past.' };
  return { value: { name: name, email: email, when: when, location: clean_(a.location, 160) } };
}

function clean_(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
/** Stop spreadsheet formula injection: text starting with = + - @ is stored as plain text. */
function cell_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function enc_(s) { return encodeURIComponent(s); }
function icsEsc_(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,'); }
function utc_(d) { return d.toISOString().replace(/[-:]|\.\d{3}/g, ''); }
function tz_() { return Session.getScriptTimeZone(); }
function stamp_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd HH:mm'); }
function key_(email, when) { return String(email).toLowerCase() + '|' + textWhen_(when); }

/** Sheet cells may come back as Date objects; normalise to 'yyyy-MM-dd HH:mm'. */
function textWhen_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' ? Utilities.formatDate(v, tz_(), 'yyyy-MM-dd HH:mm') : String(v);
}

/** Whole calendar days from today to the appointment date, in the script time zone. */
function daysUntil_(when) {
  var today = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
  var a = today.split('-'), b = String(when).slice(0, 10).split('-');
  return Math.round((Date.UTC(+b[0], b[1] - 1, +b[2]) - Date.UTC(+a[0], a[1] - 1, +a[2])) / 86400000);
}

function secretOk_(given) {
  var secret = PropertiesService.getScriptProperties().getProperty('SECRET') || '';
  given = String(given || '');
  if (secret.length < 12) return false;               // refuse to run without a strong secret
  var diff = secret.length ^ given.length;
  for (var i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  return diff === 0;
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CFG.SHEET);
  if (!sh) {
    sh = ss.insertSheet(CFG.SHEET);
    sh.appendRow(CFG.HEADERS);
    sh.setFrozenRows(1);
    sh.getRange('E:E').setNumberFormat('@');           // keep appointment as text
  }
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
