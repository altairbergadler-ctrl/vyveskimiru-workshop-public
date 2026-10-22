// Applied in the spreadsheet-bound Apps Script on 2026-09-11.
// First statement in each of applyDataFixes, fillOrderSums, rebuildPayments,
// moveManualColumns: guardLegacyFinanceMigration_('theFunctionName');
// This file documents the installed fragment; it is not run by the backend.
function guardLegacyFinanceMigration_(command) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Платежи');
  if (!sheet) throw new Error('Лист «Платежи» не найден. Запись остановлена.');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  if (headers.indexOf('sync_id') !== -1 || headers.indexOf('Название заказа') !== -1) {
    throw new Error('Команда «' + command + '» предназначена для прежней структуры таблицы. Запись остановлена: используйте приложение «Мастерская».');
  }
}
