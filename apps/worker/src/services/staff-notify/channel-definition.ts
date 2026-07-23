import type { StaffNotificationAdapter } from './types.js';

export const STAFF_NOTIFICATION_SECRET_MASK = '********';

export interface StaffNotificationConfigField {
  key: string;
  label: string;
  inputType: 'text' | 'secret';
  required: boolean;
  maxLength: number;
  pattern?: string;
  placeholder?: string;
}

export interface StaffNotificationChannelCapabilities {
  testSend: boolean;
  setupKind: 'none' | 'line_one_time';
}

export interface StaffNotificationChannelDefinition {
  channelType: string;
  label: string;
  configFields: StaffNotificationConfigField[];
  capabilities: StaffNotificationChannelCapabilities;
  notice?: string;
  adapter: StaffNotificationAdapter;
}

export type PublicStaffNotificationChannelDefinition = Omit<
  StaffNotificationChannelDefinition,
  'adapter'
>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeStaffNotificationChannelConfig(
  definition: StaffNotificationChannelDefinition,
  value: unknown,
  existingValue?: Record<string, unknown>,
): Record<string, unknown> | null {
  const input = record(value);
  if (!input) return null;
  const allowedKeys = new Set(definition.configFields.map((field) => field.key));
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return null;

  const normalized: Record<string, unknown> = {};
  for (const field of definition.configFields) {
    const submitted = input[field.key];
    if (submitted !== undefined && typeof submitted !== 'string') return null;
    let candidate = typeof submitted === 'string' ? submitted.trim() : '';
    if (
      field.inputType === 'secret'
      && (candidate === '' || candidate === STAFF_NOTIFICATION_SECRET_MASK)
    ) {
      const existing = existingValue?.[field.key];
      candidate = typeof existing === 'string' ? existing.trim() : '';
    }
    if (!candidate) {
      if (field.required) return null;
      continue;
    }
    if (candidate.length > field.maxLength) return null;
    if (field.pattern && !new RegExp(field.pattern).test(candidate)) return null;
    normalized[field.key] = candidate;
  }
  return normalized;
}

export function publicStaffNotificationChannelConfig(
  definition: StaffNotificationChannelDefinition,
  value: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(definition.configFields.map((field) => {
    const raw = value[field.key];
    const stored = typeof raw === 'string' ? raw : '';
    return [
      field.key,
      field.inputType === 'secret' && stored
        ? STAFF_NOTIFICATION_SECRET_MASK
        : stored,
    ] as const;
  }));
}

export function publicStaffNotificationChannelDefinition(
  definition: StaffNotificationChannelDefinition,
): PublicStaffNotificationChannelDefinition {
  return {
    channelType: definition.channelType,
    label: definition.label,
    configFields: definition.configFields.map((field) => ({ ...field })),
    capabilities: { ...definition.capabilities },
    ...(definition.notice ? { notice: definition.notice } : {}),
  };
}
