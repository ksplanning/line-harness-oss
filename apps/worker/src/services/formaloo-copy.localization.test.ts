import { describe, expect, test, vi } from 'vitest';
import { JP_LOCALIZED_CONTENT } from '@line-crm/shared';
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
  test('ON は localized_content の foreign/nested key を保持し、combined defaults を merge 元にしない', async () => {
    const current = {
      tenant_banner: 'foreign',
      errors: { invalid_field_error: 'custom error' },
    };
    const client = getClient([okForm({
      localized_content: current,
      combined_localized_content: { back_btn: 'Back', default_only: 'must-not-copy' },
    })]);

    await expect(localizedContentFields(client, 'slug-on', true)).resolves.toEqual({
      localized_content: { ...current, ...JP_LOCALIZED_CONTENT },
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
    })]);

    await expect(localizedContentFields(client, 'slug-off', false)).resolves.toEqual({
      localized_content: {
        tenant_banner: 'foreign',
        errors: { invalid_field_error: 'custom error' },
      },
    });
  });

  test('既に目的状態なら {} を返して PATCH を短絡し、GET 失敗時も foreign clobber を避けて {}', async () => {
    const alreadyOn = getClient([okForm({ localized_content: { ...JP_LOCALIZED_CONTENT } })]);
    await expect(localizedContentFields(alreadyOn, 'same', true)).resolves.toEqual({});

    const failed = getClient([{ ok: false, status: 503, error: 'unavailable' }]);
    await expect(localizedContentFields(failed, 'failed', true)).resolves.toEqual({});
  });
});

describe('confirmLocalizedContentReflected (soft-200 honest surface)', () => {
  const noSleep = () => Promise.resolve();

  test('ON は管理 key 全件一致、OFF は管理 key 全件不在なら ok', async () => {
    const onClient = getClient([okForm({ localized_content: { tenant_banner: 'foreign', ...JP_LOCALIZED_CONTENT } })]);
    await expect(confirmLocalizedContentReflected(onClient, 'on', true, { retries: 0, sleep: noSleep }))
      .resolves.toEqual({ ok: true });

    const offClient = getClient([okForm({ localized_content: { tenant_banner: 'foreign' } })]);
    await expect(confirmLocalizedContentReflected(offClient, 'off', false, { retries: 0, sleep: noSleep }))
      .resolves.toEqual({ ok: true });
  });

  test('ON の値不一致と OFF の管理 key 残存は ok:false で key を surface する', async () => {
    const onClient = getClient([okForm({ localized_content: { ...JP_LOCALIZED_CONTENT, next_btn: 'Next' } })]);
    const onResult = await confirmLocalizedContentReflected(onClient, 'bad-on', true, { retries: 0, sleep: noSleep });
    expect(onResult.ok).toBe(false);
    expect(onResult.error).toContain('next_btn');

    const offClient = getClient([okForm({ localized_content: { back_btn: '戻る' } })]);
    const offResult = await confirmLocalizedContentReflected(offClient, 'bad-off', false, { retries: 0, sleep: noSleep });
    expect(offResult.ok).toBe(false);
    expect(offResult.error).toContain('back_btn');
  });

  test('GET 失敗は false、bounded retry は後続一致で true', async () => {
    const failed = getClient([{ ok: false, status: 500, error: 'boom' }]);
    await expect(confirmLocalizedContentReflected(failed, 'failed', true, { retries: 0, sleep: noSleep }))
      .resolves.toMatchObject({ ok: false });

    const retry = getClient([
      okForm({ localized_content: {} }),
      okForm({ localized_content: { ...JP_LOCALIZED_CONTENT } }),
    ]);
    await expect(confirmLocalizedContentReflected(retry, 'retry', true, { retries: 1, sleep: noSleep }))
      .resolves.toEqual({ ok: true });
    expect(retry.request).toHaveBeenCalledTimes(2);
  });
});
