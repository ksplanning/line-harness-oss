import { describe, expect, test } from 'vitest';
import { matchesAutoReplyKeyword } from './auto-reply-keyword-match.js';

const activeGlobal = {
  keyword: '＃予約',
  match_type: 'exact',
  line_account_id: null,
  is_active: 1,
};

describe('matchesAutoReplyKeyword — unread fail-closed matrix', () => {
  test('[a] folds only full-width hash and edge whitespace/newlines', () => {
    expect(matchesAutoReplyKeyword(' \n#予約\r\n', activeGlobal, 'acc-1')).toBe(true);
    expect(matchesAutoReplyKeyword('予約', activeGlobal, 'acc-1')).toBe(false);
    expect(matchesAutoReplyKeyword('#予約\n別件', activeGlobal, 'acc-1')).toBe(false);
    expect(matchesAutoReplyKeyword('第1希望', { ...activeGlobal, keyword: '第①希望' }, 'acc-1')).toBe(false);
  });

  test('[a contains] applies the narrow fold without erasing a different phrase', () => {
    const rule = { ...activeGlobal, keyword: '＃料金', match_type: 'contains' };
    expect(matchesAutoReplyKeyword(' \n#料金を確認\r\n', rule, 'acc-1')).toBe(true);
    expect(matchesAutoReplyKeyword('料金を確認', rule, 'acc-1')).toBe(false);
    expect(matchesAutoReplyKeyword('#料 金を確認', rule, 'acc-1')).toBe(false);
    expect(matchesAutoReplyKeyword('通常メッセージ', { ...rule, keyword: '　' }, 'acc-1')).toBe(false);
    expect(matchesAutoReplyKeyword('予約変更', { ...rule, keyword: '予約 ' }, 'acc-1')).toBe(false);
    expect(matchesAutoReplyKeyword('予約 変更', { ...rule, keyword: '予約 ' }, 'acc-1')).toBe(true);
  });

  test('[b] accepts global/same-account rules and rejects another or unresolved account', () => {
    const scoped = { ...activeGlobal, line_account_id: 'acc-1' };
    expect(matchesAutoReplyKeyword('#予約', activeGlobal, 'acc-1')).toBe(true);
    expect(matchesAutoReplyKeyword('#予約', scoped, 'acc-1')).toBe(true);
    expect(matchesAutoReplyKeyword('#予約', scoped, 'acc-2')).toBe(false);
    expect(matchesAutoReplyKeyword('#予約', scoped, null)).toBe(false);
  });

  test('[e] inactive and unknown match types fail closed while active exact/contains classify', () => {
    expect(matchesAutoReplyKeyword('#予約', { ...activeGlobal, is_active: 0 }, 'acc-1')).toBe(false);
    expect(matchesAutoReplyKeyword('#予約', { ...activeGlobal, match_type: 'future' }, 'acc-1')).toBe(false);
    expect(matchesAutoReplyKeyword('#予約', activeGlobal, 'acc-1')).toBe(true);
    expect(matchesAutoReplyKeyword('先頭#予約末尾', { ...activeGlobal, match_type: 'contains' }, 'acc-1')).toBe(true);
  });
});
