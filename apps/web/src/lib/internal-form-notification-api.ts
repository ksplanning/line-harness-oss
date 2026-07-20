import { fetchApi } from './api';

export interface InternalFormNotificationSettings {
  formId: string;
  enabled: boolean;
  recipientEmailFieldId: string | null;
  messageTemplate: string | null;
  editLinkEpoch: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface SaveInternalFormNotificationSettings {
  enabled: boolean;
  recipientEmailFieldId: string | null;
  messageTemplate: string | null;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: string;
}

function base(formId: string): string {
  return `/api/forms-advanced/${encodeURIComponent(formId)}/submission-notification`;
}

export const internalFormNotificationApi = {
  async get(formId: string): Promise<InternalFormNotificationSettings> {
    return (await fetchApi<Envelope<InternalFormNotificationSettings>>(base(formId))).data;
  },

  async save(
    formId: string,
    input: SaveInternalFormNotificationSettings,
  ): Promise<InternalFormNotificationSettings> {
    return (await fetchApi<Envelope<InternalFormNotificationSettings>>(base(formId), {
      method: 'PUT',
      body: JSON.stringify(input),
    })).data;
  },

  async revokeLinks(formId: string): Promise<number> {
    return (await fetchApi<Envelope<{ editLinkEpoch: number }>>(`${base(formId)}/revoke-links`, {
      method: 'POST',
    })).data.editLinkEpoch;
  },
};
