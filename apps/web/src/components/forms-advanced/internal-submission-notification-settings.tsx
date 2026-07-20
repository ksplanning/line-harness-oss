'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  isDecorationType,
  previewInternalSubmissionNotification,
  type InternalSubmissionNotificationField,
} from '@line-crm/shared';
import {
  internalFormNotificationApi,
  type InternalFormNotificationSettings,
} from '@/lib/internal-form-notification-api';

export interface InternalSubmissionNotificationSettingsProps {
  formId: string;
  formTitle: string;
  fields: readonly InternalSubmissionNotificationField[];
}

type Feedback = { kind: 'error' | 'success'; text: string };

function requestError(error: unknown, fallback: string): string {
  const body = (error as { body?: { error?: unknown } })?.body;
  if (typeof body?.error === 'string' && body.error.trim()) return body.error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function uniqueAnswerFields(
  fields: readonly InternalSubmissionNotificationField[],
): InternalSubmissionNotificationField[] {
  const answers = fields.filter((field) => !isDecorationType(field.type) && field.label.trim());
  const counts = new Map<string, number>();
  for (const field of answers) counts.set(field.label, (counts.get(field.label) ?? 0) + 1);
  return answers.filter((field) => counts.get(field.label) === 1);
}

export default function InternalSubmissionNotificationSettings({
  formId,
  formTitle,
  fields,
}: InternalSubmissionNotificationSettingsProps) {
  const [settings, setSettings] = useState<InternalFormNotificationSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [recipientEmailFieldId, setRecipientEmailFieldId] = useState('');
  const [messageTemplate, setMessageTemplate] = useState('');
  const [editLinkEpoch, setEditLinkEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);

  const emailFields = useMemo(
    () => fields.filter((field) => field.type === 'email'),
    [fields],
  );
  const emailFieldsRef = useRef(emailFields);
  emailFieldsRef.current = emailFields;
  const variableFields = useMemo(() => uniqueAnswerFields(fields), [fields]);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setFeedback(null);
    void internalFormNotificationApi.get(formId)
      .then((next) => {
        if (cancelled) return;
        const knownEmail = emailFieldsRef.current.some((field) => field.id === next.recipientEmailFieldId)
          ? next.recipientEmailFieldId ?? ''
          : '';
        setSettings(next);
        setEnabled(next.enabled);
        setRecipientEmailFieldId(knownEmail);
        setMessageTemplate(next.messageTemplate ?? '');
        setEditLinkEpoch(next.editLinkEpoch);
      })
      .catch((error) => {
        if (!cancelled) {
          setFeedback({
            kind: 'error',
            text: requestError(error, '通知設定を読み込めませんでした。もう一度お試しください。'),
          });
        }
      });
    return () => { cancelled = true; };
  }, [formId]);

  useEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    pendingCaretRef.current = null;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(caret, caret);
  }, [messageTemplate]);

  const preview = previewInternalSubmissionNotification({
    template: messageTemplate,
    formTitle,
    fields,
  });

  const changeDraft = (change: () => void) => {
    setFeedback(null);
    change();
  };

  const insertVariable = (token: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? messageTemplate.length;
    const end = textarea?.selectionEnd ?? start;
    const next = `${messageTemplate.slice(0, start)}${token}${messageTemplate.slice(end)}`;
    pendingCaretRef.current = start + token.length;
    changeDraft(() => setMessageTemplate(next));
  };

  const save = async () => {
    if (busy || !settings || !preview.ok) return;
    if (enabled && !emailFields.some((field) => field.id === recipientEmailFieldId)) {
      setFeedback({ kind: 'error', text: '回答者本人のメール項目を選んでください' });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      const next = await internalFormNotificationApi.save(formId, {
        enabled,
        recipientEmailFieldId: recipientEmailFieldId || null,
        messageTemplate: messageTemplate.trim() ? messageTemplate : null,
      });
      setSettings(next);
      setEnabled(next.enabled);
      setRecipientEmailFieldId(next.recipientEmailFieldId ?? '');
      setMessageTemplate(next.messageTemplate ?? '');
      setEditLinkEpoch(next.editLinkEpoch);
      setFeedback({ kind: 'success', text: '通知設定を保存しました' });
    } catch (error) {
      setFeedback({
        kind: 'error',
        text: requestError(error, '通知設定を保存できませんでした。入力内容を保ったまま、もう一度お試しください。'),
      });
    } finally {
      setBusy(false);
    }
  };

  const revokeLinks = async () => {
    if (busy || !settings) return;
    if (!window.confirm('これまでに発行した編集リンクをすべて使えなくします。よろしいですか？')) return;

    setBusy(true);
    setFeedback(null);
    try {
      const nextEpoch = await internalFormNotificationApi.revokeLinks(formId);
      setEditLinkEpoch(nextEpoch);
      setSettings((current) => current ? { ...current, editLinkEpoch: nextEpoch } : current);
      setFeedback({ kind: 'success', text: '以前の編集リンクを失効しました' });
    } catch (error) {
      setFeedback({
        kind: 'error',
        text: requestError(error, '編集リンクを失効できませんでした。もう一度お試しください。'),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="internal-submission-notification-settings"
      className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 text-sm"
    >
      {!settings ? (
        <>
          <h2 className="font-semibold text-gray-900">回答後の自動通知</h2>
          {!feedback && <p className="text-xs text-gray-500">通知設定を読み込んでいます…</p>}
          {feedback?.kind === 'error' && <p role="alert" className="text-xs text-red-600">{feedback.text}</p>}
        </>
      ) : (
        <>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold text-gray-900">回答後の自動通知</h2>
              <p className="mt-1 text-xs leading-5 text-gray-500">
                LINEから回答した方にはLINE、埋め込みフォームから回答した方にはメールで、回答内容と編集リンクを送ります。
              </p>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-xs font-semibold">
              <span data-testid="notification-enabled-status" className={enabled ? 'text-green-600' : 'text-gray-400'}>
                {enabled ? 'ON' : 'OFF'}
              </span>
              <input
                type="checkbox"
                aria-label="回答後の自動通知"
                checked={enabled}
                disabled={busy}
                onChange={(event) => changeDraft(() => setEnabled(event.target.checked))}
                className="h-4 w-4 accent-green-600"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-gray-700">回答者本人のメール項目</span>
            <select
              aria-label="回答者本人のメール項目"
              value={recipientEmailFieldId}
              disabled={busy}
              onChange={(event) => changeDraft(() => setRecipientEmailFieldId(event.target.value))}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">選択してください</option>
              {emailFields.map((field) => <option key={field.id} value={field.id}>{field.label}</option>)}
            </select>
            <span className="mt-1 block text-[11px] leading-4 text-gray-500">
              埋め込みフォーム経由の通知は、ここで選んだ回答欄のアドレスだけに送られます。
            </span>
          </label>

          <div>
            <div className="mb-1 text-xs font-semibold text-gray-700">使える変数</div>
            <div className="flex flex-wrap gap-1.5">
              {[
                '{{display_name}}',
                ...variableFields.map((field) => `{{回答:${field.label}}}`),
                '{{編集リンク}}',
              ].map((token) => (
                <button
                  key={token}
                  type="button"
                  aria-label={`${token} を差し込む`}
                  disabled={busy}
                  onClick={() => insertVariable(token)}
                  className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-[11px] text-gray-700 hover:bg-gray-100"
                >
                  {token}
                </button>
              ))}
            </div>
            {fields.some((field) => !isDecorationType(field.type) && field.label.trim()
              && !variableFields.includes(field)) && (
              <p className="mt-1 text-[11px] text-amber-600">
                同じ名前の回答項目は取り違え防止のため変数にできません。項目名を別々にしてください。
              </p>
            )}
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-gray-700">通知文面</span>
            <textarea
              ref={textareaRef}
              aria-label="通知文面"
              dir="auto"
              value={messageTemplate}
              disabled={busy}
              maxLength={10_000}
              rows={8}
              placeholder="空欄なら、すべての回答と編集リンクを読みやすい既定文面で送ります"
              onChange={(event) => changeDraft(() => setMessageTemplate(event.target.value))}
              className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm leading-6"
            />
            <span className="mt-1 block text-[11px] text-gray-500">
              空欄でも送信できます。その場合はフォームの全回答を一覧にした既定文面を使います。
            </span>
          </label>

          <div>
            <div className="mb-1 text-xs font-semibold text-gray-700">実際に届く文面のプレビュー</div>
            {preview.ok ? (
              <pre
                data-testid="notification-preview"
                dir="auto"
                aria-live="polite"
                className="whitespace-pre-wrap rounded-md bg-gray-50 p-3 text-xs leading-5 text-gray-800"
              >
                {preview.text}
              </pre>
            ) : (
              <p role="alert" className="text-xs text-red-600">{preview.validation.error}</p>
            )}
          </div>

          {feedback && (
            <p
              role={feedback.kind === 'error' ? 'alert' : 'status'}
              className={feedback.kind === 'error' ? 'text-xs text-red-600' : 'text-xs text-green-700'}
            >
              {feedback.text}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-4">
            <button
              type="button"
              disabled={busy || !preview.ok}
              onClick={() => { void save(); }}
              className="rounded-md bg-green-600 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? '処理中…' : '通知設定を保存'}
            </button>

            <div className="flex items-center gap-3">
              <span data-testid="edit-link-epoch" className="text-[11px] text-gray-400">
                現在の世代: {editLinkEpoch}
              </span>
              <button
                type="button"
                aria-label="発行済みの編集リンクを失効"
                disabled={busy}
                onClick={() => { void revokeLinks(); }}
                className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50"
              >
                発行済みの編集リンクを失効
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
