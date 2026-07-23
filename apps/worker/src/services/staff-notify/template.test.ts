import { describe, expect, test } from 'vitest';
import { renderStaffNotificationText } from './template.js';

describe('renderStaffNotificationText', () => {
  test.each([
    ['inquiry_received', '問い合わせ受信'],
    ['form_submitted', 'フォーム申込み'],
    ['test', 'テスト通知'],
  ] as const)('renders the %s event label, name, excerpt, and deep link', (eventType, label) => {
    const text = renderStaffNotificationText({
      eventType,
      lineAccountId: 'account-1',
      name: '山田花子',
      excerpt: '予約について相談したいです',
      deepLink: 'https://admin.example.test/chats/friend-1',
    });

    expect(text).toContain(`種別: ${label}`);
    expect(text).toContain('名前: 山田花子');
    expect(text).toContain('予約について相談したいです');
    expect(text).toContain('https://admin.example.test/chats/friend-1');
  });

  test('keeps exactly the first 40 Unicode code points without splitting an emoji', () => {
    const excerpt = `${'あ'.repeat(39)}😀末尾`;
    const text = renderStaffNotificationText({
      eventType: 'inquiry_received',
      lineAccountId: 'account-1',
      name: '山田',
      excerpt,
      deepLink: 'https://admin.example.test/chats/friend-1',
    });

    expect(text).toContain(`${'あ'.repeat(39)}😀…`);
    expect(text).not.toContain('末尾');
    expect(text).not.toContain('\ud83d…');
  });

  test('bounds the displayed name to 40 Unicode code points too', () => {
    const name = `${'名'.repeat(39)}😀秘密の末尾`;
    const text = renderStaffNotificationText({
      eventType: 'form_submitted',
      lineAccountId: 'account-1',
      name,
      excerpt: '申込み',
      deepLink: 'https://admin.example.test/forms-advanced/data?id=form-1',
    });

    expect(text).toContain(`名前: ${'名'.repeat(39)}😀…`);
    expect(text).not.toContain('秘密の末尾');
    expect(text).not.toContain('\ud83d…');
  });

  test('compacts line breaks in the displayed name and excerpt', () => {
    const text = renderStaffNotificationText({
      eventType: 'form_submitted',
      lineAccountId: 'account-1',
      name: ' 山田\n花子 ',
      excerpt: '第一行\r\n第二行',
      deepLink: 'https://admin.example.test/forms-advanced/data?id=form-1&rowId=row-1',
    });

    expect(text).toContain('名前: 山田 花子');
    expect(text).toContain('内容: 第一行 第二行');
  });

  test('neutralizes user-supplied Chatwork markup in names and excerpts', () => {
    const text = renderStaffNotificationText({
      eventType: 'inquiry_received',
      lineAccountId: 'account-1',
      name: '[To:123] 山田',
      excerpt: '[info]意図しない装飾[/info]',
      deepLink: 'https://admin.example.test/chats?friend=friend-1',
    });

    expect(text).toContain('名前: ［To:123］ 山田');
    expect(text).toContain('内容: ［info］意図しない装飾［/info］');
    expect(text).not.toContain('[To:123]');
    expect(text).not.toContain('[info]');
  });
});
