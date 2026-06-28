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

// ══════════════════════════════════════════════
// POST ROUTER
// ══════════════════════════════════════════════
function doPost(e) {
  var data = JSON.parse(e.postData.contents);

  if (data.action === 'readBill') {
    return callAnthropic(data.image, data.mimeType, data.prompt, 1024);
  }
  if (data.action === 'readSlip') {
    var slipPrompt = 'This is a Thai bank payment slip. Extract the total transfer amount. Look for: ยอดโอน, จำนวนเงิน, amount, total. Return ONLY valid JSON: {"amount": "4800.00"} Numbers only, no currency symbol, 2 decimal places.';
    return callAnthropic(data.image, data.mimeType, slipPrompt, 256);
  }
  if (data.action === 'savePending') {
    var r = savePendingToSheet(data);
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  if (data.action === 'updateStatus') {
    var r = updatePendingStatus(data.pending_id, data.status, data.updated_at);
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  if (data.action === 'deletePending') {
    var r = deletePendingRow(data.pending_id);
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
      sheet.appendRow(['#','Store Code','Store Name','DC','Bill Amount','Invoice Date','Status','Created At','Updated At']);
      sheet.getRange(1,1,1,9).setFontWeight('bold').setBackground('#fef3c7');
      sheet.setFrozenRows(1);
    }

    var colB = sheet.getRange('B:B').getValues();
    var lastDataRow = 1;
    for (var i = colB.length - 1; i >= 1; i--) {
      if (colB[i][0] !== '' && colB[i][0] !== null) { lastDataRow = i + 1; break; }
    }
    var newRow = lastDataRow + 1;
    var rowNum = newRow - 1;
    var now = new Date().toString();

    sheet.getRange(newRow, 1, 1, 9).setValues([[
      rowNum,
      data.store_code    || '',
      data.store_name    || '',
      data.dc_name       || '',
      data.bill_amount   || '',
      data.invoice_date  || '',
      'pending',
      now,
      now
    ]]);
    Logger.log('Pending saved: ' + data.store_name + ' row ' + newRow);
    return { success: true, row: newRow, pending_id: rowNum };
  } catch(err) {
    Logger.log('savePendingToSheet error: ' + err);
    return { success: false, error: err.toString() };
  }
}

// ══════════════════════════════════════════════
// PENDING TAB — updatePendingStatus
// Finds row by pending_id (#) and updates Status + Updated At
// ══════════════════════════════════════════════
function updatePendingStatus(pendingId, newStatus, updatedAt) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(PENDING_TAB);
    if (!sheet) return { success: false, error: 'Pending sheet not found' };

    var colA = sheet.getRange('A:A').getValues();
    var targetRow = -1;
    for (var i = 1; i < colA.length; i++) {
      if (colA[i][0].toString() === pendingId.toString()) { targetRow = i + 1; break; }
    }
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
// Finds row by pending_id (#) and removes it
// ══════════════════════════════════════════════
function deletePendingRow(pendingId) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(PENDING_TAB);
    if (!sheet) return { success: false, error: 'Pending sheet not found' };

    var colA = sheet.getRange('A:A').getValues();
    var targetRow = -1;
    for (var i = 1; i < colA.length; i++) {
      if (colA[i][0].toString() === pendingId.toString()) { targetRow = i + 1; break; }
    }
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
