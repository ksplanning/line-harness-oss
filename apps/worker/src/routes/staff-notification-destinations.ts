import {
  createStaffNotificationDestination,
  deleteStaffNotificationDestination,
  getStaffNotificationDestination,
  issueStaffNotificationLineLinkCode,
  listStaffNotificationDestinations,
  toJstString,
  unlinkStaffNotificationLine,
  updateStaffNotificationDestination,
  type StaffNotificationDestination,
} from '@line-crm/db';
import { Hono, type Context } from 'hono';
import type { Env } from '../index.js';
import {
  normalizeStaffNotificationChannelConfig,
  publicStaffNotificationChannelConfig,
} from '../services/staff-notify/channel-definition.js';
import { digestStaffLineLinkCode } from '../services/staff-notify/line-link.js';
import {
  getStaffNotificationChannelDefinition,
  listPublicStaffNotificationChannels,
} from '../services/staff-notify/registry.js';
import { sendStaffNotificationTest } from '../services/staff-notify/router.js';

const staffNotificationDestinations = new Hono<Env>();

const LINE_LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LINE_LINK_CODE_LENGTH = 8;
const LINE_LINK_CODE_TTL_MS = 10 * 60_000;
const LABEL_MAX_LENGTH = 100;
const ACCOUNT_ID_MAX_LENGTH = 128;
const CHANNEL_TYPE_MAX_LENGTH = 64;

interface DestinationBody {
  lineAccountId: string;
  label: string;
  channelType: string;
  config: Record<string, unknown>;
  notifyInquiry: boolean;
  notifyFormSubmission: boolean;
  enabled: boolean;
}

type ParsedBody =
  | { ok: true; value: DestinationBody }
  | { ok: false };

async function jsonObject(c: Context<Env>): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json<unknown>();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

function accountId(value: unknown): string | null {
  return nonEmptyString(value, ACCOUNT_ID_MAX_LENGTH);
}

function parseDestinationBody(
  body: Record<string, unknown> | null,
  existing?: StaffNotificationDestination,
): ParsedBody {
  if (!body) return { ok: false };
  const lineAccountId = accountId(body.lineAccountId);
  const label = nonEmptyString(body.label, LABEL_MAX_LENGTH);
  const channelType = nonEmptyString(body.channelType, CHANNEL_TYPE_MAX_LENGTH);
  const definition = channelType
    ? getStaffNotificationChannelDefinition(channelType)
    : null;
  if (
    !lineAccountId
    || !label
    || !channelType
    || !definition
    || typeof body.notifyInquiry !== 'boolean'
    || typeof body.notifyFormSubmission !== 'boolean'
    || typeof body.enabled !== 'boolean'
  ) {
    return { ok: false };
  }

  if (existing && existing.channelType !== channelType) {
    return { ok: false };
  }
  const config = normalizeStaffNotificationChannelConfig(
    definition,
    body.config,
    existing?.config,
  );
  if (!config) return { ok: false };

  return {
    ok: true,
    value: {
      lineAccountId,
      label,
      channelType,
      config,
      notifyInquiry: body.notifyInquiry,
      notifyFormSubmission: body.notifyFormSubmission,
      enabled: body.enabled,
    },
  };
}

function destinationView(destination: StaffNotificationDestination) {
  const definition = getStaffNotificationChannelDefinition(destination.channelType);
  const base = {
    id: destination.id,
    label: destination.label,
    channelType: destination.channelType,
    notifyInquiry: destination.notifyInquiry,
    notifyFormSubmission: destination.notifyFormSubmission,
    enabled: destination.enabled,
  };
  return {
    ...base,
    config: definition
      ? publicStaffNotificationChannelConfig(definition, destination.config)
      : {},
    unsupported: !definition,
    setupState: definition?.capabilities.setupKind === 'line_one_time'
      ? {
          kind: 'line_one_time' as const,
          linked: Boolean(destination.lineUserId),
        }
      : null,
  };
}

function generateLineLinkCode(): string {
  const random = new Uint8Array(LINE_LINK_CODE_LENGTH);
  crypto.getRandomValues(random);
  return Array.from(
    random,
    (value) => LINE_LINK_CODE_ALPHABET[value & 31],
  ).join('');
}

function settingsDeepLink(env: Env['Bindings']): string {
  const candidate = env.ADMIN_PUBLIC_URL ?? env.WORKER_PUBLIC_URL ?? env.WORKER_URL;
  if (!candidate) return '/accounts';
  try {
    return new URL('/accounts', candidate).toString();
  } catch {
    return '/accounts';
  }
}

staffNotificationDestinations.get(
  '/api/staff-notification-channels',
  (c) => c.json({
    success: true,
    data: listPublicStaffNotificationChannels(),
  }),
);

staffNotificationDestinations.get(
  '/api/staff-notification-destinations',
  async (c) => {
    const lineAccountId = accountId(c.req.query('lineAccountId'));
    if (!lineAccountId) {
      return c.json({ success: false, error: 'lineAccountId required' }, 400);
    }
    const destinations = await listStaffNotificationDestinations(
      c.env.DB,
      lineAccountId,
    );
    return c.json({
      success: true,
      data: destinations.map(destinationView),
    });
  },
);

staffNotificationDestinations.post(
  '/api/staff-notification-destinations',
  async (c) => {
    const parsed = parseDestinationBody(await jsonObject(c));
    if (!parsed.ok) {
      return c.json({ success: false, error: 'Invalid destination input' }, 400);
    }
    const input = parsed.value;
    const created = await createStaffNotificationDestination(c.env.DB, {
      id: crypto.randomUUID(),
      lineAccountId: input.lineAccountId,
      label: input.label,
      channelType: input.channelType,
      config: input.config,
      notifyInquiry: input.notifyInquiry,
      notifyFormSubmission: input.notifyFormSubmission,
      enabled: input.enabled,
    });
    return c.json({ success: true, data: destinationView(created) }, 201);
  },
);

