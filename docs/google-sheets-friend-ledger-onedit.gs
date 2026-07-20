/**
 * LINE ハーネス「友だち台帳」編集通知。
 *
 * このファイル全体を Apps Script にコピペし、先にスクリプト
 * プロパティを設定してから installFriendLedgerSync() を 1 回実行します。
 * セル値は送信せず、編集範囲だけを署名して通知します。
 */

var FRIEND_LEDGER_PROPERTY_NAMES = [
  'SHEETS_WEBHOOK_URL',
  'SHEETS_WEBHOOK_SECRET',
  'SHEETS_CONNECTION_ID',
  'SHEETS_SPREADSHEET_ID',
  'SHEETS_SHEET_NAME'
];

function friendLedgerProperties_() {
  var values = PropertiesService.getScriptProperties().getProperties();
  FRIEND_LEDGER_PROPERTY_NAMES.forEach(function (name) {
    if (!values[name]) throw new Error('スクリプト プロパティ「' + name + '」が未設定です。');
  });
  return values;
}

function hmacHex_(message, secret) {
  return Utilities.computeHmacSha256Signature(
    message,
    secret,
    Utilities.Charset.UTF_8
  ).map(function (byte) {
    return ((byte + 256) % 256).toString(16).padStart(2, '0');
  }).join('');
}

/** 同じトリガーを重複させず、インストール型の編集時トリガーを作ります。 */
function installFriendLedgerSync() {
  var values = friendLedgerProperties_();
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (spreadsheet.getId() !== values.SHEETS_SPREADSHEET_ID) {
    throw new Error('開いているスプレッドシート ID と設定値が一致しません。');
  }
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'friendLedgerOnEdit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('friendLedgerOnEdit')
    .forSpreadsheet(spreadsheet)
    .onEdit()
    .create();
}

/** Apps Script のインストール型「編集時」トリガーから呼ばれます。 */
function friendLedgerOnEdit(event) {
  if (!event || !event.range) return;
  var values = friendLedgerProperties_();
  var sheet = event.range.getSheet();
  var spreadsheet = sheet.getParent();
  if (
    spreadsheet.getId() !== values.SHEETS_SPREADSHEET_ID ||
    sheet.getName() !== values.SHEETS_SHEET_NAME
  ) return;

  var timestamp = new Date().toISOString();
  var actor = Session.getActiveUser().getEmail() || 'google_sheets_editor';
  var payload = JSON.stringify({
    version: 1,
    connectionId: values.SHEETS_CONNECTION_ID,
    spreadsheetId: spreadsheet.getId(),
    sheetName: sheet.getName(),
    range: {
      rowStart: event.range.getRow(),
      rowEnd: event.range.getLastRow(),
      columnStart: event.range.getColumn(),
      columnEnd: event.range.getLastColumn()
    },
    actor: actor
  });
  var signature = hmacHex_(timestamp + '.' + payload, values.SHEETS_WEBHOOK_SECRET);
  var response;
  var status = 0;
  for (var attempt = 0; attempt < 3; attempt += 1) {
    response = UrlFetchApp.fetch(values.SHEETS_WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: payload,
      headers: {
        'X-Sheets-Signature': signature,
        'X-Sheets-Timestamp': timestamp
      },
      muteHttpExceptions: true
    });
    status = response.getResponseCode();
    if ([409, 429, 503].indexOf(status) === -1 || attempt === 2) break;
    Utilities.sleep(1000 * Math.pow(2, attempt));
  }
  if (status < 200 || status >= 300) {
    throw new Error('LINE ハーネスへの編集通知に失敗しました。接続設定を確認してください。');
  }
}
