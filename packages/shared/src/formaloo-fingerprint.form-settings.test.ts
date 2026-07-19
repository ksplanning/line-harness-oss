/**
 * treasure-b2-form-settings (D-4) — form-level 運用設定の fingerprint 射影。
 * 未設定 / Formaloo 既定 false|null は従来 SHA と同一、管理対象の実値だけが additive に差分となる。
 */
import { describe, expect, it } from 'vitest';
import { canonicalDefinitionProjection, formalooDefinitionFingerprint } from './formaloo-fingerprint';

const REAL_FORM = {
  has_recaptcha: true,
  accept_draft_answers: true,
  max_submit_count: 100,
  max_submit_per_ip_per_day: 3,
  submit_start_time: '2026-07-20T00:00:00Z',
  submit_end_time: '2026-08-20T00:00:00Z',
  time_limit: '00:10:00',
};

describe('B2 fingerprint — form settings 射影 + 既定値ガード (D-4)', () => {
  it('管理対象の実キーだけを canonical formSettings へ射影する', () => {
    const projected = canonicalDefinitionProjection([], [], { data: { form: REAL_FORM } }) as unknown as Record<string, unknown>;
    expect(projected.formSettings).toEqual({
      hasRecaptcha: true,
      acceptDraftAnswers: true,
      maxSubmitCount: 100,
      submitStartTime: '2026-07-20T00:00:00Z',
      submitEndTime: '2026-08-20T00:00:00Z',
    });
  });

  it('未設定と false|null の実 API 既定形は同一 SHA (既存フォーム false-drift ゼロ)', async () => {
    const before = await formalooDefinitionFingerprint([], []);
    const withDefaults = await formalooDefinitionFingerprint([], [], {
      data: {
        form: {
          has_recaptcha: false,
          accept_draft_answers: false,
          max_submit_count: null,
          max_submit_per_ip_per_day: null,
          submit_start_time: null,
          submit_end_time: null,
          time_limit: null,
        },
      },
    });
    expect(withDefaults).toBe(before);
  });

  it('管理対象設定が変わると SHA が変わる', async () => {
    const before = await formalooDefinitionFingerprint([], []);
    expect(await formalooDefinitionFingerprint([], [], { data: { form: REAL_FORM } })).not.toBe(before);
  });

  it('soft-200 で無視される誤キーと今回 UI 非管理のキーだけでは SHA を変えない', async () => {
    const before = await formalooDefinitionFingerprint([], []);
    const ignored = await formalooDefinitionFingerprint([], [], {
      data: {
        form: {
          max_responses: 100,
          submission_limit: 100,
          start_date: '2026-07-20T00:00:00Z',
          end_date: '2026-08-20T00:00:00Z',
          expire_date: '2026-08-20T00:00:00Z',
          max_submit_per_ip_per_day: 3,
          time_limit: '00:10:00',
        },
      },
    });
    expect(ignored).toBe(before);
  });
});
