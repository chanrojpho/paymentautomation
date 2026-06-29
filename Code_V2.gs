// ══════════════════════════════════════════════
// TWD Auto Billing V2 — Google Apps Script
// ══════════════════════════════════════════════
// ⚠️ Use a NEW GAS project + NEW Sheet for V2
// Do NOT overwrite V1 Sheet or GAS project

var TARGET_URL        = "https://n8n-01.carabao.co.th/api/submit-delivery-form";
var OVERDUE_URL       = "https://n8n-01.carabao.co.th/api/submit-overdue-form";
var SHEET_ID          = "14kqAxF338HWS_xBxugs7i5Gq8nlfn8ttp37VyLmkg8s";
var ANTHROPIC_API_KEY = "YOUR_ANTHROPIC_API_KEY_HERE"; // real key lives ONLY in the deployed GAS project — never commit it

var PENDING_TAB  = "Pending";
var SLIP_TAB     = "Bill Upload";
var OVERDUE_TAB  = "Overdue Upload";

// ── Daily reminder email (ผู้ดูแล จี๋) ──
var REMINDER_EMAIL    = "chanrojphongay@gmail.com"; // where the nightly reminder goes (จี๋'s email)
var REMINDER_STAFF    = ["จี๋", "จันโรจน์"];          // a Pending row is "จี๋'s" if its Staff cell CONTAINS one of these
var REMINDER_STATUSES = ["pending", "overdue"];      // statuses to remind about (bills with money still owed)

