export interface AutoReplyKeywordRule {
  keyword: string;
  match_type: string;
  line_account_id?: string | null;
  is_active?: number | boolean;
}

export interface AutoReplyKeywordMatchOptions {
  /** Preserve the historical raw comparison used for pre-marker rows. */
  normalize?: boolean;
  /** Preserve the historical cross-account comparison used for pre-marker rows. */
  enforceAccountScope?: boolean;
}

export const AUTO_REPLY_KEYWORD_SOURCE = 'auto_reply_keyword';
export const AUTO_REPLY_HANDLED_SOURCE = 'auto_reply_handled';
export const AUTO_REPLY_KEEP_UNRESPONDED_SOURCE = 'auto_reply_keep_unresponded';
export const UNMATCHED_USER_SOURCE = 'user_unmatched';

/**
 * Rich-menu labels can differ only by a full-width hash or transport-added
 * edge whitespace. Keep this normalization deliberately narrow: broad NFKC,
 * case folding, punctuation removal, or internal-whitespace folding could
 * hide a genuinely different operator message from unread.
 */
function foldFullWidthHash(value: string): string {
  return value.replace(/＃/g, '#');
}

export function matchesAutoReplyKeyword(
  content: string,
  rule: AutoReplyKeywordRule,
  lineAccountId: string | null,
  options: AutoReplyKeywordMatchOptions = {},
): boolean {
  if (rule.is_active !== undefined && !Boolean(rule.is_active)) return false;
  if (
    options.enforceAccountScope !== false
    && rule.line_account_id !== undefined
    && rule.line_account_id !== null
    && rule.line_account_id !== lineAccountId
  ) {
    return false;
  }

  if (options.normalize === false) {
    if (rule.match_type === 'exact') return content === rule.keyword;
    if (rule.match_type === 'contains') return content.includes(rule.keyword);
    return false;
  }

  if (rule.match_type === 'exact') {
    const normalizedContent = foldFullWidthHash(content).trim();
    const normalizedKeyword = foldFullWidthHash(rule.keyword).trim();
    if (normalizedContent.length === 0 || normalizedKeyword.length === 0) return false;
    return normalizedContent === normalizedKeyword;
  }
  if (rule.match_type === 'contains') {
    // Do not trim a contains keyword: removing a meaningful trailing space can
    // turn a narrower rule such as "予約 " into the broader word "予約".
    if (rule.keyword.trim().length === 0) return false;
    return foldFullWidthHash(content).includes(foldFullWidthHash(rule.keyword));
  }
  return false;
}
