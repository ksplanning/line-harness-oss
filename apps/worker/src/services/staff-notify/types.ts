import type { StaffNotificationDestination } from '@line-crm/db';

export type StaffNotificationEventType =
  | 'inquiry_received'
  | 'form_submitted'
  | 'test';

export interface StaffNotificationPayload {
  eventType: StaffNotificationEventType;
  lineAccountId: string;
  name: string;
  excerpt: string;
  deepLink: string;
}

export interface StaffNotificationServiceEnv {
  DB: D1Database;
}

// Adapter files own provider-specific fixed codes. Keeping the core open to
// strings avoids editing the router type whenever another channel is added.
export type StaffNotificationErrorCode = string;

export type StaffNotificationAdapterResult =
  | { ok: true }
  | { ok: false; errorCode: StaffNotificationErrorCode };

export interface StaffNotificationAdapterInput {
  env: StaffNotificationServiceEnv;
  destination: StaffNotificationDestination;
  payload: StaffNotificationPayload;
  text: string;
}

export interface StaffNotificationAdapter {
  channelType: string;
  failureCodes: readonly StaffNotificationErrorCode[];
  send(input: StaffNotificationAdapterInput): Promise<StaffNotificationAdapterResult>;
}

export type StaffNotificationAdapterRegistry = Record<
  string,
  StaffNotificationAdapter | undefined
>;

export interface StaffNotificationDeliveryResult {
  destinationId: string;
  status: 'success' | 'failed';
  errorCode: StaffNotificationErrorCode | null;
}

export interface StaffNotificationDispatchResult {
  attempted: number;
  succeeded: number;
  failed: number;
  results: StaffNotificationDeliveryResult[];
}