// ══════════════════════════════════════════════
// POST ROUTER
// ══════════════════════════════════════════════
function doPost(e) {
  var data = JSON.parse(e.postData.contents);

  if (data.action === 'readBill') {
    return callAnthropic(data.image, data.mimeType, data.prompt, 1024);
  }
  if (data.action === 'readSlip') {
    var slipPrompt = 'This is a Thai bank payment/transfer slip. Extract THREE fields: '
      + '(1) amount — the total transfer amount (ยอดโอน/จำนวนเงิน/amount/total), numbers only, 2 decimals, no currency symbol. '
      + '(2) reference — the transaction reference number / transaction id (รหัสอ้างอิง/เลขที่รายการ/หมายเลขอ้างอิง/Ref/Reference No.). Copy the exact code as printed (digits and letters only, drop spaces), or "" if none is visible. '
      + '(3) date — the transfer date as YYYY-MM-DD. If the year is Thai Buddhist (e.g. 2569) convert by subtracting 543. Use "" if not visible. '
      + 'Return ONLY valid JSON: {"amount":"4800.00","reference":"016287000123456","date":"2026-06-30"}';
    return callAnthropic(data.image, data.mimeType, slipPrompt, 512);
  }
  if (data.action === 'savePending') {
    var r = savePendingToSheet(data);
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  if (data.action === 'updateStatus') {
    var r = updatePendingStatus(data.pending_id, data.status, data.updated_at, data.row);
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  if (data.action === 'deletePending') {
    var r = deletePendingRow(data.pending_id, data.row);
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  if (data.action === 'setOverdueDays') {
    var r = setOverdueDays(data.pending_id, data.days, data.updated_at, data.row);
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  if (data.action === 'setSlipRef') {
    var r = setSlipRef(data.pending_id, data.slip_ref, data.row);
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  if (data.action === 'saveHistory') {
    var r = saveSlipToSheet(data);
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  if (data.action === 'saveOverdue') {
    var r = saveOverdueToSheet(data);
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  if (data.action === 'submitOverdue') {
    var r = processOverdueSubmit(e);
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  // Default — submit slip multipart to ตะวันแดง
  var r = processSlipSubmit(e);
  return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════
// GET ROUTER
// ══════════════════════════════════════════════
function doGet(e) {
  if (e.parameter.action === 'storeSearch') {
    try {
      var q = e.parameter.q || '';
      var res = UrlFetchApp.fetch(
        'https://n8n-01.carabao.co.th/api/store-search?q=' + encodeURIComponent(q),
        { muteHttpExceptions: true }
      );
      var raw = res.getContentText();
      var match = raw.match(/\((\[.*\])\)/s);
      var clean = match ? match[1] : raw;
      return ContentService.createTextOutput(clean).setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService.createTextOutput(JSON.stringify({ error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (e.parameter.action === 'getPending') {
    try {
      var ss = SpreadsheetApp.openById(SHEET_ID);
      var sheet = ss.getSheetByName(PENDING_TAB);
      if (!sheet) return ContentService.createTextOutput(JSON.stringify([])).setMimeType(ContentService.MimeType.JSON);
      var rows = sheet.getDataRange().getValues();
      var headers = rows[0];
      var result = [];
      var filterDate = e.parameter.date || ''; // YYYY-MM-DD optional
      for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        if (!row[1] || row[1] === '') continue;
        var obj = {};
        for (var j = 0; j < headers.length; j++) {
          obj[headers[j].toString().trim().toLowerCase().replace(/ /g,'_')] = row[j] ? row[j].toString() : '';
        }
        obj['_row'] = i + 1; // 1-indexed sheet row for updates
        if (!filterDate || (obj.invoice_date || '').startsWith(filterDate)) {
          result.push(obj);
        }
      }
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService.createTextOutput(JSON.stringify({ error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (e.parameter.action === 'getSheetHistory') {
    try {
      var ss = SpreadsheetApp.openById(SHEET_ID);
      var sheet = ss.getSheetByName(e.parameter.tab);
      if (!sheet) return ContentService.createTextOutput(JSON.stringify([])).setMimeType(ContentService.MimeType.JSON);
      var rows = sheet.getDataRange().getValues();
      var headers = rows[0];
      var result = [];
      for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        if (!row[1] || row[1] === '') continue;
        var obj = {};
        for (var j = 0; j < headers.length; j++) {
          obj[headers[j].toString().trim().toLowerCase().replace(/ /g,'_')] = row[j] ? row[j].toString() : '';
        }
        result.push(obj);
      }
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService.createTextOutput(JSON.stringify({ error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (e.parameter.action === 'getStaff') {
    try {
      var ss = SpreadsheetApp.openById(SHEET_ID);
      var sheet = ss.getSheetByName('Staff');
      if (!sheet) return ContentService.createTextOutput(JSON.stringify([])).setMimeType(ContentService.MimeType.JSON);
      var rows = sheet.getDataRange().getValues();
      var headers = rows[0];
      var result = [];
      for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        if (!row[0] || row[0] === '') continue;
        var obj = {};
        for (var j = 0; j < headers.length; j++) {
          obj[headers[j].toString().trim().toLowerCase().replace(/ /g,'_')] = row[j] ? row[j].toString() : '';
        }
        result.push(obj);
      }
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService.createTextOutput(JSON.stringify({ error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({ status: "ok", version: "v2" })).setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════
// PENDING TAB — savePendingToSheet
// Columns: # | Store Code | Store Name | DC | Bill Amount | Invoice Date | Status | Created At | Updated At
// ══════════════════════════════════════════════
function savePendingToSheet(data) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(PENDING_TAB);
    if (!sheet) {
      sheet = ss.insertSheet(PENDING_TAB);
      sheet.appendRow(['#','Store Code','Store Name','DC','Bill Amount','Invoice Date','Status','Created At','Updated At','Overdue Days','Staff','Slip Ref']);
      sheet.getRange(1,1,1,12).setFontWeight('bold').setBackground('#fef3c7');
      sheet.setFrozenRows(1);
    }
    // ensure/repair the newer headers (sheets created before these columns existed)
    sheet.getRange(1, 10).setValue('Overdue Days');
    sheet.getRange(1, 11).setValue('Staff');
    sheet.getRange(1, 12).setValue('Slip Ref');

    // Scan once: find the last data row AND the highest existing # so the new
    // bill gets a number that was never used before. Reusing newRow-1 caused
    // duplicate #s after a delete -> actions hit the wrong row (data loss).
    var colA = sheet.getRange('A:A').getValues();
    var colB = sheet.getRange('B:B').getValues();
    var lastDataRow = 1;
    var maxId = 0;
    for (var i = 1; i < colB.length; i++) {
      if (colB[i][0] !== '' && colB[i][0] !== null) {
        lastDataRow = i + 1;
        var idn = parseInt(colA[i][0], 10);
        if (!isNaN(idn) && idn > maxId) maxId = idn;
      }
    }
    var newRow = lastDataRow + 1;
    var rowNum = maxId + 1; // unique, monotonically increasing — never collides
    var now = new Date().toString();

    sheet.getRange(newRow, 1, 1, 11).setValues([[
      rowNum,
      data.store_code    || '',
      data.store_name    || '',
      data.dc_name       || '',
      data.bill_amount   || '',
      data.invoice_date  || '',
      'pending',
      now,
      now,
      '',
      data.staff         || ''
    ]]);
    Logger.log('Pending saved: ' + data.store_name + ' row ' + newRow);
    return { success: true, row: newRow, pending_id: rowNum };
  } catch(err) {
    Logger.log('savePendingToSheet error: ' + err);
    return { success: false, error: err.toString() };
  }
}

// ══════════════════════════════════════════════
// Resolve the target sheet row. Prefer the exact _row the client captured from
// getPending (always unique) over the # column, which can repeat after deletes
// and caused actions to hit — and wipe — the wrong customer's row.
// ══════════════════════════════════════════════
function resolvePendingRow(sheet, explicitRow, pendingId) {
  var lastRow = sheet.getLastRow();
  var r = parseInt(explicitRow, 10);
  if (!isNaN(r) && r >= 2 && r <= lastRow) return r;
  var colA = sheet.getRange('A:A').getValues();
  for (var i = 1; i < colA.length; i++) {
    if (colA[i][0].toString() === String(pendingId)) return i + 1;
  }
  return -1;
}

// ══════════════════════════════════════════════
// PENDING TAB — updatePendingStatus
// Finds row by _row (preferred) or pending_id (#) and updates Status + Updated At
// ══════════════════════════════════════════════
function updatePendingStatus(pendingId, newStatus, updatedAt, rowHint) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(PENDING_TAB);
    if (!sheet) return { success: false, error: 'Pending sheet not found' };

    var targetRow = resolvePendingRow(sheet, rowHint, pendingId);
    if (targetRow === -1) return { success: false, error: 'pending_id ' + pendingId + ' not found' };

    // Column G = Status (7), Column I = Updated At (9)
    sheet.getRange(targetRow, 7).setValue(newStatus);
    sheet.getRange(targetRow, 9).setValue(updatedAt || new Date().toString());
    Logger.log('Status updated: row ' + targetRow + ' → ' + newStatus);
    return { success: true, row: targetRow };
  } catch(err) {
    Logger.log('updatePendingStatus error: ' + err);
    return { success: false, error: err.toString() };
  }
}

// ══════════════════════════════════════════════
// PENDING TAB — deletePendingRow
// Finds row by _row (preferred) or pending_id (#) and removes it
// ══════════════════════════════════════════════
function deletePendingRow(pendingId, rowHint) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(PENDING_TAB);
    if (!sheet) return { success: false, error: 'Pending sheet not found' };

    var targetRow = resolvePendingRow(sheet, rowHint, pendingId);
    if (targetRow === -1) return { success: false, error: 'pending_id ' + pendingId + ' not found' };

    sheet.deleteRow(targetRow);
    Logger.log('Deleted pending row ' + targetRow + ' (id ' + pendingId + ')');
    return { success: true, row: targetRow };
  } catch(err) {
    Logger.log('deletePendingRow error: ' + err);
    return { success: false, error: err.toString() };
  }
}

// ══════════════════════════════════════════════
// PENDING TAB — setOverdueDays
// Stores chosen overdue days in the "Overdue Days" column (J)
// (Payment Due Date = Invoice + days, computed on the client)
// ══════════════════════════════════════════════
function setOverdueDays(pendingId, days, updatedAt, rowHint) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(PENDING_TAB);
    if (!sheet) return { success: false, error: 'Pending sheet not found' };

    sheet.getRange(1, 10).setValue('Overdue Days'); // ensure/repair header

    var targetRow = resolvePendingRow(sheet, rowHint, pendingId);
    if (targetRow === -1) return { success: false, error: 'pending_id ' + pendingId + ' not found' };

    var d = parseInt(days, 10);
    if (isNaN(d) || d < 1) d = 1;
    sheet.getRange(targetRow, 10).setValue(d);
    sheet.getRange(targetRow, 9).setValue(updatedAt || new Date().toString()); // Updated At
    Logger.log('Set overdue days row ' + targetRow + ' -> ' + d);
    return { success: true, days: d };
  } catch(err) {
    Logger.log('setOverdueDays error: ' + err);
    return { success: false, error: err.toString() };
  }
}

// ══════════════════════════════════════════════
// PENDING TAB — setSlipRef
// Stores the payment slip's transaction reference (col 12) so the client can
// detect the SAME slip being attached to a second bill (wrong-slip guard).
// ══════════════════════════════════════════════
function setSlipRef(pendingId, ref, rowHint) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(PENDING_TAB);
    if (!sheet) return { success: false, error: 'Pending sheet not found' };

    sheet.getRange(1, 12).setValue('Slip Ref'); // ensure/repair header

    var targetRow = resolvePendingRow(sheet, rowHint, pendingId);
    if (targetRow === -1) return { success: false, error: 'pending_id ' + pendingId + ' not found' };

    sheet.getRange(targetRow, 12).setValue(ref || '');
    Logger.log('Set slip ref row ' + targetRow + ' -> ' + ref);
    return { success: true };
  } catch(err) {
    Logger.log('setSlipRef error: ' + err);
    return { success: false, error: err.toString() };
  }
}

// ══════════════════════════════════════════════
// SLIP → ตะวันแดง (multipart)
// ══════════════════════════════════════════════
function processSlipSubmit(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    Logger.log("=== SLIP SUBMIT: " + data.store_name + " ===");
    var imageBytes = Utilities.base64Decode(data.slip_image);
    var mimeType = data.slip_mime || "image/jpeg";
    var ext = mimeType.includes("png") ? "png" : "jpeg";
    var imageBlob = Utilities.newBlob(imageBytes, mimeType, "slip_image." + ext);
    var formData = {
      "delivery_date": data.delivery_date,
      "dc_name":       data.dc_name,
      "store_code":    data.store_code,
      "store_name":    data.store_name,
      "slip_image":    imageBlob
    };
    var response = UrlFetchApp.fetch(TARGET_URL, {
      method: "POST", payload: formData,
      followRedirects: true, muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    Logger.log("ตะวันแดง slip response: " + code);
    if (code >= 200 && code < 400) return { success: true, code: code };
    return { success: false, error: "Server returned " + code, body: response.getContentText() };
  } catch (err) {
    Logger.log("processSlipSubmit error: " + err);
    return { success: false, error: err.toString() };
  }
}

// ══════════════════════════════════════════════
// OVERDUE SUBMIT — forward to ตะวันแดง (server-side, bypasses Cloudflare/CORS)
// Mirrors processSlipSubmit; text-only fields (no image)
// ══════════════════════════════════════════════
function processOverdueSubmit(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    Logger.log("=== OVERDUE SUBMIT: " + data.customer_name + " ===");
    var formData = {
      "customer_code":    data.customer_code    || '',
      "customer_name":    data.customer_name    || '',
      "ceostaff_name":    data.ceostaff_name    || '',
      "position":         data.position         || '',
      "sales_area":       data.sales_area       || '',
      "line_id":          data.line_id          || '',
      "dc_name":          data.dc_name          || '',
      "amount":           data.amount           || '',
      "invoice_date":     data.invoice_date     || '',
      "payment_due_date": data.payment_due_date || ''
    };
    var response = UrlFetchApp.fetch(OVERDUE_URL, {
      method: "POST", payload: formData,
      followRedirects: true, muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    Logger.log("overdue response: " + code);
    if (code >= 200 && code < 400) return { success: true, code: code };
    return { success: false, error: "Server returned " + code, body: response.getContentText() };
  } catch (err) {
    Logger.log("processOverdueSubmit error: " + err);
    return { success: false, error: err.toString() };
  }
}

// ══════════════════════════════════════════════
// BILL UPLOAD TAB
// ══════════════════════════════════════════════
function saveSlipToSheet(data) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(SLIP_TAB);
    if (!sheet) {
      sheet = ss.insertSheet(SLIP_TAB);
      sheet.appendRow(['#','delivery_date','dc_name','store_code','store_name','amount','sentAt']);
      sheet.getRange(1,1,1,7).setFontWeight('bold').setBackground('#e0f2f1');
      sheet.setFrozenRows(1);
    }
    var colB = sheet.getRange('B:B').getValues();
    var lastDataRow = 1;
    for (var i = colB.length - 1; i >= 1; i--) {
      if (colB[i][0] !== '' && colB[i][0] !== null) { lastDataRow = i + 1; break; }
    }
    var newRow = lastDataRow + 1;
    sheet.getRange(newRow, 1, 1, 7).setValues([[
      newRow - 1,
      data.delivery_date || '',
      data.dc_name       || '',
      data.store_code    || '',
      data.store_name    || '',
      data.amount        || '',
      data.sentAt        || new Date().toString()
    ]]);
    Logger.log('Slip saved: ' + data.store_name);
    return { success: true, row: newRow };
  } catch(err) {
    Logger.log('saveSlipToSheet error: ' + err);
    return { success: false, error: err.toString() };
  }
}

// ══════════════════════════════════════════════
// OVERDUE UPLOAD TAB
// ══════════════════════════════════════════════
function saveOverdueToSheet(data) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(OVERDUE_TAB);
    if (!sheet) {
      sheet = ss.insertSheet(OVERDUE_TAB);
      sheet.appendRow(['#','Customer Code','Customer Name','CEO Staff Name',
        'ตำแหน่ง','พื้นที่ขาย','LINE ID','DC','Amount','Invoice Date',
        'Payment Due Date','Time Stamp']);
      sheet.getRange(1,1,1,12).setFontWeight('bold').setBackground('#fee2e2');
      sheet.setFrozenRows(1);
    }
    var colB = sheet.getRange('B:B').getValues();
    var lastDataRow = 1;
    for (var i = colB.length - 1; i >= 1; i--) {
      if (colB[i][0] !== '' && colB[i][0] !== null) { lastDataRow = i + 1; break; }
    }
    var newRow = lastDataRow + 1;
    sheet.getRange(newRow, 1, 1, 12).setValues([[
      newRow - 1,
      data.customer_code    || '',
      data.customer_name    || '',
      data.ceostaff_name    || '',
      data.position         || '',
      data.sales_area       || '',
      data.line_id          || '',
      data.dc_name          || '',
      data.amount           || '',
      data.invoice_date     || '',
      data.payment_due_date || '',
      data.sentAt           || new Date().toString()
    ]]);
    Logger.log('Overdue saved: ' + data.customer_name);
    return { success: true, row: newRow };
  } catch(err) {
    Logger.log('saveOverdueToSheet error: ' + err);
    return { success: false, error: err.toString() };
  }
}

// ══════════════════════════════════════════════
// DAILY REMINDER EMAIL — bills still needing action for ผู้ดูแล จี๋
// Emails a nightly summary (default ~21:45) of unpaid bills (pending + overdue)
// whose Staff is จี๋ — see REMINDER_* config near the top of the file.
//
// SET UP ONCE on script.google.com:
//   1) Project Settings → set Time zone = Asia/Bangkok (so 21:45 = Thai time)
//   2) Run sendReminderNow() once  → authorize "send email as you", check inbox
//   3) Run installReminderTrigger() once → Google then sends it daily on its own
// No web-app redeploy is needed — triggers run against the saved script.
// ══════════════════════════════════════════════
function sendPendingReminder() {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(PENDING_TAB);
    if (!sheet) { Logger.log('Reminder: no Pending tab'); return; }
    var rows = sheet.getDataRange().getValues();
    if (rows.length < 2) return;
    var headers = rows[0];
    function col(name) {
      for (var i = 0; i < headers.length; i++) {
        if (headers[i].toString().trim().toLowerCase() === name.toLowerCase()) return i;
      }
      return -1;
    }
    var cStore = col('Store Name'), cDC = col('DC'), cAmt = col('Bill Amount'),
        cInv = col('Invoice Date'), cStatus = col('Status'), cStaff = col('Staff');

    var bills = [], total = 0;
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r[1]) continue; // blank/spacer row
      var status = (cStatus > -1 ? r[cStatus] : '').toString().trim().toLowerCase();
      if (REMINDER_STATUSES.indexOf(status) === -1) continue;
      var staff = (cStaff > -1 ? r[cStaff] : '').toString();
      var mine = false;
      for (var k = 0; k < REMINDER_STAFF.length; k++) {
        if (staff.indexOf(REMINDER_STAFF[k]) !== -1) { mine = true; break; }
      }
      if (!mine) continue;
      var amt = parseFloat((cAmt > -1 ? r[cAmt] : '0').toString().replace(/[^0-9.]/g, '')) || 0;
      total += amt;
      bills.push({
        store:   (cStore > -1 ? r[cStore] : '').toString(),
        dc:      (cDC    > -1 ? r[cDC]    : '').toString(),
        invoice: (cInv   > -1 ? r[cInv]   : '').toString(),
        status:  status,
        amount:  amt
      });
    }

    if (!bills.length) { Logger.log('Reminder: nothing outstanding for ' + REMINDER_STAFF.join('/')); return; }

    // overdue first (more urgent), then pending — each group oldest delivery first
    bills.sort(function(a, c) {
      if (a.status !== c.status) return a.status === 'overdue' ? -1 : 1;
      return a.invoice < c.invoice ? -1 : (a.invoice > c.invoice ? 1 : 0);
    });
    var nOverdue = bills.filter(function(x){ return x.status === 'overdue'; }).length;
    var nPending = bills.length - nOverdue;

    var subject = '🔔 บิลค้างเก็บเงิน ' + bills.length + ' รายการ — รวม ฿' + fmtMoneyGS(total);
    var html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;max-width:600px">'
      + '<h2 style="color:#b45309;margin:0 0 4px">🐱 TWD Auto Billing</h2>'
      + '<p style="margin:0 0 14px;color:#6b7280">บิลที่ยังไม่ได้รับชำระ (ผู้ดูแล: จี๋) — '
      + 'รอเก็บเงิน ' + nPending + ' • ค้างชำระ ' + nOverdue + '</p>'
      + '<table cellspacing="0" cellpadding="8" style="border-collapse:collapse;width:100%">'
      + '<tr style="background:#fef3c7;font-weight:bold;text-align:left">'
      + '<td>ร้าน</td><td>DC</td><td>วันส่งของ</td><td>สถานะ</td><td style="text-align:right">ยอด</td></tr>';
    for (var b = 0; b < bills.length; b++) {
      var row = bills[b], bg = (b % 2) ? '#f9fafb' : '#ffffff';
      var isOv = row.status === 'overdue';
      var stTxt = isOv ? '😿 ค้างชำระ' : '🕒 รอเก็บเงิน';
      var stCol = isOv ? '#b91c1c' : '#92400e';
      html += '<tr style="background:' + bg + '">'
        + '<td>' + htmlEsc(row.store) + '</td><td>' + htmlEsc(row.dc) + '</td>'
        + '<td>' + fmtDateGS(row.invoice) + '</td>'
        + '<td style="color:' + stCol + ';font-weight:bold">' + stTxt + '</td>'
        + '<td style="text-align:right">฿' + fmtMoneyGS(row.amount) + '</td></tr>';
    }
    html += '<tr style="font-weight:bold;border-top:2px solid #b45309">'
      + '<td colspan="4">รวม ' + bills.length + ' รายการ</td>'
      + '<td style="text-align:right">฿' + fmtMoneyGS(total) + '</td></tr></table>'
      + '<p style="margin:18px 0"><a href="https://chanrojpho.github.io/paymentautomation/" '
      + 'style="background:#f59e0b;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">เปิดแอปจัดการบิล →</a></p>'
      + '<p style="color:#9ca3af;font-size:12px">อีเมลอัตโนมัติจากระบบ TWD Auto Billing • ส่งทุกวัน ~21:45</p></div>';

    MailApp.sendEmail({ to: REMINDER_EMAIL, subject: subject, htmlBody: html });
    Logger.log('Reminder sent to ' + REMINDER_EMAIL + ' (' + bills.length + ' bills, ฿' + fmtMoneyGS(total) + ')');
  } catch(err) {
    Logger.log('sendPendingReminder error: ' + err);
  }
}

// thousands separator without relying on locale APIs (runtime-safe)
function fmtMoneyGS(n) { return Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
// stored date (YYYY-MM-DD or other) -> DD/MM/YYYY for the email
function fmtDateGS(v) {
  if (!v) return '-';
  var s = v.toString();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[3] + '/' + m[2] + '/' + m[1]) : s;
}
// minimal HTML escape for store/DC names
function htmlEsc(s) { return (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Run ONCE in the editor to schedule the nightly email (~21:45, project time zone).
// Safe to re-run — removes any previous copy first.
function installReminderTrigger() {
  var trigs = ScriptApp.getProjectTriggers();
  for (var i = 0; i < trigs.length; i++) {
    if (trigs[i].getHandlerFunction() === 'sendPendingReminder') ScriptApp.deleteTrigger(trigs[i]);
  }
  ScriptApp.newTrigger('sendPendingReminder').timeBased().everyDays(1).atHour(21).nearMinute(45).create();
  Logger.log('Reminder trigger installed: every day ~21:45 (project time zone)');
}

// Manual test — sends the email right now so you can preview it / authorize.
function sendReminderNow() { sendPendingReminder(); }

// ══════════════════════════════════════════════
// AI (Anthropic) — reused from V1
// ══════════════════════════════════════════════
function callAnthropic(imageBase64, mimeType, prompt, maxTokens) {
  var payload = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: "You are a JSON-only extraction API. Respond with a single valid JSON object and nothing else.",
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
      { type: "text", text: prompt }
    ]}]
  });
  var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    payload: payload,
    muteHttpExceptions: true
  });
  return ContentService.createTextOutput(response.getContentText()).setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════
// SETUP / TEST
// ══════════════════════════════════════════════

// Run once after creating the new Sheet to initialize all 3 tabs
function setupV2Sheets() {
  savePendingToSheet({ store_code:'TEST', store_name:'TEST', dc_name:'TEST', bill_amount:'0', invoice_date:'TEST' });
  saveSlipToSheet({ delivery_date:'TEST', dc_name:'TEST', store_code:'TEST', store_name:'TEST', amount:'0', sentAt:'TEST' });
  saveOverdueToSheet({ customer_code:'TEST', customer_name:'TEST', ceostaff_name:'TEST', position:'TEST', sales_area:'TEST', line_id:'TEST', dc_name:'TEST', amount:'0', invoice_date:'TEST', payment_due_date:'TEST', sentAt:'TEST' });
  Logger.log('V2 sheets ready!');
}

function testConnection() {
  var response = UrlFetchApp.fetch("https://n8n-01.carabao.co.th/api/delivery-form", { muteHttpExceptions: true });
  Logger.log("Status: " + response.getResponseCode());
}
