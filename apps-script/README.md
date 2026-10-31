# Patient reminders - setup

The page `patient-reminders.html` sends appointment data to a small Google Apps Script that runs in **your own Google account**. The script emails each patient a confirmation straight away, then a reminder **1 week** and **1 day** before the appointment. Patient data is stored only in a Google Sheet you own.

## One-time setup (about 10 minutes)

1. Create a new Google Sheet. Open **Extensions → Apps Script**.
2. Delete the sample code and paste the contents of `Code.gs`. Save.
3. **Project Settings → Time zone:** set your clinic's time zone. **Script Properties:** add `SECRET` with a long random value (12+ characters).
4. **Deploy → New deployment → Web app.** Execute as **Me**, access **Anyone**. Authorise when prompted. Copy the web app URL (ends in `/exec`).
5. On the page, paste the URL and your secret, then press **Test connection**.

The daily reminder job installs itself on the first import (or run `installTrigger` once).

## What gets sent

| When | Email |
|------|-------|
| Right after you import | Confirmation, with Google and Outlook buttons and an `.ics` file attached (works for Apple Calendar) |
| 7 days before | "Your appointment is in 1 week" |
| 1 day before | "Your appointment is tomorrow" |

Appointments closer than 7 days (or 1 day) skip the reminder that no longer fits. Reminders go out around 08:00 script time.

Emails contain only name, date, time and place. **Do not put diagnoses or treatment details in the import file.**

## Managing appointments

* To stop reminders, set the row's **Status** to `CANCELLED` in the sheet.
* Rows are deleted automatically 30 days after the appointment (`RETAIN_DAYS` in `Code.gs`).
* Gmail limits daily sends (about 100 for a free account, 1,500 for Workspace). The page shows how many remain when you test the connection.

## Security notes

* Requests need the secret key; the script refuses to run if no strong secret is set.
* The page never stores the secret or any patient data. Only the script URL and clinic details are remembered in the browser.
* Inputs are validated again in the script, text is escaped in emails, and spreadsheet cells that start with `=`, `+`, `-` or `@` are stored as plain text.
* Anyone with the web app URL **and** the secret can add appointments, so treat the secret like a password and rotate it if shared.

## Privacy

Appointment emails about patients may fall under health-privacy law where you operate (for example HIPAA in the US or the Privacy Act and APPs in Australia). Check with your compliance adviser, in particular about sending patient details by email and about the retention period.
