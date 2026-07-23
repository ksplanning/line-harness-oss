import { linkStaffNotificationLineByCode } from '@line-crm/db';

export type StaffLineLinkWebhookResult =
  | { status: 'not_handled' }
  | { status: 'invalid_code' }
  | { status: 'linked'; destinationId: string };

export function parseStaffLineLinkCommand(text: string): string | null {
  const match = /^通知連携 ([A-Za-z0-9]{8})$/.exec(text);
  return match?.[1] ?? null;
}

export async function digestStaffLineLinkCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(code),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function tryLinkStaffLineFromWebhook(
  db: D1Database,
  input: {
    lineAccountId: string;
    lineUserId: string;
    text: string;
  },
): Promise<StaffLineLinkWebhookResult> {
  const code = parseStaffLineLinkCommand(input.text);
  if (!code) return { status: 'not_handled' };

  try {
    const destination = await linkStaffNotificationLineByCode(db, {
      lineAccountId: input.lineAccountId,
      lineUserId: input.lineUserId,
      codeDigest: await digestStaffLineLinkCode(code),
    });
    return destination
      ? { status: 'linked', destinationId: destination.id }
      : { status: 'invalid_code' };
  } catch {
    console.error('[staff-notify] LINE link lookup failed');
    return { status: 'not_handled' };
  }
}
