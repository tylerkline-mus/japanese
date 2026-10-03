/**
 * Japanese Hub — grammar review sync.
 * Paste this into your notes Sheet: Extensions → Apps Script.
 * It stores review progress in a tab called "srs" (created automatically).
 *
 * Set KEY to any long random phrase, then type the same phrase into the hub's
 * Settings. Anyone without the key gets nothing.
 */
const KEY = "PASTE-YOUR-KEY-HERE";
const TAB = "srs";
const COLS = ["id", "stage", "due", "right", "wrong", "seen", "updated"];

function doGet(e) {
  return handle_(e && e.parameter ? e.parameter : {});
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: "Bad request" });
  }
  return handle_(body);
}

function handle_(p) {
  if (!KEY || KEY === "PASTE-YOUR-KEY-HERE" || p.key !== KEY) {
    return out_({ ok: false, error: "Wrong or missing key" });
  }
  const sheet = sheet_();
  if (p.action === "get") return out_({ ok: true, items: read_(sheet) });
  if (p.action === "put") {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      write_(sheet, Array.isArray(p.items) ? p.items : []);
    } finally {
      lock.releaseLock();
    }
    return out_({ ok: true });
  }
  return out_({ ok: false, error: "Unknown action" });
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TAB);
  if (!sh) {
    sh = ss.insertSheet(TAB); // added at the end, so your notes tab stays first
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight("bold");
    sh.getRange("A:G").setNumberFormat("@"); // keep dates as plain text
    sh.setFrozenRows(1);
  }
  return sh;
}

function read_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, COLS.length).getDisplayValues();
  return vals
    .filter((r) => r[0])
    .map((r) => {
      const o = {};
      COLS.forEach((c, i) => (o[c] = r[i]));
      return o;
    });
}

function write_(sh, items) {
  const last = sh.getLastRow();
  const ids = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getDisplayValues().map((r) => r[0]) : [];
  items.forEach((it) => {
    if (!it || !it.id) return;
    const row = COLS.map((c) => (it[c] === undefined || it[c] === null ? "" : String(it[c])));
    const idx = ids.indexOf(String(it.id));
    if (idx >= 0) {
      sh.getRange(idx + 2, 1, 1, COLS.length).setNumberFormat("@").setValues([row]);
    } else {
      sh.appendRow(row);
      ids.push(String(it.id));
      sh.getRange(sh.getLastRow(), 1, 1, COLS.length).setNumberFormat("@").setValues([row]);
    }
  });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
