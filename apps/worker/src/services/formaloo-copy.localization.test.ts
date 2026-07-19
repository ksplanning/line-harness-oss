import { describe, expect, test, vi } from 'vitest';
import { JP_CUSTOMIZED_TEXTS, JP_LOCALIZED_CONTENT } from '@line-crm/shared';
import {
  confirmLocalizedContentReflected,
  localizedContentFields,
} from './formaloo-copy';
import type { FormalooClient } from './formaloo-client';

function okForm(form: Record<string, unknown>) {
  return { ok: true as const, status: 200, data: { data: { form } } };
}

function getClient(results: Array<ReturnType<typeof okForm> | { ok: false; status: number; error: string }>) {
  const request = vi.fn(async () => results.shift() ?? { ok: false as const, status: 500, error: 'fixture exhausted' });
  return { request } as unknown as FormalooClient & { request: ReturnType<typeof vi.fn> };
}

describe('localizedContentFields (GET-merge 非破壊)', () => {
  test('ON は localized_content/customized_texts の foreign/nested key を保持し、combined defaults を merge 元にしない', async () => {
    const current = {
      tenant_banner: 'foreign',
      errors: { invalid_field_error: 'custom error' },
    };
    const customized = {
      start_btn: 'Start',
      tenant_label: 'foreign custom',
      nested: { color: 'blue' },
    };
    const client = getClient([okForm({
      localized_content: current,
      customized_texts: customized,
      combined_localized_content: { back_btn: 'Back', default_only: 'must-not-copy' },
    })]);

    await expect(localizedContentFields(client, 'slug-on', true)).resolves.toEqual({
      localized_content: { ...current, ...JP_LOCALIZED_CONTENT },
      customized_texts: { ...customized, ...JP_CUSTOMIZED_TEXTS },
    });
    expect(client.request).toHaveBeenCalledWith('GET', '/v3.0/forms/slug-on/');
  });

  test('OFF は管理 key だけを remove し foreign key を保持する', async () => {
    const client = getClient([okForm({
      localized_content: {
        tenant_banner: 'foreign',
        errors: { invalid_field_error: 'custom error' },
        ...JP_LOCALIZED_CONTENT,
      },
      customized_texts: {
        tenant_label: 'foreign custom',
        nested: { color: 'blue' },
        ...JP_CUSTOMIZED_TEXTS,
      },
    })]);

    await expect(localizedContentFields(client, 'slug-off', false)).resolves.toEqual({
      localized_content: {
        tenant_banner: 'foreign',
        errors: { invalid_field_error: 'custom error' },
      },
      customized_texts: {
        tenant_label: 'foreign custom',
        nested: { color: 'blue' },
      },
    });
  });

  test('既に目的状態なら {} を返して PATCH を短絡し、GET 失敗時も foreign clobber を避けて {}', async () => {
    const alreadyOn = getClient([okForm({
      localized_content: { ...JP_LOCALIZED_CONTENT },
      customized_texts: { ...JP_CUSTOMIZED_TEXTS },
    })]);
    await expect(localizedContentFields(alreadyOn, 'same', true)).resolves.toEqual({});

    const alreadyOff = getClient([okForm({
      localized_content: { tenant_banner: 'foreign' },
      customized_texts: { tenant_label: 'foreign', nested: { color: 'blue' } },
    })]);
    await expect(localizedContentFields(alreadyOff, 'same-off', false)).resolves.toEqual({});

    const failed = getClient([{ ok: false, status: 503, error: 'unavailable' }]);
    await expect(localizedContentFields(failed, 'failed', true)).resolves.toEqual({});
  });

  test('localized_content が既に一致していても customized_texts のみ不一致なら必要な container だけ返す', async () => {
    const client = getClient([okForm({
      localized_content: { ...JP_LOCALIZED_CONTENT },
      customized_texts: { foreign: 'keep', start_btn: 'Start', continue_btn: 'Continue' },
    })]);

    await expect(localizedContentFields(client, 'custom-only', true)).resolves.toEqual({
      customized_texts: { foreign: 'keep', ...JP_CUSTOMIZED_TEXTS },
    });
  });
});

describe('confirmLocalizedContentReflected (soft-200 honest surface)', () => {
  const noSleep = () => Promise.resolve();

  test('ON は管理 key 全件一致、OFF は管理 key 全件不在なら ok', async () => {
    const onClient = getClient([okForm({
      localized_content: { tenant_banner: 'foreign', ...JP_LOCALIZED_CONTENT },
      customized_texts: { tenant_label: 'foreign', ...JP_CUSTOMIZED_TEXTS },
    })]);
    await expect(confirmLocalizedContentReflected(onClient, 'on', true, { retries: 0, sleep: noSleep }))
      .resolves.toEqual({ ok: true });

    const offClient = getClient([okForm({
      localized_content: { tenant_banner: 'foreign' },
      customized_texts: { tenant_label: 'foreign' },
    })]);
    await expect(confirmLocalizedContentReflected(offClient, 'off', false, { retries: 0, sleep: noSleep }))
      .resolves.toEqual({ ok: true });
  });

  test('ON の値不一致と OFF の管理 key 残存は ok:false で key を surface する', async () => {
    const onClient = getClient([okForm({
      localized_content: { ...JP_LOCALIZED_CONTENT, next_btn: 'Next' },
      customized_texts: { ...JP_CUSTOMIZED_TEXTS },
    })]);
    const onResult = await confirmLocalizedContentReflected(onClient, 'bad-on', true, { retries: 0, sleep: noSleep });
    expect(onResult.ok).toBe(false);
    expect(onResult.error).toContain('next_btn');

    const offClient = getClient([okForm({
      localized_content: { back_btn: '戻る' },
      customized_texts: {},
    })]);
    const offResult = await confirmLocalizedContentReflected(offClient, 'bad-off', false, { retries: 0, sleep: noSleep });
    expect(offResult.ok).toBe(false);
    expect(offResult.error).toContain('back_btn');
  });

  test('customized_texts が soft-200 で未反映なら localized_content 一致でも ok:false', async () => {
    const client = getClient([okForm({
      localized_content: { ...JP_LOCALIZED_CONTENT },
      customized_texts: { ...JP_CUSTOMIZED_TEXTS, continue_btn: 'Continue' },
    })]);

    const result = await confirmLocalizedContentReflected(client, 'bad-custom', true, { retries: 0, sleep: noSleep });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('customized_texts.continue_btn');
  });

  test('GET 失敗は false、bounded retry は後続一致で true', async () => {
    const failed = getClient([{ ok: false, status: 500, error: 'boom' }]);
    await expect(confirmLocalizedContentReflected(failed, 'failed', true, { retries: 0, sleep: noSleep }))
      .resolves.toMatchObject({ ok: false });

    const retry = getClient([
      okForm({ localized_content: {}, customized_texts: {} }),
      okForm({
        localized_content: { ...JP_LOCALIZED_CONTENT },
        customized_texts: { ...JP_CUSTOMIZED_TEXTS },
      }),
    ]);
    await expect(confirmLocalizedContentReflected(retry, 'retry', true, { retries: 1, sleep: noSleep }))
      .resolves.toEqual({ ok: true });
    expect(retry.request).toHaveBeenCalledTimes(2);
  });
});
