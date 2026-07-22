// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(workerRoot, '../..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'internal-form-deploy-bundle-'));
const deployBundleRoot = join(temporaryRoot, 'deploy');
const wranglerConfigRoot = join(temporaryRoot, 'wrangler-config');

const renderPublishedFormScript = String.raw`
import { readFile, writeFile } from 'node:fs/promises';

const [bundlePath, outputPath] = process.argv.slice(1);
const bundleSource = await readFile(bundlePath, 'utf8');
const deployed = await import('data:text/javascript;base64,' + Buffer.from(bundleSource).toString('base64'));
const definition = {
  fields: [
    { id: 'kind', type: 'choice', label: '区分', required: true, position: 0, config: { choices: ['個人', '法人'] } },
    { id: 'company', type: 'text', label: '会社名', required: true, position: 1, config: {} },
    {
      id: 'zip', type: 'text', label: '郵便番号', required: true, position: 2,
      config: { postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' } },
    },
    { id: 'pref', type: 'text', label: '都道府県', required: true, position: 3, config: {} },
    { id: 'city', type: 'text', label: '市区町村', required: true, position: 4, config: {} },
    { id: 'town', type: 'text', label: '町域', required: false, position: 5, config: {} },
    {
      id: 'zip-native', type: 'postal_code', label: '専用郵便番号', required: true, position: 6,
      config: { postalAutofill: { zipField: 'zip-native', prefField: 'pref-native', cityField: 'city-native', townField: 'town-native' } },
    },
    { id: 'pref-native', type: 'prefecture', label: '専用都道府県', required: true, position: 7, config: {} },
    { id: 'city-native', type: 'address_city', label: '専用市区町村', required: true, position: 8, config: {} },
    { id: 'town-native', type: 'address_street', label: '専用町名・番地', required: false, position: 9, config: {} },
  ],
  logic: [
    { id: 'show-company', sourceFieldId: 'kind', operator: 'equals', value: '法人', action: 'show', targetFieldId: 'company' },
  ],
  formType: 'simple',
};
const form = {
  id: 'bundle-logic-form',
  title: '分岐テスト',
  description: null,
  definition_json: JSON.stringify(definition),
  deleted: 0,
  render_backend: 'internal',
  builder_status: 'published',
  submit_message: null,
  line_account_id: null,
};
const db = {
  prepare(sql) {
    let args = [];
    const statement = {
      bind(...values) { args = values; return statement; },
      async first() {
        if (sql === 'SELECT * FROM formaloo_forms WHERE id = ?') return args[0] === form.id ? form : null;
        if (sql.includes('COUNT(*) AS n FROM internal_form_submissions')) return { n: 0 };
        throw new Error('Unexpected query: ' + sql);
      },
      async all() { return { results: [] }; },
      async run() { return { meta: { changes: 0 } }; },
    };
    return statement;
  },
};
const response = await deployed.app.request('/f/' + form.id, {}, {
  DB: db,
  FORMALOO_FRIEND_TOKEN_SECRET: 'bundle-test-secret',
});
if (response.status !== 200) throw new Error('Unexpected form response: ' + response.status);
await writeFile(outputPath, await response.text(), 'utf8');
`;

let publishedHtml = '';

beforeAll(() => {
  mkdirSync(deployBundleRoot);
  mkdirSync(wranglerConfigRoot);
  execFileSync('pnpm', ['--filter', 'worker...', 'build'], {
    cwd: repoRoot,
    env: { ...process.env, XDG_CONFIG_HOME: wranglerConfigRoot },
    stdio: 'pipe',
  });
  execFileSync('pnpm', [
    'exec', 'wrangler', 'deploy', 'dist/line_harness/index.js',
    '--config', 'wrangler.piecemaker.toml',
    '--dry-run', '--outdir', deployBundleRoot,
  ], {
    cwd: workerRoot,
    env: { ...process.env, XDG_CONFIG_HOME: wranglerConfigRoot, WRANGLER_SEND_METRICS: 'false' },
    stdio: 'pipe',
  });

  const renderedPage = join(temporaryRoot, 'published-form.html');
  execFileSync(process.execPath, [
    '--input-type=module', '--eval', renderPublishedFormScript,
    join(deployBundleRoot, 'index.js'), renderedPage,
  ], { cwd: repoRoot, stdio: 'pipe' });
  publishedHtml = readFileSync(renderedPage, 'utf8');
}, 90_000);

