// Form 単位の Formaloo outbound webhook 登録管理。
// provider の 201 を成功扱いせず、一覧 read-back で callback URL + submit flag=true を確認して初めて成功とする。

export type WebhookApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: string };

export interface FormalooWebhookApi {
  get(path: string): Promise<WebhookApiResult>;
  post(path: string, body?: unknown): Promise<WebhookApiResult>;
  request(method: string, path: string, body?: unknown): Promise<WebhookApiResult>;
  delete(path: string): Promise<WebhookApiResult>;
}

interface RemoteWebhook {
  id: string;
  url: string;
  submitEnabled: boolean;
}

export type EnsureResult =
  | { ok: true; webhookId: string; created: boolean }
  | { ok: false; reason: 'read_failed' | 'cleanup_failed' | 'create_failed' | 'read_back_failed' };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function collectWebhookRecords(root: unknown): Record<string, unknown>[] {
  if (Array.isArray(root)) return root.map(asRecord).filter((v): v is Record<string, unknown> => v !== null);
  const object = asRecord(root);
  if (!object) return [];

  const out: Record<string, unknown>[] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) {
      out.push(...value.map(asRecord).filter((v): v is Record<string, unknown> => v !== null));
      return;
    }
    const record = asRecord(value);
    if (record) out.push(record);
  };

  add(object.webhooks);
  add(object.webhook);
  const data = object.data;
  if (Array.isArray(data)) add(data);
  const dataObject = asRecord(data);
  if (dataObject) {
    add(dataObject.webhooks);
    add(dataObject.webhook);
    if (Array.isArray(dataObject.data)) add(dataObject.data);
  }
  return out;
}

function normalizeRemoteWebhook(record: Record<string, unknown>): RemoteWebhook | null {
  const idCandidate = record.slug ?? record.id ?? record.webhook_id;
  const urlCandidate = record.url ?? record.webhook_url ?? record.endpoint_url;
  if (typeof idCandidate !== 'string' || !idCandidate) return null;
  if (typeof urlCandidate !== 'string' || !urlCandidate) return null;
  const events = asRecord(record.events);
  const submitEnabled = record.form_submit_events === true || events?.form_submit_events === true;
  return { id: idCandidate, url: urlCandidate, submitEnabled };
}

function remoteWebhooks(root: unknown): RemoteWebhook[] {
  return collectWebhookRecords(root)
    .map(normalizeRemoteWebhook)
    .filter((value): value is RemoteWebhook => value !== null);
}

function responseWebhookId(root: unknown): string | null {
  for (const record of collectWebhookRecords(root)) {
    const candidate = record.slug ?? record.id ?? record.webhook_id;
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}

function collectionPath(formSlug: string): string {
  return `/v3.0/forms/${encodeURIComponent(formSlug)}/webhooks/`;
}

export async function removeFormalooInstantWebhook(
  client: FormalooWebhookApi,
  input: { formSlug: string; webhookId: string | null; callbackUrl: string },
): Promise<{ ok: boolean }> {
  const path = collectionPath(input.formSlug);
  if (!input.webhookId) {
    // POST の response/read-back が timeout した場合も URL は D1 に先行保存済み。
    // fresh deadline の OFF request で同 URL を列挙し、成否不明の remote を忘れず回収する。
    const listed = await client.get(path);
    if (!listed.ok) return { ok: listed.status === 404 };
    const matches = remoteWebhooks(listed.data).filter((webhook) => webhook.url === input.callbackUrl);
    for (const match of matches) {
      const removed = await removeFormalooInstantWebhook(client, {
        formSlug: input.formSlug,
        webhookId: match.id,
        callbackUrl: input.callbackUrl,
      });
      if (!removed.ok) return { ok: false };
    }
    return { ok: true };
  }
  // spike で確認した form-scoped collection DELETE を第一経路にする。URL も渡し、別 callback を対象にしない。
  const primary = await client.request('DELETE', path, {
    id: input.webhookId,
    url: input.callbackUrl,
  });
  if (primary.ok || primary.status === 404) return { ok: true };

  // provider variant 用の bounded fallback。1回だけ stored remote id path を試す。
  if (primary.status === 400 || primary.status === 405) {
    const fallback = await client.delete(`${path}${encodeURIComponent(input.webhookId)}/`);
    return { ok: fallback.ok || fallback.status === 404 };
  }
  return { ok: false };
}

export async function ensureFormalooInstantWebhook(
  client: FormalooWebhookApi,
  input: { formSlug: string; callbackUrl: string },
): Promise<EnsureResult> {
  const path = collectionPath(input.formSlug);
  const before = await client.get(path);
  if (!before.ok) return { ok: false, reason: 'read_failed' };

  const matchingBefore = remoteWebhooks(before.data).filter((webhook) => webhook.url === input.callbackUrl);
  const ready = matchingBefore.find((webhook) => webhook.submitEnabled);
  if (ready) {
    // lease takeover や旧実装の並行 POST が残した同 URL 登録を1件へ収束させる。
    for (const duplicate of matchingBefore) {
      if (duplicate.id === ready.id) continue;
      const removed = await removeFormalooInstantWebhook(client, {
        formSlug: input.formSlug,
        webhookId: duplicate.id,
        callbackUrl: input.callbackUrl,
      });
      if (!removed.ok) return { ok: false, reason: 'cleanup_failed' };
    }
    return { ok: true, webhookId: ready.id, created: false };
  }

  // 同じ callback URL の soft registration が残っていたら先に除去し、重複 POST を避ける。
  for (const stale of matchingBefore) {
    const removed = await removeFormalooInstantWebhook(client, {
      formSlug: input.formSlug,
      webhookId: stale.id,
      callbackUrl: input.callbackUrl,
    });
    if (!removed.ok) return { ok: false, reason: 'cleanup_failed' };
  }

  const created = await client.post(path, {
    url: input.callbackUrl,
    form_submit_events: true,
    form_update_events: false,
  });
  if (!created.ok) return { ok: false, reason: 'create_failed' };

  const after = await client.get(path);
  if (after.ok) {
    const matchingAfter = remoteWebhooks(after.data)
      .filter((webhook) => webhook.url === input.callbackUrl);
    const verified = matchingAfter.find((webhook) => webhook.submitEnabled);
    if (verified) {
      for (const duplicate of matchingAfter) {
        if (duplicate.id === verified.id) continue;
        const removed = await removeFormalooInstantWebhook(client, {
          formSlug: input.formSlug,
          webhookId: duplicate.id,
          callbackUrl: input.callbackUrl,
        });
        if (!removed.ok) return { ok: false, reason: 'cleanup_failed' };
      }
      return { ok: true, webhookId: verified.id, created: true };
    }
  }

  // soft-201 の remote 残骸を best-effort cleanup。D1 は有効化しない。
  const unverified = after.ok
    ? remoteWebhooks(after.data).find((webhook) => webhook.url === input.callbackUrl)
    : undefined;
  const createdId = unverified?.id ?? responseWebhookId(created.data);
  if (createdId) {
    await removeFormalooInstantWebhook(client, {
      formSlug: input.formSlug,
      webhookId: createdId,
      callbackUrl: input.callbackUrl,
    });
  }
  return { ok: false, reason: 'read_back_failed' };
}
