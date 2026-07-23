import type { StaffNotificationEventType, StaffNotificationPayload } from './types.js';

const EVENT_LABELS: Record<StaffNotificationEventType, string> = {
  inquiry_received: '問い合わせ受信',
  form_submitted: 'フォーム申込み',
  test: 'テスト通知',
};

function compactLine(value: string, fallback: string): string {
  const compact = value
    .replace(/\s+/gu, ' ')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .trim();
  return compact || fallback;
}

function boundedPreview(value: string, fallback: string): string {
  const compact = compactLine(value, fallback);
  const codePoints = Array.from(compact);
  if (codePoints.length <= 40) return compact;
  return `${codePoints.slice(0, 40).join('')}…`;
}

export function renderStaffNotificationText(payload: StaffNotificationPayload): string {
  return [
    '【スタッフ通知】',
    `種別: ${EVENT_LABELS[payload.eventType]}`,
    `名前: ${boundedPreview(payload.name, '（名前未設定）')}`,
    `内容: ${boundedPreview(payload.excerpt, '（内容なし）')}`,
    `確認: ${payload.deepLink.trim()}`,
  ].join('\n');
}