afterAll(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('deployed internal form logic bundle', () => {
  test('executes the delivered client and applies choice show/hide after a real change event', async () => {
    const parsed = new DOMParser().parseFromString(publishedHtml, 'text/html');
    document.body.innerHTML = parsed.body.innerHTML;

    const externalClient = parsed.querySelector<HTMLScriptElement>('script[data-internal-form-logic-client]');
    if (externalClient?.getAttribute('src')) {
      const assetPath = resolve(workerRoot, 'dist/client', externalClient.getAttribute('src')!.replace(/^\//, ''));
      await import(`${pathToFileURL(assetPath).href}?bundle-test=${Date.now()}`);
    } else {
      const inlineClient = Array.from(parsed.querySelectorAll('script'))
        .find((script) => script.textContent?.includes('evaluateInternalFormLogic'));
      expect(inlineClient, 'deployed inline logic client').toBeTruthy();
      window.eval(inlineClient!.textContent ?? '');
    }

    expect(externalClient?.getAttribute('src')).toBe('/assets/internal-form-logic.js');
    const company = document.querySelector<HTMLElement>('[data-field-id="company"]')!;
    const corporate = document.querySelector<HTMLInputElement>('input[value="法人"]')!;
    expect(company.hidden).toBe(true);

    corporate.checked = true;
    corporate.dispatchEvent(new Event('change', { bubbles: true }));

    expect(company.hidden).toBe(false);
    expect(company.querySelector<HTMLInputElement>('input')!.disabled).toBe(false);

    expect(Array.from(parsed.querySelectorAll('script'))
      .some((script) => script.textContent?.includes('postal lookup failed'))).toBe(false);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ pref: '東京都', city: '千代田区', town: '千代田' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const zip = document.querySelector<HTMLInputElement>('[data-answer-field="zip"]')!;
    const rawZip = '１－２ー３−４‐５‑６-７';
    zip.value = rawZip;
    document.querySelector<HTMLButtonElement>('.postal-lookup')!.click();

    await vi.waitFor(() => expect(document.querySelector('.postal-status')?.textContent).toBe('住所を入力しました'));
    expect(fetchMock).toHaveBeenCalledWith('/api/postal-lookup?zip=1234567', expect.any(Object));
    expect(zip.value).toBe(rawZip);
    expect(document.querySelector<HTMLInputElement>('[data-answer-field="pref"]')!.value).toBe('東京都');

    const nativeZip = document.querySelector<HTMLInputElement>('[data-answer-field="zip-native"]')!;
    const nativeRawZip = '５６９－００００';
    nativeZip.value = nativeRawZip;
    document.querySelector<HTMLButtonElement>('[data-zip-field="zip-native"]')!.click();

    await vi.waitFor(() => expect(
      document.querySelector<HTMLSelectElement>('[data-answer-field="pref-native"]')!.value,
    ).toBe('東京都'));
    expect(fetchMock).toHaveBeenCalledWith('/api/postal-lookup?zip=5690000', expect.any(Object));
    expect(nativeZip.value).toBe(nativeRawZip);
    expect(document.querySelector<HTMLSelectElement>('[data-answer-field="pref-native"]')!.value).toBe('東京都');
    expect(document.querySelector<HTMLInputElement>('[data-answer-field="city-native"]')!.value).toBe('千代田区');
    expect(document.querySelector<HTMLInputElement>('[data-answer-field="town-native"]')!.value).toBe('千代田');
  });
});
