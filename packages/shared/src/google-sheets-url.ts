const GOOGLE_SHEETS_URL = /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,200})(?:[/?#]|$)/i;

/** Extract an editable spreadsheet id from an ordinary Google Sheets sharing URL. */
export function extractGoogleSpreadsheetId(value: string): string | null {
  return GOOGLE_SHEETS_URL.exec(value.trim())?.[1] ?? null;
}
