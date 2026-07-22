// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { initInternalFormLogic } from '../client/internal-form-logic.js';
import { internalFormsPublic } from './internal-forms-public.js';
import type { Env } from '../index.js';

const definitionJson = JSON.stringify({
  fields: [
    {
      id: 'zip', type: 'text', label: '郵便番号', required: true, position: 0,
      config: { postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' } },
    },
    { id: 'pref', type: 'text', label: '都道府県', required: true, position: 1, config: {} },
    { id: 'city', type: 'text', label: '市区町村', required: true, position: 2, config: {} },
    { id: 'town', type: 'text', label: '町域', required: false, position: 3, config: {} },
  ],
  logic: [],
});

const form = {
  id: 'postal-form',
  title: '住所入力',
  description: null,
  definition_json: definitionJson,
  deleted: 0,
  render_backend: 'internal',
  builder_status: 'published',
  submit_message: null,
  line_account_id: null,
};
const originalDefinitionJson = form.definition_json;

function db(): D1Database {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async first<T>() {
          if (sql === 'SELECT * FROM formaloo_forms WHERE id = ?') {
            return (args[0] === form.id ? form : null) as T | null;
          }
          if (sql.includes('COUNT(*) AS n FROM internal_form_submissions')) return { n: 0 } as T;
          throw new Error(`Unexpected query: ${sql}`);
        },
        async all<T>() { return { results: [] as T[] }; },
        async run() { return { meta: { changes: 0 } }; },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function env(): Env['Bindings'] {
  return {
    DB: db(),
    FORMALOO_FRIEND_TOKEN_SECRET: 'postal-client-test',
  } as Env['Bindings'];
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

async function mountPostalPage(initialValues: Partial<Record<'zip' | 'pref' | 'city' | 'town', string>> = {}) {
  const app = new Hono<Env>();
  app.route('/', internalFormsPublic);
  const response = await app.request('/f/postal-form', {}, env());
  expect(response.status).toBe(200);

  const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
  const client = parsed.querySelector<HTMLScriptElement>('script[data-internal-form-logic-client]');
  expect(client?.getAttribute('src'), '郵便番号補完のクライアントasset').toBe('/assets/internal-form-logic.js');
  expect(Array.from(parsed.querySelectorAll('script'))
    .some((candidate) => candidate.textContent?.includes('postal lookup failed'))).toBe(false);

  document.body.innerHTML = parsed.body.innerHTML;
  for (const [id, value] of Object.entries(initialValues)) {
    const control = document.querySelector(`[data-answer-field="${id}"]`) as HTMLInputElement | null;
    if (control) control.value = value;
  }
  initInternalFormLogic();

  const input = (id: string) => document.querySelector(`[data-answer-field="${id}"]`) as HTMLInputElement;
  return {
    button: document.querySelector('.postal-lookup') as HTMLButtonElement,
    status: document.querySelector('.postal-status') as HTMLParagraphElement,
    zip: input('zip'),
    pref: input('pref'),
    city: input('city'),
    town: input('town'),
  };
}

async function mountCombinedPostalPage() {
  form.definition_json = JSON.stringify({
    fields: [
      {
        id: 'zip', type: 'postal_code', label: '郵便番号', required: true, position: 0,
        config: { postalAutofill: { mode: 'combined', zipField: 'zip', addressField: 'address' } },
      },
      { id: 'address', type: 'address', label: '住所', required: true, position: 1, config: {} },
    ],
    logic: [],
  });
  const app = new Hono<Env>();
  app.route('/', internalFormsPublic);
  const response = await app.request('/f/postal-form', {}, env());
  expect(response.status).toBe(200);

  const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  initInternalFormLogic();

  return {
    button: document.querySelector('.postal-lookup') as HTMLButtonElement,
    status: document.querySelector('.postal-status') as HTMLParagraphElement,
    zip: document.querySelector('[data-answer-field="zip"]') as HTMLInputElement,
    address: document.querySelector('[data-answer-field="address"]') as HTMLTextAreaElement,
  };
}

afterEach(() => {
  form.definition_json = originalDefinitionJson;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('internal form postal autofill client', () => {
  test('生成 HTML の button と aria-live を使い、郵便番号を正規化して住所を入力する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
      pref: '大阪府', city: '高槻市', town: '町域A',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controls = await mountPostalPage();

    expect(controls.button.tagName).toBe('BUTTON');
    expect(controls.button.type).toBe('button');
    expect(controls.button.tabIndex).toBe(0);
    expect(controls.status.getAttribute('aria-live')).toBe('polite');

    controls.zip.value = '569-0000';
    controls.button.click();

    await vi.waitFor(() => expect(controls.status.textContent).toBe('住所を入力しました'));
    expect(fetchMock).toHaveBeenCalledWith('/api/postal-lookup?zip=5690000', expect.objectContaining({
      signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json' },
    }));
    expect(controls.pref.value).toBe('大阪府');
    expect(controls.city.value).toBe('高槻市');
    expect(controls.town.value).toBe('町域A');
    expect(controls.button.disabled).toBe(false);
  });

  test('全角数字と全ハイフン変種を検索用だけ半角7桁にし、入力欄は書き換えない', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
      pref: '東京都', city: '千代田区', town: '千代田',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controls = await mountPostalPage();
    const rawZip = '１－２ー３−４‐５‑６-７';

    controls.zip.value = rawZip;
    controls.button.click();

    await vi.waitFor(() => expect(controls.status.textContent).toBe('住所を入力しました'));
    expect(fetchMock).toHaveBeenCalledWith('/api/postal-lookup?zip=1234567', expect.any(Object));
    expect(controls.zip.value).toBe(rawZip);
    expect(controls.pref.value).toBe('東京都');
  });

  test('変換後も7桁数字でない入力は推測せず従来エラーにし、APIを呼ばない', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controls = await mountPostalPage();
    const rawZip = '１２３－４５Ａ７';

    controls.zip.value = rawZip;
    controls.button.click();

    expect(controls.status.textContent).toBe('郵便番号は半角数字7桁で入力してください');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(controls.zip.value).toBe(rawZip);
    expect(document.activeElement).toBe(controls.zip);
  });

  test('既に入力された住所は上書きせず、空欄だけを補完する', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      pref: '大阪府', city: '高槻市', town: '町域A',
    })));
    const controls = await mountPostalPage();
    controls.zip.value = '5690000';
    controls.pref.value = '京都府';
    controls.town.value = '手入力済み';

    controls.button.click();

    await vi.waitFor(() => expect(controls.status.textContent).toBe('住所を入力しました'));
    expect(controls.pref.value).toBe('京都府');
    expect(controls.city.value).toBe('高槻市');
    expect(controls.town.value).toBe('手入力済み');
  });

  test('郵便番号を訂正した再検索は前回の自動入力値だけ更新し、手修正は保持する', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { pref: '大阪府', city: '高槻市', town: '旧町域' }))
      .mockResolvedValueOnce(jsonResponse(200, { pref: '東京都', city: '新宿区', town: '新宿' }));
    vi.stubGlobal('fetch', fetchMock);
    const controls = await mountPostalPage();
    controls.zip.value = '5690000';
    controls.button.click();
    await vi.waitFor(() => expect(controls.status.textContent).toBe('住所を入力しました'));
    expect(controls.pref.value).toBe('大阪府');

    controls.city.value = '利用者が手修正';
    controls.city.dispatchEvent(new Event('input', { bubbles: true }));
    controls.town.value = '';
    controls.town.dispatchEvent(new Event('input', { bubbles: true }));
    controls.zip.value = '1600022';
    controls.zip.dispatchEvent(new Event('input', { bubbles: true }));

    expect(controls.status.textContent).toContain('郵便番号が変更されました');
    controls.button.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controls.status.textContent).toBe('住所を入力しました'));

    expect(controls.pref.value).toBe('東京都');
    expect(controls.city.value).toBe('利用者が手修正');
    expect(controls.town.value).toBe('');
  });

  test('一括は連結住所を住所欄へ入れ、追記した手入力を再検索でも保持する', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { pref: '大阪府', city: '高槻市', town: '町域A' }))
      .mockResolvedValueOnce(jsonResponse(200, { pref: '東京都', city: '新宿区', town: '新宿' }));
    vi.stubGlobal('fetch', fetchMock);
    const controls = await mountCombinedPostalPage();

    expect(controls.address).toBeInstanceOf(HTMLTextAreaElement);
    controls.zip.value = '5690000';
    controls.button.click();

    await vi.waitFor(() => expect(controls.status.textContent).toBe('住所を入力しました'));
    expect(controls.address.value).toBe('大阪府高槻市町域A');

    controls.address.value += '1-2-3 テストビル';
    controls.address.dispatchEvent(new Event('input', { bubbles: true }));
    expect(controls.address.value).toBe('大阪府高槻市町域A1-2-3 テストビル');

    controls.zip.value = '1600022';
    controls.zip.dispatchEvent(new Event('input', { bubbles: true }));
    controls.button.click();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controls.status.textContent).toBe('住所を入力しました'));
    expect(controls.address.value).toBe('大阪府高槻市町域A1-2-3 テストビル');
  });

  test('400 再表示で復元された住所も、郵便番号を訂正して検索すれば更新できる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      pref: '東京都', city: '新宿区', town: '新宿',
    })));
    const controls = await mountPostalPage({
      zip: '5690000', pref: '大阪府', city: '高槻市', town: '旧町域',
    });

    controls.zip.value = '1600022';
    controls.zip.dispatchEvent(new Event('input', { bubbles: true }));
    controls.button.click();

    await vi.waitFor(() => expect(controls.status.textContent).toBe('住所を入力しました'));
    expect(controls.pref.value).toBe('東京都');
    expect(controls.city.value).toBe('新宿区');
    expect(controls.town.value).toBe('新宿');
  });

  test('400 再表示で復元された手入力住所は、同じ郵便番号の再検索で上書きしない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      pref: '大阪府', city: '高槻市', town: '町域A',
    })));
    const controls = await mountPostalPage({
      zip: '5690000', pref: '京都府', city: '利用者が手入力', town: '番地まで入力済み',
    });

    controls.button.click();

    await vi.waitFor(() => expect(controls.status.textContent).toBe('住所を入力しました'));
    expect(controls.pref.value).toBe('京都府');
    expect(controls.city.value).toBe('利用者が手入力');
    expect(controls.town.value).toBe('番地まで入力済み');
  });

  test('1問ずつ表示では必須の複数選択を空のまま次へ進めない', async () => {
    form.definition_json = JSON.stringify({
      fields: [
        {
          id: 'interests', type: 'multiple_select', label: '興味', required: true, position: 0,
          config: { choices: ['A', 'B'] },
        },
        { id: 'next', type: 'text', label: '次の質問', required: false, position: 1, config: {} },
      ],
      logic: [],
      formType: 'multi_step',
    });
    const app = new Hono<Env>();
    app.route('/', internalFormsPublic);
    const response = await app.request('/f/postal-form', {}, env());
    const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
    expect(parsed.querySelector('[data-internal-form-logic-config]'), '分岐クライアント設定').toBeTruthy();
    document.body.innerHTML = parsed.body.innerHTML;
    initInternalFormLogic();

    const button = document.querySelector('[data-submit]') as HTMLButtonElement;
    expect(button.textContent).toBe('次へ');
    button.click();

    expect((document.querySelector('[data-field-id="interests"]') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('[data-field-id="next"]') as HTMLElement).hidden).toBe(true);
  });

  test('1問ずつ表示では繰り返し列テンプレートと装飾を空の質問として扱わない', async () => {
    form.definition_json = JSON.stringify({
      fields: [
        {
          id: 'repeat', type: 'repeating_section', label: '参加者', required: false, position: 0,
          config: {
            repeatingColumns: [{ columnField: 'participant', title: '参加者名' }],
            minRows: 0,
            maxRows: 3,
          },
        },
        { id: 'participant', type: 'text', label: '参加者名の型', required: false, position: 1, config: {} },
        { id: 'video', type: 'video', label: '説明動画', required: false, position: 2, config: { videoUrl: 'https://example.test/video' } },
        { id: 'image', type: 'image', label: '説明画像', required: false, position: 3, config: { imageUrl: 'https://example.test/image.png' } },
        { id: 'next', type: 'text', label: '次の質問', required: false, position: 4, config: {} },
      ],
      logic: [],
      formType: 'multi_step',
    });
    const app = new Hono<Env>();
    app.route('/', internalFormsPublic);
    const response = await app.request('/f/postal-form', {}, env());
    const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
    expect(parsed.querySelector('[data-internal-form-logic-config]'), '分岐クライアント設定').toBeTruthy();
    document.body.innerHTML = parsed.body.innerHTML;
    for (const wrapper of document.querySelectorAll('[data-field-id]')) {
      (wrapper as HTMLElement).scrollIntoView = vi.fn();
    }
    initInternalFormLogic();

    expect(document.querySelector('[data-field-id="participant"]')).toBeNull();
    const button = document.querySelector('[data-submit]') as HTMLButtonElement;
    expect(button.textContent).toBe('次へ');
    button.click();

    expect((document.querySelector('[data-field-id="repeat"]') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('[data-field-id="video"]') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('[data-field-id="image"]') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('[data-field-id="next"]') as HTMLElement).hidden).toBe(false);
  });

  test.each([
    [400, '郵便番号は半角数字7桁で入力してください'],
    [404, '住所が見つかりませんでした'],
    [409, '住所候補が複数あります。住所を直接入力してください'],
    [429, '検索が混み合っています。少し待ってからお試しください'],
    [503, '住所検索を一時的に利用できません。住所を直接入力してください'],
    [500, '住所検索に失敗しました。住所を直接入力してください'],
  ])('API %i は状態ごとの正直なメッセージを読み上げ領域に出す', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, { error: 'not exposed' })));
    const controls = await mountPostalPage();
    controls.zip.value = '5690000';

    controls.button.click();

    await vi.waitFor(() => expect(controls.status.textContent).toBe(message));
    expect(controls.button.disabled).toBe(false);
  });

  test('検索中に郵便番号を変えたら abort し、古い応答で住所を入れない', async () => {
    let resolveFirst!: (response: Response) => void;
    let firstSignal: AbortSignal | null | undefined;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        firstSignal = init?.signal;
        return first;
      })
      .mockResolvedValueOnce(jsonResponse(200, { pref: '東京都', city: '新宿区', town: '新宿' }));
    vi.stubGlobal('fetch', fetchMock);
    const controls = await mountPostalPage();
    controls.zip.value = '5690000';
    controls.button.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    controls.zip.value = '1600022';
    controls.zip.dispatchEvent(new Event('input', { bubbles: true }));

    expect(firstSignal?.aborted).toBe(true);
    expect(controls.button.disabled).toBe(false);
    expect(controls.status.textContent).toContain('郵便番号が変更されました');
    controls.button.click();
    await vi.waitFor(() => expect(controls.status.textContent).toBe('住所を入力しました'));
    expect(controls.pref.value).toBe('東京都');

    resolveFirst(jsonResponse(200, { pref: '大阪府', city: '高槻市', town: '町域A' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(controls.pref.value).toBe('東京都');
    expect(controls.city.value).toBe('新宿区');
  });

  test('応答 body の読込中に郵便番号が変わっても stale 住所を入れない', async () => {
    let resolveAddress!: (address: unknown) => void;
    const address = new Promise<unknown>((resolve) => { resolveAddress = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockReturnValue(address),
    } as unknown as Response));
    const controls = await mountPostalPage();
    controls.zip.value = '5690000';
    controls.button.click();
    await vi.waitFor(() => expect(controls.status.textContent).toBe('住所を検索しています'));

    controls.zip.value = '1600022';
    controls.zip.dispatchEvent(new Event('input', { bubbles: true }));
    resolveAddress({ pref: '大阪府', city: '高槻市', town: '町域A' });

    await Promise.resolve();
    await Promise.resolve();
    expect(controls.pref.value).toBe('');
    expect(controls.city.value).toBe('');
    expect(controls.town.value).toBe('');
  });
});