staffNotificationDestinations.put(
  '/api/staff-notification-destinations/:id',
  async (c) => {
    const body = await jsonObject(c);
    const scopedAccountId = accountId(body?.lineAccountId);
    if (!body || !scopedAccountId) {
      return c.json({ success: false, error: 'Invalid destination input' }, 400);
    }
    const existing = await getStaffNotificationDestination(
      c.env.DB,
      scopedAccountId,
      c.req.param('id'),
    );
    if (!existing) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    if (body.channelType !== existing.channelType) {
      return c.json({ success: false, error: 'channelType cannot be changed' }, 400);
    }
    const parsed = parseDestinationBody(body, existing);
    if (!parsed.ok) {
      return c.json({ success: false, error: 'Invalid destination input' }, 400);
    }
    const input = parsed.value;
    const updated = await updateStaffNotificationDestination(c.env.DB, {
      id: existing.id,
      lineAccountId: input.lineAccountId,
      label: input.label,
      channelType: input.channelType,
      config: input.config,
      notifyInquiry: input.notifyInquiry,
      notifyFormSubmission: input.notifyFormSubmission,
      enabled: input.enabled,
    });
    if (!updated) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    return c.json({ success: true, data: destinationView(updated) });
  },
);

staffNotificationDestinations.delete(
  '/api/staff-notification-destinations/:id',
  async (c) => {
    const lineAccountId = accountId(c.req.query('lineAccountId'));
    if (!lineAccountId) {
      return c.json({ success: false, error: 'lineAccountId required' }, 400);
    }
    const deleted = await deleteStaffNotificationDestination(
      c.env.DB,
      lineAccountId,
      c.req.param('id'),
    );
    if (!deleted) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    return c.json({ success: true, data: null });
  },
);

staffNotificationDestinations.post(
  '/api/staff-notification-destinations/:id/test',
  async (c) => {
    const body = await jsonObject(c);
    const scopedAccountId = accountId(body?.lineAccountId);
    if (!scopedAccountId) {
      return c.json({ success: false, error: 'lineAccountId required' }, 400);
    }
    const destination = await getStaffNotificationDestination(
      c.env.DB,
      scopedAccountId,
      c.req.param('id'),
    );
    if (!destination) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const definition = getStaffNotificationChannelDefinition(
      destination.channelType,
    );
    if (!definition?.capabilities.testSend) {
      return c.json({ success: false, error: 'Test send unsupported' }, 400);
    }
    try {
      const result = await sendStaffNotificationTest(c.env, destination, {
        eventType: 'test',
        lineAccountId: scopedAccountId,
        name: 'テスト通知',
        excerpt: 'スタッフ通知のテスト送信です',
        deepLink: settingsDeepLink(c.env),
      });
      if (result.status !== 'success') {
        console.error('Staff notification test send failed');
        return c.json(
          { success: false, error: 'Staff notification test send failed' },
          502,
        );
      }
      return c.json({ success: true, data: null });
    } catch {
      console.error('Staff notification test send failed');
      return c.json(
        { success: false, error: 'Staff notification test send failed' },
        502,
      );
    }
  },
);

staffNotificationDestinations.post(
  '/api/staff-notification-destinations/:id/line-link-code',
  async (c) => {
    const body = await jsonObject(c);
    const scopedAccountId = accountId(body?.lineAccountId);
    if (!scopedAccountId) {
      return c.json({ success: false, error: 'lineAccountId required' }, 400);
    }
    const existing = await getStaffNotificationDestination(
      c.env.DB,
      scopedAccountId,
      c.req.param('id'),
    );
    const definition = existing
      ? getStaffNotificationChannelDefinition(existing.channelType)
      : null;
    if (!existing) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    if (definition?.capabilities.setupKind !== 'line_one_time') {
      return c.json({ success: false, error: 'Link setup unsupported' }, 400);
    }
    const code = generateLineLinkCode();
    const codeDigest = await digestStaffLineLinkCode(code);
    const expiresAt = toJstString(new Date(Date.now() + LINE_LINK_CODE_TTL_MS));
    const destination = await issueStaffNotificationLineLinkCode(c.env.DB, {
      id: c.req.param('id'),
      lineAccountId: scopedAccountId,
      codeDigest,
      expiresAt,
    });
    if (!destination) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    return c.json({
      success: true,
      data: { code, expiresAt },
    });
  },
);

staffNotificationDestinations.delete(
  '/api/staff-notification-destinations/:id/line-link',
  async (c) => {
    const lineAccountId = accountId(c.req.query('lineAccountId'));
    if (!lineAccountId) {
      return c.json({ success: false, error: 'lineAccountId required' }, 400);
    }
    const existing = await getStaffNotificationDestination(
      c.env.DB,
      lineAccountId,
      c.req.param('id'),
    );
    const definition = existing
      ? getStaffNotificationChannelDefinition(existing.channelType)
      : null;
    if (!existing) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    if (definition?.capabilities.setupKind !== 'line_one_time') {
      return c.json({ success: false, error: 'Link setup unsupported' }, 400);
    }
    const destination = await unlinkStaffNotificationLine(
      c.env.DB,
      lineAccountId,
      c.req.param('id'),
    );
    if (!destination) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    return c.json({ success: true, data: destinationView(destination) });
  },
);

export { staffNotificationDestinations };
