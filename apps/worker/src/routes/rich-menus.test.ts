import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { richMenus } from './rich-menus.js';

const uploadRichMenuImage = vi.fn();
const linkRichMenuToUser = vi.fn();
const unlinkRichMenuFromUser = vi.fn();

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({
    uploadRichMenuImage,
    linkRichMenuToUser,
    unlinkRichMenuFromUser,
  })),
}));

function friendDb(deletes: unknown[][]): D1Database {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { binds = args; return statement; },
        async first<T>() {
          if (sql.includes('SELECT * FROM friends')) {
            return { id: 'friend-1', line_user_id: 'U1', line_account_id: null } as T;
          }
          return null;
        },
        async run() {
          if (sql.includes('DELETE FROM rich_menu_friend_assignments')) deletes.push(binds);
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe('POST /api/rich-menus/:id/image', () => {
  function setupApp() {
    const app = new Hono<{
      Bindings: {
        DB: D1Database;
        LINE_CHANNEL_ACCESS_TOKEN: string;
      };
    }>();
    app.route('/', richMenus);
    return app;
  }

  beforeEach(() => {
    uploadRichMenuImage.mockReset();
    uploadRichMenuImage.mockResolvedValue(undefined);
  });

  test('accepts SDK imageData JSON field for base64 uploads', async () => {
    const app = setupApp();
    const res = await app.request('/api/rich-menus/richmenu-1/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        imageData: 'aGVsbG8=',
        contentType: 'image/png',
      }),
    }, {
      LINE_CHANNEL_ACCESS_TOKEN: 'token',
      DB: {} as D1Database,
    });

    expect(res.status).toBe(200);
    expect(uploadRichMenuImage).toHaveBeenCalledTimes(1);
    const [richMenuId, imageData, contentType] = uploadRichMenuImage.mock.calls[0];
    expect(richMenuId).toBe('richmenu-1');
    expect(contentType).toBe('image/png');
    expect(new TextDecoder().decode(imageData as ArrayBuffer)).toBe('hello');
  });

  test('keeps accepting legacy image JSON field', async () => {
    const app = setupApp();
    const res = await app.request('/api/rich-menus/richmenu-2/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: 'data:image/jpeg;base64,aGVsbG8=',
        contentType: 'image/jpeg',
      }),
    }, {
      LINE_CHANNEL_ACCESS_TOKEN: 'token',
      DB: {} as D1Database,
    });

    expect(res.status).toBe(200);
    expect(uploadRichMenuImage).toHaveBeenCalledTimes(1);
    const [richMenuId, imageData, contentType] = uploadRichMenuImage.mock.calls[0];
    expect(richMenuId).toBe('richmenu-2');
    expect(contentType).toBe('image/jpeg');
    expect(new TextDecoder().decode(imageData as ArrayBuffer)).toBe('hello');
  });
});

describe('manual friend rich menu cache consistency', () => {
  beforeEach(() => {
    linkRichMenuToUser.mockReset();
    unlinkRichMenuFromUser.mockReset();
    linkRichMenuToUser.mockResolvedValue(undefined);
    unlinkRichMenuFromUser.mockResolvedValue(undefined);
  });

  test.each([
    ['POST', { richMenuId: 'menu-manual' }, linkRichMenuToUser],
    ['DELETE', undefined, unlinkRichMenuFromUser],
  ] as const)('%s success forgets the conditional-rule assignment cache', async (method, body, lineCall) => {
    const deletes: unknown[][] = [];
    const app = new Hono<{ Bindings: { DB: D1Database; LINE_CHANNEL_ACCESS_TOKEN: string } }>();
    app.route('/', richMenus);

    const response = await app.request('/api/friends/friend-1/rich-menu', {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }, {
      DB: friendDb(deletes),
      LINE_CHANNEL_ACCESS_TOKEN: 'token',
    });

    expect(response.status).toBe(200);
    expect(lineCall).toHaveBeenCalledTimes(1);
    expect(deletes).toEqual([['friend-1']]);
  });
});
