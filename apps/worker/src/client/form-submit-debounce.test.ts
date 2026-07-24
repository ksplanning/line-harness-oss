// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';

type FormDefinition = {
  id: string;
  name: string;
  description: string | null;
  fields: Array<{
    name: string;
    label: string;
    type: 'text';
    required?: boolean;
  }>;
  isActive: boolean;
  onSubmitWebhookUrl?: string | null;
};

type FetchHandler = (path: string, init?: RequestInit) => Promise<Response>;

function singlePageDefinition(): FormDefinition {
  return {
    id: 'form-1',
    name: '申込フォーム',
    description: null,
    fields: [{ name: 'name', label: 'お名前', type: 'text', required: true }],
    isActive: true,
  };
}

function twoPageDefinition(): FormDefinition {
  return {
    ...singlePageDefinition(),
    fields: [
      { name: 'name', label: 'お名前', type: 'text', required: true },
      { name: 'x_username', label: 'X ID', type: 'text', required: true },
    ],
    onSubmitWebhookUrl: 'https://x.example.test/webhook',
  };
}

async function mountForm(
  definition: FormDefinition,
  onFetch: FetchHandler,
): Promise<{ fetchMock: ReturnType<typeof vi.fn> }> {
  document.body.innerHTML = '<div id="app"></div>';
  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal('liff', {
    getProfile: vi.fn().mockResolvedValue({ userId: 'U1', displayName: '佐藤' }),
    getIDToken: vi.fn().mockReturnValue(null),
    isInClient: vi.fn().mockReturnValue(false),
    closeWindow: vi.fn(),
  });
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === `/api/forms/${definition.id}` && !init?.method) {
      return Promise.resolve(new Response(JSON.stringify({ success: true, data: definition }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    if (path === `/api/forms/${definition.id}/opened`) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return onFetch(path, init);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { initForm } = await import('./form.js');
  await initForm(definition.id);
  return { fetchMock };
}

function submitEvent(): Event {
  return new Event('submit', { bubbles: true, cancelable: true });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('public LIFF form submit lock', () => {
  test('locks before validation so synchronous re-entry sends one POST', async () => {
    const submitCalls: string[] = [];
    await mountForm(singlePageDefinition(), async (path) => {
      if (path.endsWith('/submit')) {
        submitCalls.push(path);
        return new Promise<Response>(() => {});
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    const form = document.querySelector<HTMLFormElement>('#liff-form')!;
    const button = document.querySelector<HTMLButtonElement>('#submitBtn')!;
    const input = document.querySelector<HTMLInputElement>('[name="name"]')!;
    let reentered = false;
    let lockedBeforeValidation = false;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        if (!reentered) {
          reentered = true;
          lockedBeforeValidation = button.disabled && button.textContent === '送信中...';
          form.dispatchEvent(submitEvent());
        }
        return '佐藤';
      },
    });

    form.dispatchEvent(submitEvent());

    expect(lockedBeforeValidation).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('送信中...');
    expect(submitCalls).toHaveLength(1);
  });

  test('locks the two-page survey transition before its partial POST', async () => {
    const partialCalls: string[] = [];
    await mountForm(twoPageDefinition(), async (path) => {
      if (path.endsWith('/partial')) {
        partialCalls.push(path);
        return new Promise<Response>(() => {});
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    const form = document.querySelector<HTMLFormElement>('#survey-form')!;
    const button = document.querySelector<HTMLButtonElement>('#nextBtn')!;
    document.querySelector<HTMLInputElement>('[name="name"]')!.value = '佐藤';

    form.dispatchEvent(submitEvent());
    form.dispatchEvent(submitEvent());

    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('保存中...');
    expect(partialCalls).toHaveLength(1);
  });

  test('restores the two-page submit label after a preflight failure', async () => {
    await mountForm(twoPageDefinition(), async (path) => {
      throw new Error(`unexpected fetch: ${path}`);
    });
    document.querySelector<HTMLInputElement>('[name="name"]')!.value = '佐藤';
    document.querySelector<HTMLInputElement>('[name="x_username"]')!.value = 'unverified-user';
    const form = document.querySelector<HTMLFormElement>('#liff-form')!;
    const button = document.querySelector<HTMLButtonElement>('#submitBtn')!;

    form.dispatchEvent(submitEvent());

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('X Harness を受け取る');
  });

  test('unlocks after a failed POST and permits a retry', async () => {
    let attempts = 0;
    await mountForm(singlePageDefinition(), async (path) => {
      if (!path.endsWith('/submit')) throw new Error(`unexpected fetch: ${path}`);
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: '一時的な失敗' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Promise<Response>(() => {});
    });
    document.querySelector<HTMLInputElement>('[name="name"]')!.value = '佐藤';
    const form = document.querySelector<HTMLFormElement>('#liff-form')!;
    const button = document.querySelector<HTMLButtonElement>('#submitBtn')!;

    form.dispatchEvent(submitEvent());
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toBe('送信する');

    form.dispatchEvent(submitEvent());
    expect(attempts).toBe(2);
    expect(button.disabled).toBe(true);
  });
});
