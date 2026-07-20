import { describe, expect, test } from 'vitest';
import { verifyEditToken } from './formaloo-edit-token.js';
import { createInternalFormEditUrl } from './internal-form-edit.js';

const NOW = 1_786_800_000;
const SECRET = 'internal-form-edit-test-secret';

describe('createInternalFormEditUrl', () => {
  test('signs the internal form and submission binding and uses the existing edit-token expiry rail', async () => {
    const editUrl = await createInternalFormEditUrl({
      publicBaseUrl: 'https://worker.example.test/base/path',
      formId: 'form-1',
      submissionId: 'ifs-1',
      editLinkEpoch: 7,
      secret: SECRET,
      nowSec: NOW,
    });

    expect(editUrl).not.toBeNull();
    const url = new URL(editUrl!);
    expect(url.origin).toBe('https://worker.example.test');
    expect(url.pathname).toMatch(/^\/ife\/[^/]+$/);
    const token = decodeURIComponent(url.pathname.slice('/ife/'.length));
    await expect(verifyEditToken(token, SECRET, NOW)).resolves.toEqual({
      formId: 'form-1',
      rowRef: 'ifs-1',
      epoch: 7,
      exp: NOW + 30 * 86_400,
    });
  });

  test('fails closed when the secret, binding, or public URL is unusable', async () => {
    const base = {
      publicBaseUrl: 'https://worker.example.test',
      formId: 'form-1',
      submissionId: 'ifs-1',
      editLinkEpoch: 0,
      nowSec: NOW,
    };

    await expect(createInternalFormEditUrl({ ...base, secret: undefined })).resolves.toBeNull();
    await expect(createInternalFormEditUrl({ ...base, formId: '', secret: SECRET })).resolves.toBeNull();
    await expect(createInternalFormEditUrl({ ...base, submissionId: '', secret: SECRET })).resolves.toBeNull();
    await expect(createInternalFormEditUrl({ ...base, publicBaseUrl: 'not a URL', secret: SECRET })).resolves.toBeNull();
  });
});
