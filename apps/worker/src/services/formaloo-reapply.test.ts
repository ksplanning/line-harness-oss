import { describe, expect, test } from 'vitest';
import {
  JP_CUSTOMIZED_TEXTS,
  JP_LOCALIZED_CONTENT,
  DEFAULT_RATING_STAR_COLOR,
  RATING_STAR_CSS_END,
  RATING_STAR_CSS_START,
  type HarnessField,
} from '@line-crm/shared';
import type { FormalooClient, FormalooResult } from './formaloo-client.js';
import { reapplyHostedAppearance, type ReapplyHostedDefinition } from './formaloo-reapply.js';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function fakeClient(opts: {
  form?: Record<string, unknown>;
  fields?: Record<string, Record<string, unknown>>;
  failFormGets?: number;
  failMetaPatch?: boolean;
  ignoreMetaPatch?: boolean;
  ignoreCustomizedTextsPatch?: boolean;
  ignoreFieldPatches?: string[];
} = {}) {
  const calls: Call[] = [];
  const form = clone(opts.form ?? {});
  const fields = new Map(Object.entries(clone(opts.fields ?? {})));
  if (!Array.isArray(form.fields_list)) {
    form.fields_list = [...fields.entries()].map(([slug, field]) => ({ slug, ...clone(field) }));
  }
  let formGets = 0;
  const client = {
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method, path, body: clone(body) });
      if (/^\/v3\.0\/forms\/[^/]+\/$/.test(path)) {
        if (method === 'GET') {
          formGets += 1;
          if (formGets <= (opts.failFormGets ?? 0)) {
            return { ok: false, status: 503, error: 'form GET failed' };
          }
          return { ok: true, status: 200, data: { data: { form: clone(form) } } as T };
        }
        if (method === 'PATCH') {
          if (opts.failMetaPatch) return { ok: false, status: 500, error: 'meta PATCH failed' };
          if (!opts.ignoreMetaPatch) {
            const reflected = clone(body as Record<string, unknown>);
            if (opts.ignoreCustomizedTextsPatch) delete reflected.customized_texts;
            Object.assign(form, reflected);
          }
          return { ok: true, status: 200, data: { data: { form: clone(form) } } as T };
        }
      }

      const fieldMatch = path.match(/^\/v3\.0\/fields\/([^/]+)\/$/);
      if (fieldMatch) {
        const slug = fieldMatch[1]!;
        const current = fields.get(slug);
        if (!current) return { ok: false, status: 404, error: 'field missing' };
        if (method === 'GET') {
          return { ok: true, status: 200, data: { data: { field: clone(current) } } as T };
        }
        if (method === 'PATCH') {
          if (!opts.ignoreFieldPatches?.includes(slug)) {
            Object.assign(current, clone(body as Record<string, unknown>));
            const listed = (form.fields_list as Record<string, unknown>[])
              .find((field) => field.slug === slug);
            if (listed) Object.assign(listed, clone(body as Record<string, unknown>));
          }
          return { ok: true, status: 200, data: { data: { field: clone(current) } } as T };
        }
      }
      return { ok: false, status: 500, error: `unexpected ${method} ${path}` };
    },
  } as unknown as FormalooClient;
  return { client, calls, form, fields };
}

const rating = (id = 'rating-1'): HarnessField => ({
  id, type: 'rating', label: '満足度', required: false, position: 0, config: {},
});

const video = (id: string, url: string, height?: string): HarnessField => ({
  id,
  type: 'video',
  label: '動画',
  required: false,
  position: 1,
  config: { videoUrl: url, ...(height ? { videoHeight: height } : {}) },
});

const fast = { retries: 0, sleep: async () => {} };

