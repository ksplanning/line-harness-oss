/**
 * LINE ハーネス「友だち台帳」編集通知。
 *
 * このファイル全体を Apps Script にコピペし、先にスクリプト
 * プロパティを設定してから installFriendLedgerSync() を 1 回実行します。
 * 単一セルの編集前後値と一意な通知 ID をまとめて署名します。
 * 複数セルの貼り付けは、5 分ごとの安全なポーリングで反映します。
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

function friendLedgerEditTarget_(event, sheet) {
  var width = Math.max(1, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  var column = event.range.getColumn();
  var oldValueKnown = event.oldValue !== undefined;
  var header = event.range.getRow() === 1 && oldValueKnown
    ? String(event.oldValue)
    : String(headers[column - 1] || '');
  var rowUserId = null;
  if (event.range.getRow() > 1) {
    var userIdColumn = headers.indexOf('userId') + 1;
    if (header === 'userId' && oldValueKnown) {
      rowUserId = String(event.oldValue);
    } else if (userIdColumn > 0) {
      rowUserId = String(sheet.getRange(event.range.getRow(), userIdColumn).getDisplayValue() || '') || null;
    }
  }
  return { header: header, rowUserId: rowUserId };
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
  if (event.range.getNumRows() !== 1 || event.range.getNumColumns() !== 1) return;

  var timestamp = new Date().toISOString();
  var actorEmail = Session.getActiveUser().getEmail();
  var actor = actorEmail || 'google_sheets_editor_unavailable';
  var actorKind = actorEmail ? 'google_email' : 'unavailable';
  var oldValueKnown = event.oldValue !== undefined;
  var target = friendLedgerEditTarget_(event, sheet);
  var payload = JSON.stringify({
    version: 2,
    eventId: Utilities.getUuid(),
    occurredAt: timestamp,
    connectionId: values.SHEETS_CONNECTION_ID,
    spreadsheetId: spreadsheet.getId(),
    sheetName: sheet.getName(),
    range: {
      rowStart: event.range.getRow(),
      rowEnd: event.range.getLastRow(),
      columnStart: event.range.getColumn(),
      columnEnd: event.range.getLastColumn()
    },
    snapshot: {
      rowNumber: event.range.getRow(),
      columnNumber: event.range.getColumn(),
      header: target.header,
      rowUserId: target.rowUserId,
      value: event.value === undefined ? '' : event.value,
      oldValue: oldValueKnown ? event.oldValue : null,
      oldValueKnown: oldValueKnown
    },
    actor: actor,
    actorKind: actorKind
  });
  var signature = hmacHex_(timestamp + '.' + payload, values.SHEETS_WEBHOOK_SECRET);
  var response;
  var status = 0;
  for (var attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = UrlFetchApp.fetch(values.SHEETS_WEBHOOK_URL, {
        method: 'post',
        contentType: 'application/json',
        payload: payload,
        headers: {
          'X-Sheets-Signature': signature,
          'X-Sheets-Timestamp': timestamp,
          'X-Sheets-Connection-Id': values.SHEETS_CONNECTION_ID
        },
        muteHttpExceptions: true
      });
      status = response.getResponseCode();
    } catch (error) {
      status = 0;
    }
    var retriable = status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
    if (!retriable || attempt === 2) break;
    Utilities.sleep(1000 * Math.pow(2, attempt));
  }
  if (status < 200 || status >= 300) {
    throw new Error('LINE ハーネスへの編集通知に失敗しました。接続設定を確認してください。');
  }
}
