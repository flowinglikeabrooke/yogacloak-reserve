/**
 * lib/sheets.js
 *
 * Two ways to write to Google Sheets — pick one:
 *
 * OPTION A (recommended, easiest): Google Apps Script Web App webhook
 *   → No OAuth, no service account, just a URL + secret header
 *   → See setup instructions at the bottom of this file
 *
 * OPTION B: Google Sheets API with a service account
 *   → More control, requires JSON key file
 *   → Set SHEETS_USE_API=true in your env vars to enable
 */

// ─────────────────────────────────────────────────────────────────────────────
// OPTION A  — Apps Script webhook (default)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Appends a new row to the sheet.
 * Called from /api/reserve immediately on form submission (status: pending).
 */
export async function logToSheet(data) {
  if (process.env.SHEETS_USE_API === "true") {
    return logToSheetViaAPI(data);
  }

  const webhookUrl = process.env.SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("SHEETS_WEBHOOK_URL not set — skipping sheet log");
    return;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": process.env.SHEETS_WEBHOOK_SECRET || "",
    },
    body: JSON.stringify({ action: "append", ...data }),
  });

  if (!res.ok) throw new Error(`Sheets webhook returned ${res.status}`);
}

/**
 * Updates a row's status column to "confirmed" after Stripe webhook fires.
 * Matches on stripeSessionId.
 */
export async function updateSheetStatus(stripeSessionId, status) {
  if (process.env.SHEETS_USE_API === "true") {
    return updateSheetStatusViaAPI(stripeSessionId, status);
  }

  const webhookUrl = process.env.SHEETS_WEBHOOK_URL;
  if (!webhookUrl) return;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": process.env.SHEETS_WEBHOOK_SECRET || "",
    },
    body: JSON.stringify({ action: "updateStatus", stripeSessionId, status }),
  });

  if (!res.ok) throw new Error(`Sheets webhook returned ${res.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTION B  — Google Sheets API (service account)
// ─────────────────────────────────────────────────────────────────────────────
// npm install googleapis

async function logToSheetViaAPI(data) {
  const { google } = await import("googleapis");

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const row = [
    data.timestamp,
    data.firstName,
    data.lastName,
    data.email,
    data.phone,
    data.product,
    data.size,
    `$${data.depositAmount}`,
    data.stripeSessionId,
    data.status,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Reservations!A:J",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

async function updateSheetStatusViaAPI(stripeSessionId, status) {
  const { google } = await import("googleapis");

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  // Find the row with matching session ID (column I = index 8)
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Reservations!I:I",
  });

  const rows = read.data.values || [];
  const rowIndex = rows.findIndex((r) => r[0] === stripeSessionId);
  if (rowIndex === -1) return; // not found

  const sheetRow = rowIndex + 1; // 1-indexed
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Reservations!J${sheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[status]] },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// APPS SCRIPT SETUP (Option A)
// ─────────────────────────────────────────────────────────────────────────────
/*
  1. Open your Google Sheet
  2. Extensions → Apps Script
  3. Paste this code and save:

  ---

  const SECRET = "your-webhook-secret-here"; // match SHEETS_WEBHOOK_SECRET

  function doPost(e) {
    const data = JSON.parse(e.postData.contents);

    if (e.parameter.secret !== SECRET &&
        (!e.headers || e.headers["X-Webhook-Secret"] !== SECRET)) {
      return ContentService.createTextOutput(
        JSON.stringify({ error: "unauthorized" })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet()
      .getSheetByName("Reservations");

    if (data.action === "append") {
      sheet.appendRow([
        data.timestamp,
        data.firstName,
        data.lastName,
        data.email,
        data.phone,
        data.product,
        data.size,
        "$" + data.depositAmount,
        data.stripeSessionId,
        data.status,
      ]);
    }

    if (data.action === "updateStatus") {
      const col = 9;  // Column I = stripeSessionId
      const statusCol = 10; // Column J = status
      const lastRow = sheet.getLastRow();
      const sessionIds = sheet.getRange(2, col, lastRow - 1, 1).getValues();
      for (let i = 0; i < sessionIds.length; i++) {
        if (sessionIds[i][0] === data.stripeSessionId) {
          sheet.getRange(i + 2, statusCol).setValue(data.status);
          break;
        }
      }
    }

    return ContentService.createTextOutput(
      JSON.stringify({ ok: true })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  ---

  4. Deploy → New deployment → Web app
     - Execute as: Me
     - Who has access: Anyone
  5. Copy the deployment URL → set as SHEETS_WEBHOOK_URL in your .env

  Sheet columns (create headers in row 1):
  A: Timestamp | B: First Name | C: Last Name | D: Email | E: Phone
  F: Product   | G: Size       | H: Deposit   | I: Stripe Session ID | J: Status
*/
