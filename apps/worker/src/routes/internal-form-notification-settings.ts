import { Hono, type Context } from 'hono';
import {
  bumpInternalFormEditLinkEpoch,
  getFormalooForm,
  getInternalFormNotificationSettings,
  upsertInternalFormNotificationSettings,
} from '@line-crm/db';
import { validateInternalSubmissionNotificationTemplate } from '@line-crm/shared';
import { parseInternalFormDefinition } from '../services/internal-form-runtime.js';
import type { Env } from '../index.js';

const MAX_TEMPLATE_LENGTH = 10_000;

export const internalFormNotificationSettings = new Hono<Env>();

async function internalForm(c: Context<Env>) {
  const formId = c.req.param('id');
  if (!formId) return null;
  const form = await getFormalooForm(c.env.DB, formId);
  return form && !form.deleted && form.render_backend === 'internal' ? form : null;
}

internalFormNotificationSettings.get(
  '/api/forms-advanced/:id/submission-notification',
  async (c) => {
    try {
      const form = await internalForm(c);
      if (!form) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
      const stored = await getInternalFormNotificationSettings(c.env.DB, form.id);
      return c.json({
        success: true,
        data: stored ?? {
          formId: form.id,
          enabled: false,
          recipientEmailFieldId: null,
          messageTemplate: null,
          editLinkEpoch: 0,
        },
      });
    } catch (error) {
      console.error('GET internal submission notification settings error:', error);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  },
);

internalFormNotificationSettings.put(
  '/api/forms-advanced/:id/submission-notification',
  async (c) => {
    try {
      const form = await internalForm(c);
      if (!form) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
      const definition = parseInternalFormDefinition(form.definition_json);
      if (!definition.ok) return c.json({ success: false, error: definition.error }, 422);

      const body = await c.req.json<{
        enabled?: unknown;
        recipientEmailFieldId?: unknown;
        messageTemplate?: unknown;
      }>().catch(() => null);
      if (!body || typeof body.enabled !== 'boolean') {
        return c.json({ success: false, error: 'enabled は真偽値で指定してください' }, 400);
      }
      if (
        body.recipientEmailFieldId !== null
        && typeof body.recipientEmailFieldId !== 'string'
      ) {
        return c.json({ success: false, error: '送信先メール項目が正しくありません' }, 400);
      }
      if (body.messageTemplate !== null && typeof body.messageTemplate !== 'string') {
        return c.json({ success: false, error: '通知文面は文字列で指定してください' }, 400);
      }
      if (typeof body.messageTemplate === 'string' && body.messageTemplate.length > MAX_TEMPLATE_LENGTH) {
        return c.json({ success: false, error: '通知文面は10000文字以内で入力してください' }, 400);
      }

      const recipientEmailFieldId = typeof body.recipientEmailFieldId === 'string'
        ? body.recipientEmailFieldId
        : null;
      const recipientField = definition.definition.fields.find(
        (field) => field.id === recipientEmailFieldId && field.type === 'email',
      );
      if (body.enabled && !recipientField) {
        return c.json({
          success: false,
          error: '自動通知を有効にするには、回答者本人のメール項目を選んでください',
        }, 400);
      }

      const messageTemplate = typeof body.messageTemplate === 'string' && body.messageTemplate.trim()
        ? body.messageTemplate
        : null;
      const templateValidation = validateInternalSubmissionNotificationTemplate(
        messageTemplate,
        definition.definition.fields,
      );
      if (!templateValidation.ok) {
        return c.json({ success: false, error: templateValidation.error }, 400);
      }

      const settings = await upsertInternalFormNotificationSettings(c.env.DB, {
        formId: form.id,
        enabled: body.enabled,
        recipientEmailFieldId,
        messageTemplate,
      });
      return c.json({ success: true, data: settings });
    } catch (error) {
      console.error('PUT internal submission notification settings error:', error);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  },
);

internalFormNotificationSettings.post(
  '/api/forms-advanced/:id/submission-notification/revoke-links',
  async (c) => {
    try {
      const form = await internalForm(c);
      if (!form) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
      const editLinkEpoch = await bumpInternalFormEditLinkEpoch(c.env.DB, form.id);
      return c.json({ success: true, data: { editLinkEpoch } });
    } catch (error) {
      console.error('POST internal edit-link revocation error:', error);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  },
);
