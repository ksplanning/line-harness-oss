import {
  publicStaffNotificationChannelDefinition,
  type PublicStaffNotificationChannelDefinition,
  type StaffNotificationChannelDefinition,
} from './channel-definition.js';
import { chatworkStaffNotificationChannel } from './chatwork.js';
import { lineStaffNotificationChannel } from './line.js';
import type { StaffNotificationAdapterRegistry } from './types.js';

// This is the sole registration point for notification channels. A future
// channel adds one adapter/definition file and one entry here; the router,
// admin API, and schema-driven web panel stay unchanged.
const registeredChannels = [
  chatworkStaffNotificationChannel,
  lineStaffNotificationChannel,
];

export const staffNotificationChannelRegistry: ReadonlyMap<
  string,
  StaffNotificationChannelDefinition
> = new Map(
  registeredChannels.map((definition) => [definition.channelType, definition]),
);

export const defaultStaffNotificationAdapters: StaffNotificationAdapterRegistry =
  Object.freeze(Object.assign(
    Object.create(null) as StaffNotificationAdapterRegistry,
    Object.fromEntries(registeredChannels.map((definition) => [
      definition.channelType,
      definition.adapter,
    ])),
  ));

export function getStaffNotificationChannelDefinition(
  channelType: string,
): StaffNotificationChannelDefinition | null {
  return staffNotificationChannelRegistry.get(channelType) ?? null;
}

export function listPublicStaffNotificationChannels(): PublicStaffNotificationChannelDefinition[] {
  return registeredChannels.map(publicStaffNotificationChannelDefinition);
}
