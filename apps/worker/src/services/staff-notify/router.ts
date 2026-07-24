import {
  listSubscribedStaffNotificationDestinations,
  recordStaffNotificationDelivery,
  type StaffNotificationDestination,
  type StaffNotificationEvent,
} from '@line-crm/db';
import { isAutoReplyHandledSource } from '../auto-reply-keyword-match.js';
import { defaultStaffNotificationAdapters } from './registry.js';
import { renderStaffNotificationText } from './template.js';
import type {
  StaffNotificationAdapterRegistry,
  StaffNotificationAdapter,
  StaffNotificationAdapterResult,
  StaffNotificationDeliveryResult,
  StaffNotificationDispatchResult,
  StaffNotificationErrorCode,
  StaffNotificationPayload,
  StaffNotificationServiceEnv,
} from './types.js';

export { defaultStaffNotificationAdapters } from './registry.js';

const ADAPTER_TIMEOUT_MS = 10_000;
const ADAPTER_TIMEOUT = Symbol('staff-notification-adapter-timeout');

function emptyDispatchResult(): StaffNotificationDispatchResult {
  return {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    results: [],
  };
}

function safeAdapterErrorCode(
  adapter: StaffNotificationAdapter,
  value: unknown,
): StaffNotificationErrorCode {
  return typeof value === 'string' && adapter.failureCodes.includes(value)
    ? value
    : 'adapter_unexpected_error';
}

async function sendWithTimeout(
  work: Promise<StaffNotificationAdapterResult>,
): Promise<StaffNotificationAdapterResult | typeof ADAPTER_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof ADAPTER_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(ADAPTER_TIMEOUT), ADAPTER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function subscribed(
  destination: StaffNotificationDestination,
  eventType: StaffNotificationEvent,
  source: string | undefined,
): boolean {
  if (!destination.enabled) return false;
  if (
    eventType === 'inquiry_received'
    && isAutoReplyHandledSource(source)
    && !destination.notifyAutoReply
  ) {
    return false;
  }
  return eventType === 'inquiry_received'
    ? destination.notifyInquiry
    : destination.notifyFormSubmission;
}

function destinationForPayload(
  destination: StaffNotificationDestination,
  payload: StaffNotificationPayload,
): StaffNotificationDestination {
  if (destination.channelType !== 'chatwork' || payload.eventType === 'test') {
    return destination;
  }
  const roomIdKey = payload.eventType === 'form_submitted'
    ? 'formSubmissionRoomId'
    : isAutoReplyHandledSource(payload.source)
      ? 'autoReplyRoomId'
      : 'inquiryRoomId';
  const configuredRoomId = destination.config[roomIdKey];
  const roomId = typeof configuredRoomId === 'string'
    ? configuredRoomId.trim()
    : '';
  return roomId
    ? {
        ...destination,
        config: { ...destination.config, roomId },
      }
    : destination;
}

async function recordDeliverySafely(
  env: StaffNotificationServiceEnv,
  destination: StaffNotificationDestination,
  payload: StaffNotificationPayload,
  result: StaffNotificationDeliveryResult,
): Promise<void> {
  try {
    await recordStaffNotificationDelivery(env.DB, {
      id: crypto.randomUUID(),
      destinationId: destination.id,
      eventType: payload.eventType,
      status: result.status,
      errorCode: result.errorCode,
    });
  } catch {
    console.error('[staff-notify] delivery log failed');
  }
}

async function deliverOne(
  env: StaffNotificationServiceEnv,
  destination: StaffNotificationDestination,
  payload: StaffNotificationPayload,
  adapters: StaffNotificationAdapterRegistry,
): Promise<StaffNotificationDeliveryResult> {
  let errorCode: StaffNotificationErrorCode | null = null;
  if (destination.lineAccountId !== payload.lineAccountId) {
    errorCode = 'destination_account_mismatch';
  } else {
    const adapter = adapters[destination.channelType];
    if (!adapter || adapter.channelType !== destination.channelType) {
      errorCode = 'unsupported_channel';
    } else {
      try {
        const adapterResult = await sendWithTimeout(
          adapter.send({
            env,
            destination: destinationForPayload(destination, payload),
            payload,
            text: renderStaffNotificationText(payload),
          }),
        );
        if (adapterResult === ADAPTER_TIMEOUT) {
          errorCode = 'adapter_timeout';
        } else if (!adapterResult.ok) {
          errorCode = safeAdapterErrorCode(adapter, adapterResult.errorCode);
        }
      } catch {
        errorCode = 'adapter_unexpected_error';
      }
    }
  }

  const result: StaffNotificationDeliveryResult = errorCode
    ? { destinationId: destination.id, status: 'failed', errorCode }
    : { destinationId: destination.id, status: 'success', errorCode: null };
  await recordDeliverySafely(env, destination, payload, result);
  return result;
}

export async function dispatchStaffNotifications(
  env: StaffNotificationServiceEnv,
  payload: StaffNotificationPayload,
  adapters: StaffNotificationAdapterRegistry = defaultStaffNotificationAdapters,
): Promise<StaffNotificationDispatchResult> {
  if (payload.eventType === 'test') return emptyDispatchResult();
  const eventType: StaffNotificationEvent = payload.eventType;

  let destinations: StaffNotificationDestination[];
  try {
    destinations = await listSubscribedStaffNotificationDestinations(
      env.DB,
      payload.lineAccountId,
      eventType,
    );
  } catch {
    console.error('[staff-notify] destination list failed');
    return emptyDispatchResult();
  }

  const results = await Promise.all(
    destinations
      .filter((destination) => subscribed(destination, eventType, payload.source))
      .map((destination) => deliverOne(env, destination, payload, adapters)),
  );

  const succeeded = results.filter((result) => result.status === 'success').length;
  return {
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

export const dispatchStaffNotification = dispatchStaffNotifications;

export async function sendStaffNotificationTest(
  env: StaffNotificationServiceEnv,
  destination: StaffNotificationDestination,
  payload: StaffNotificationPayload,
  adapters: StaffNotificationAdapterRegistry = defaultStaffNotificationAdapters,
): Promise<StaffNotificationDeliveryResult> {
  return deliverOne(
    env,
    destination,
    { ...payload, eventType: 'test' },
    adapters,
  );
}