describe('reapplyHostedAppearance', () => {
  test('配色・星・文言・日本語・動画高さを管理キーだけで再反映し、foreign CSS/localized/config を保持する', async () => {
    const definition: ReapplyHostedDefinition = {
      fields: [rating(), video('video-1', 'https://youtube.example/watch/new', '350px')],
      design: { backgroundColor: '#111111', buttonColor: '#00FF00', ratingStarColor: '#F5B301' },
      formCopy: { buttonText: '送信' },
      localizationJa: true,
    };
    const before = JSON.stringify(definition);
    const remoteConfig = { height: '100px', autoplay: false, provider: 'youtube' };
    const remoteLogic = [{ when: { operation: 'and' }, actions: [{ action: 'show' }] }];
    const remoteRows = [{ slug: 'answer-1', values: { name: '既存回答' } }];
    const { client, calls, form } = fakeClient({
      form: {
        custom_css: '.foreign{display:block}',
        localized_content: { tenant_banner: '残す', errors: { required: '独自必須文言' } },
        customized_texts: { tenant_label: '残す', nested: { color: 'blue' }, start_btn: 'Start' },
        logic: remoteLogic,
        rows: remoteRows,
      },
      fields: {
        'remote-video': {
          slug: 'remote-video', type: 'oembed', title: '変えない', required: false,
          position: 9, url: 'https://youtube.example/watch/old', config: remoteConfig,
        },
      },
    });

    const result = await reapplyHostedAppearance(client, 'FORM-1', definition, { 'video-1': 'remote-video' }, fast);

    expect(result.ok).toBe(true);
    expect(Object.values(result.parts).every((part) => part.ok)).toBe(true);
    const meta = calls.find((call) => call.method === 'PATCH' && call.path === '/v3.0/forms/FORM-1/');
    expect(Object.keys(meta?.body as Record<string, unknown>).sort()).toEqual([
      'background_color', 'button_color', 'button_text', 'custom_css', 'customized_texts', 'localized_content',
    ]);
    expect(JSON.parse((meta?.body as Record<string, string>).background_color)).toEqual({ r: 17, g: 17, b: 17, a: 1 });
    expect((meta?.body as Record<string, string>).custom_css).toContain('.foreign{display:block}');
    expect((meta?.body as Record<string, string>).custom_css).toContain(RATING_STAR_CSS_START);
    expect((meta?.body as Record<string, string>).custom_css).toContain(RATING_STAR_CSS_END);
    expect((meta?.body as Record<string, unknown>).localized_content).toEqual({
      tenant_banner: '残す', errors: { required: '独自必須文言' }, ...JP_LOCALIZED_CONTENT,
    });
    expect((meta?.body as Record<string, unknown>).customized_texts).toEqual({
      tenant_label: '残す', nested: { color: 'blue' }, ...JP_CUSTOMIZED_TEXTS,
    });
    const videoPatch = calls.find((call) => call.method === 'PATCH' && call.path === '/v3.0/fields/remote-video/');
    expect(videoPatch?.body).toEqual({
      url: 'https://youtube.example/watch/old',
      config: { ...remoteConfig, height: '350px' },
    });
    expect(videoPatch?.body).not.toMatchObject({ type: expect.anything(), title: expect.anything(), position: expect.anything() });
    expect(JSON.stringify(definition)).toBe(before);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(calls.filter((call) => call.method === 'PATCH' && call.path.includes('/forms/'))).toHaveLength(1);
    expect(calls.some((call) => call.method === 'GET' && call.path.includes('/fields/'))).toBe(false);
    const remoteVideo = (form.fields_list as Record<string, unknown>[]).find((field) => field.slug === 'remote-video')!;
    expect(remoteVideo).toMatchObject({
      type: 'oembed', title: '変えない', required: false, position: 9,
      url: 'https://youtube.example/watch/old',
      config: { height: '350px', autoplay: false, provider: 'youtube' },
    });
    expect(form.logic).toEqual(remoteLogic);
    expect(form.rows).toEqual(remoteRows);
  });

  test('localizationJa=false は管理 key だけを除去し、foreign/nested key を残す', async () => {
    const foreign = { tenant_banner: '残す', errors: { required: '独自必須文言' } };
    const customForeign = { tenant_label: '残す', nested: { color: 'blue' } };
    const { client, calls } = fakeClient({ form: {
      localized_content: { ...foreign, ...JP_LOCALIZED_CONTENT },
      customized_texts: { ...customForeign, ...JP_CUSTOMIZED_TEXTS },
    } });

    const result = await reapplyHostedAppearance(
      client,
      'FORM-2',
      { fields: [], localizationJa: false },
      {},
      fast,
    );

    expect(result.ok).toBe(true);
    expect(result.parts.localization).toMatchObject({ ok: true, skipped: false });
    const meta = calls.find((call) => call.method === 'PATCH');
    expect(meta?.body).toEqual({ localized_content: foreign, customized_texts: customForeign });
  });

  test('localizationJa=false で削除対象が無ければ foreign-only state を載せず PATCH を短絡する', async () => {
    const { client, calls } = fakeClient({ form: {
      localized_content: { tenant_banner: '残す' },
      customized_texts: { tenant_label: '残す', nested: { color: 'blue' } },
    } });

    const result = await reapplyHostedAppearance(
      client,
      'FORM-2A',
      { fields: [], localizationJa: false },
      {},
      fast,
    );

    expect(result.ok).toBe(true);
    expect(result.parts.localization).toMatchObject({ ok: true, skipped: false });
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  test('customized_texts のみ soft-200 で無視されたら localization part を fail-closed にする', async () => {
    const { client, calls } = fakeClient({
      form: { localized_content: {}, customized_texts: { foreign: '残す' } },
      ignoreCustomizedTextsPatch: true,
    });

    const result = await reapplyHostedAppearance(
      client,
      'FORM-2B',
      { fields: [], localizationJa: true },
      {},
      fast,
    );

    expect(calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({
      localized_content: JP_LOCALIZED_CONTENT,
      customized_texts: { foreign: '残す', ...JP_CUSTOMIZED_TEXTS },
    });
    expect(result.ok).toBe(false);
    expect(result.parts.localization).toMatchObject({ ok: false, skipped: false });
  });

  test('star/localization の事前 GET 失敗だけを failed にし、独立な design/copy PATCH は続行する', async () => {
    const { client, calls } = fakeClient({ failFormGets: 1 });
    const definition: ReapplyHostedDefinition = {
      fields: [rating()],
      design: { buttonColor: '#00FF00', ratingStarColor: '#F5B301' },
      formCopy: { successMessage: '完了しました' },
      localizationJa: true,
    };

    const result = await reapplyHostedAppearance(client, 'FORM-3', definition, {}, fast);

    expect(result.ok).toBe(false);
    expect(result.parts.color.ok).toBe(true);
    expect(result.parts.copy.ok).toBe(true);
    expect(result.parts.star).toMatchObject({ ok: false, skipped: false });
    expect(result.parts.localization).toMatchObject({ ok: false, skipped: false });
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      button_color: JSON.stringify({ r: 0, g: 255, b: 0, a: 1 }),
      success_message: '完了しました',
    });
  });

  test('meta PATCH の soft-200 は part ごとの GET-after-PATCH 不一致として surface する', async () => {
    const { client } = fakeClient({
      form: { custom_css: '.foreign{}', localized_content: {}, button_color: '#00FF00' },
      ignoreMetaPatch: true,
    });
    const definition: ReapplyHostedDefinition = {
      fields: [rating()],
      design: { buttonColor: '#00FF00', ratingStarColor: '#F5B301' },
      formCopy: { buttonText: '送信' },
      localizationJa: true,
    };

    const result = await reapplyHostedAppearance(client, 'FORM-4', definition, {}, fast);

    expect(result.ok).toBe(false);
    expect(result.parts.color.ok).toBe(false);
    expect(result.parts.star.ok).toBe(false);
    expect(result.parts.copy.ok).toBe(false);
    expect(result.parts.localization.ok).toBe(false);
    expect(result.parts.videoHeight).toMatchObject({ ok: true, skipped: true });
  });

  test('動画の slug 欠落と soft-200 を failedFieldIds に集約し、他動画の処理を止めない', async () => {
    const { client, calls } = fakeClient({
      fields: {
        'remote-v1': { url: 'https://old/1', config: { height: '100px', provider: 'youtube' } },
        'remote-v3': { url: 'https://old/3', config: { height: '100px', provider: 'vimeo' } },
      },
      ignoreFieldPatches: ['remote-v3'],
    });
    const definition: ReapplyHostedDefinition = {
      design: { textColor: '#222222' },
      fields: [
        video('v1', 'https://new/1', '300px'),
        video('v2', 'https://new/2', '320px'),
        video('v3', 'https://new/3', '340px'),
      ],
    };

    const result = await reapplyHostedAppearance(client, 'FORM-5', definition, { v1: 'remote-v1', v3: 'remote-v3' }, fast);

    expect(result.ok).toBe(false);
    expect(result.parts.color).toMatchObject({ ok: true, skipped: false });
    expect(result.parts.videoHeight).toMatchObject({
      ok: false,
      skipped: false,
      failedFieldIds: ['v2', 'v3'],
    });
    expect(calls.some((call) => call.path === '/v3.0/fields/remote-v1/' && call.method === 'PATCH')).toBe(true);
    expect(calls.some((call) => call.path === '/v3.0/fields/remote-v3/' && call.method === 'PATCH')).toBe(true);
    expect(calls.some((call) => call.path.includes('/v3.0/fields/undefined'))).toBe(false);
  });

  test('meta PATCH が非 ok でも動画は続行し、color だけ failed・videoHeight は ok にする', async () => {
    const { client, calls } = fakeClient({
      failMetaPatch: true,
      fields: { rv1: { url: 'https://remote/video', config: { height: '100px', foreign: { fit: 'contain' } } } },
    });

    const result = await reapplyHostedAppearance(
      client,
      'FORM-5B',
      { fields: [video('v1', 'https://definition/ignored', '360px')], design: { textColor: '#222222' } },
      { v1: 'rv1' },
      fast,
    );

    expect(result.ok).toBe(false);
    expect(result.parts.color).toMatchObject({ ok: false, skipped: false });
    expect(result.parts.videoHeight).toMatchObject({ ok: true, skipped: false });
    expect(calls.find((call) => call.method === 'PATCH' && call.path.includes('/fields/'))?.body).toEqual({
      url: 'https://remote/video',
      config: { height: '360px', foreign: { fit: 'contain' } },
    });
  });

  test('localization kill-switch は localization part だけを skip し、design 再反映は継続する', async () => {
    const { client, calls } = fakeClient();
    const result = await reapplyHostedAppearance(
      client,
      'FORM-6',
      { fields: [], design: { textColor: '#222222' }, localizationJa: true },
      {},
      { ...fast, localizationEnabled: false },
    );

    expect(result.ok).toBe(true);
    expect(result.parts.localization).toMatchObject({ ok: true, skipped: true });
    const meta = calls.find((call) => call.method === 'PATCH' && call.path === '/v3.0/forms/FORM-6/');
    expect(meta?.body).toEqual({ text_color: JSON.stringify({ r: 34, g: 34, b: 34, a: 1 }) });
    expect('localized_content' in (meta?.body as Record<string, unknown>)).toBe(false);
    expect('customized_texts' in (meta?.body as Record<string, unknown>)).toBe(false);
  });

  test('同じ定義を二度再反映しても PATCH body は同一で managed CSS が重複しない', async () => {
    const definition: ReapplyHostedDefinition = {
      fields: [rating(), video('v1', 'https://new/video')],
      localizationJa: true,
    };
    const before = JSON.stringify(definition);
    const { client, calls } = fakeClient({
      form: { custom_css: '.foreign{}', localized_content: { foreign: '残す' } },
      fields: { rv1: { url: 'https://old/video', config: { height: '100px', foreign: true } } },
    });

    const first = await reapplyHostedAppearance(client, 'FORM-7', definition, { v1: 'rv1' }, fast);
    const firstMeta = clone(calls.filter((call) => call.method === 'PATCH' && call.path.includes('/forms/')).at(-1)?.body);
    const firstVideo = clone(calls.filter((call) => call.method === 'PATCH' && call.path.includes('/fields/')).at(-1)?.body);
    const second = await reapplyHostedAppearance(client, 'FORM-7', definition, { v1: 'rv1' }, fast);
    const secondMeta = calls.filter((call) => call.method === 'PATCH' && call.path.includes('/forms/')).at(-1)?.body;
    const secondVideo = calls.filter((call) => call.method === 'PATCH' && call.path.includes('/fields/')).at(-1)?.body;

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(secondMeta).toEqual(firstMeta);
    expect(secondVideo).toEqual(firstVideo);
    expect(String((secondMeta as Record<string, unknown>).custom_css).split(RATING_STAR_CSS_START)).toHaveLength(2);
    expect(String((secondMeta as Record<string, unknown>).custom_css)).toContain(DEFAULT_RATING_STAR_COLOR);
    expect(secondVideo).toMatchObject({ url: 'https://old/video', config: { height: '250px', foreign: true } });
    expect('background_color' in (secondMeta as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(definition)).toBe(before);
  });

  test('旧フォーム既定: localizationJa absent / ratingStarColor=null / design色 absent は完全 no-op', async () => {
    const { client, calls } = fakeClient({ form: { custom_css: '.foreign{}', localized_content: { foreign: '残す' } } });

    const result = await reapplyHostedAppearance(
      client,
      'FORM-8',
      { fields: [rating()], design: { ratingStarColor: null } },
      {},
      fast,
    );

    expect(result.ok).toBe(true);
    expect(result.parts.color).toMatchObject({ ok: true, skipped: true });
    expect(result.parts.star).toMatchObject({ ok: true, skipped: true });
    expect(result.parts.localization).toMatchObject({ ok: true, skipped: true });
    expect(calls).toEqual([]);
  });
});
