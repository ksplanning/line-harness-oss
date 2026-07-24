import { describe, expect, test } from 'vitest';
import {
  buildFormSubmissionDuplicateReview,
  type DuplicateReviewField,
  type DuplicateReviewSubmission,
} from './form-submission-duplicate-review.js';

const FIELDS: DuplicateReviewField[] = [
  { answerKey: 'email', type: 'email', label: 'メールアドレス' },
  { answerKey: 'name', type: 'text', label: 'お名前' },
];

function row(
  id: string,
  options: Partial<Omit<DuplicateReviewSubmission, 'id'>> = {},
): DuplicateReviewSubmission {
  return {
    id,
    formId: 'form-a',
    friendId: null,
    answersJson: '{}',
    submittedAt: `2026-07-24T10:00:0${id.length}+09:00`,
    reviewedAt: null,
    ...options,
  };
}

describe('buildFormSubmissionDuplicateReview', () => {
  test('groups the same friend even when answer contents differ', async () => {
    const result = await buildFormSubmissionDuplicateReview([
      row('friend-1', {
        friendId: 'U_same',
        answersJson: JSON.stringify({ name: '森山光子', quantity: 1 }),
      }),
      row('friend-2', {
        friendId: 'U_same',
        answersJson: JSON.stringify({ name: '森山光子', quantity: 2 }),
      }),
    ], FIELDS);

    expect(result.pendingCount).toBe(2);
    expect(result.byRowId.get('friend-1')).toMatchObject({
      groupSize: 2,
      contentMatch: 'different',
      reviewedAt: null,
    });
    expect(result.byRowId.get('friend-2')?.groupId)
      .toBe(result.byRowId.get('friend-1')?.groupId);
    expect(result.byRowId.get('friend-1')?.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  test('normalizes the first email and ignores later email fields for identity', async () => {
    const fields: DuplicateReviewField[] = [
      { answerKey: 'email-primary', type: 'email', label: '連絡先' },
      { answerKey: 'email-secondary', type: 'email', label: '予備' },
      { answerKey: 'name', type: 'text', label: '氏名' },
    ];
    const result = await buildFormSubmissionDuplicateReview([
      row('mail-1', {
        answersJson: JSON.stringify({
          'email-primary': '  ASK@Example.COM ',
          'email-secondary': 'ignored-1@example.test',
          name: '株式会社ASK',
        }),
      }),
      row('mail-2', {
        answersJson: JSON.stringify({
          name: '株式会社ASK',
          'email-secondary': 'ignored-2@example.test',
          'email-primary': 'ask@example.com',
        }),
      }),
    ], fields);

    expect(result.pendingCount).toBe(2);
    expect(result.byRowId.get('mail-1')).toMatchObject({
      groupSize: 2,
      contentMatch: 'different',
    });
  });

  test('treats answer objects with only a different key order as identical', async () => {
    const result = await buildFormSubmissionDuplicateReview([
      row('exact-1', {
        friendId: 'U_exact',
        answersJson: '{"email":"same@example.test","name":"同一","quantity":1}',
      }),
      row('exact-2', {
        friendId: 'U_exact',
        answersJson: '{"quantity":1,"name":"同一","email":"same@example.test"}',
      }),
    ], FIELDS);

    expect(result.byRowId.get('exact-1')?.contentMatch).toBe('identical');
    expect(result.byRowId.get('exact-2')?.contentMatch).toBe('identical');
  });

  test('normalizes the first matching name by trimming and removing whitespace', async () => {
    const fields: DuplicateReviewField[] = [
      { answerKey: 'nickname', type: 'text', label: '表示名' },
      { answerKey: 'applicant', type: 'text', label: '申込者名' },
      { answerKey: 'other-name', type: 'text', label: '氏名（予備）' },
    ];
    const result = await buildFormSubmissionDuplicateReview([
      row('name-1', {
        answersJson: JSON.stringify({
          nickname: '一致させない',
          applicant: ' 森山　光子 ',
          'other-name': '予備A',
        }),
      }),
      row('name-2', {
        answersJson: JSON.stringify({
          nickname: '別表示',
          applicant: '森 山 光 子',
          'other-name': '予備B',
        }),
      }),
    ], fields);

    expect(result.byRowId.get('name-1')).toMatchObject({
      groupSize: 2,
      contentMatch: 'different',
    });
  });

  test('joins friend-backed and anonymous rows transitively through email and name', async () => {
    const result = await buildFormSubmissionDuplicateReview([
      row('chain-1', {
        friendId: 'U_one',
        answersJson: JSON.stringify({ email: 'one@example.test', name: '甲' }),
      }),
      row('chain-2', {
        answersJson: JSON.stringify({ email: 'ONE@example.test', name: '橋渡し' }),
      }),
      row('chain-3', {
        friendId: 'U_two',
        answersJson: JSON.stringify({ email: 'two@example.test', name: '橋 渡 し' }),
      }),
      row('chain-4', {
        friendId: 'U_two',
        answersJson: JSON.stringify({ email: 'other@example.test', name: '乙' }),
      }),
    ], FIELDS);

    const groupIds = new Set(
      ['chain-1', 'chain-2', 'chain-3', 'chain-4']
        .map((id) => result.byRowId.get(id)?.groupId),
    );
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).toEqual(expect.any(String));
    expect(result.byRowId.get('chain-1')?.groupSize).toBe(4);
    expect(result.pendingCount).toBe(4);
  });

  test('keeps forms isolated and counts reviewed members only for membership', async () => {
    const result = await buildFormSubmissionDuplicateReview([
      row('a-reviewed', {
        friendId: 'U_shared',
        reviewedAt: '2026-07-24T11:00:00+09:00',
      }),
      row('a-pending', { friendId: 'U_shared' }),
      row('b-only', { formId: 'form-b', friendId: 'U_shared' }),
      row('no-identity', {
        answersJson: JSON.stringify({ email: ' ', name: '　' }),
      }),
    ], FIELDS);

    expect(result.byRowId.get('a-reviewed')?.groupSize).toBe(2);
    expect(result.byRowId.get('a-pending')?.groupSize).toBe(2);
    expect(result.byRowId.has('b-only')).toBe(false);
    expect(result.byRowId.has('no-identity')).toBe(false);
    expect(result.pendingCount).toBe(1);
  });
});
