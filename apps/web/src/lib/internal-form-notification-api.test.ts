import { beforeEach, describe, expect, test, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({ fetchApi: vi.fn() }));
vi.mock('./api', () => apiMocks);

import { internalFormNotificationApi } from './internal-form-notification-api';

beforeEach(() => vi.clearAllMocks());

describe('internalFormNotificationApi', () => {
  test('loads settings through an encoded form id', async () => {
    const data = {
      formId: 'form / 1', enabled: false, recipientEmailFieldId: null,
      messageTemplate: null, editLinkEpoch: 0,
    };
    apiMocks.fetchApi.mockResolvedValue({ success: true, data });

    await expect(internalFormNotificationApi.get('form / 1')).resolves.toEqual(data);
    expect(apiMocks.fetchApi).toHaveBeenCalledWith(
      '/api/forms-advanced/form%20%2F%201/submission-notification',
    );
  });

  test('saves the complete per-form settings payload', async () => {
    const input = {
      enabled: true,
      recipientEmailFieldId: 'email-1',
      messageTemplate: '{{回答:お名前}}\n{{編集リンク}}',
    };
    apiMocks.fetchApi.mockResolvedValue({ success: true, data: { formId: 'f', ...input, editLinkEpoch: 0 } });

    await internalFormNotificationApi.save('f', input);
    expect(apiMocks.fetchApi).toHaveBeenCalledWith(
      '/api/forms-advanced/f/submission-notification',
      { method: 'PUT', body: JSON.stringify(input) },
    );
  });

  test('revokes all previously issued internal edit links', async () => {
    apiMocks.fetchApi.mockResolvedValue({ success: true, data: { editLinkEpoch: 4 } });

    await expect(internalFormNotificationApi.revokeLinks('f')).resolves.toBe(4);
    expect(apiMocks.fetchApi).toHaveBeenCalledWith(
      '/api/forms-advanced/f/submission-notification/revoke-links',
      { method: 'POST' },
    );
  });
});
