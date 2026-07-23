import type { PendingInternalUpload } from './internal-form-runtime.js';

export interface InternalFormAttachmentDescriptor {
  key: string;
  name: string;
  size: number;
  type: string;
}

export type InternalFormAttachmentRetentionResult =
  | {
      ok: true;
      retained: unknown[];
      removedIndexes: number[];
    }
  | { ok: false; error: 'invalid_attachment_removal' };

export interface StoredInternalFormUploads {
  attachmentsByField: Record<string, InternalFormAttachmentDescriptor[]>;
  uploadedKeys: string[];
}

const REMOVAL_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/;

/**
 * Resolve removal indexes against the exact stored list rendered to the editor.
 * Untouched values are intentionally not parsed or cloned so legacy descriptors
 * survive an unrelated edit byte-for-byte.
 */
export function retainInternalFormAttachments(
  existing: unknown,
  rawRemovalIndexes: readonly string[],
): InternalFormAttachmentRetentionResult {
  const entries = Array.isArray(existing) ? existing : [];
  const removed = new Set<number>();
  for (const rawIndex of rawRemovalIndexes) {
    if (!REMOVAL_INDEX_PATTERN.test(rawIndex)) {
      return { ok: false, error: 'invalid_attachment_removal' };
    }
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= entries.length) {
      return { ok: false, error: 'invalid_attachment_removal' };
    }
    removed.add(index);
  }
  const removedIndexes = [...removed].sort((left, right) => left - right);
  return {
    ok: true,
    retained: entries.filter((_entry, index) => !removed.has(index)),
    removedIndexes,
  };
}

/** Final persisted order: retained stored entries first, then freshly uploaded descriptors. */
export function mergeInternalFormAttachments(
  retained: readonly unknown[],
  additions: readonly InternalFormAttachmentDescriptor[],
): unknown[] {
  return [...retained, ...additions];
}

/**
 * Parse an answers_json entry without trusting its shape. When supplied, the
 * key prefix is also enforced before a render/download caller can touch R2.
 */
export function parseInternalFormAttachmentDescriptor(
  value: unknown,
  requiredKeyPrefix?: string,
): InternalFormAttachmentDescriptor | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.key !== 'string'
    || entry.key.length === 0
    || (requiredKeyPrefix !== undefined && !entry.key.startsWith(requiredKeyPrefix))
    || typeof entry.name !== 'string'
    || entry.name.length === 0
    || typeof entry.size !== 'number'
    || !Number.isSafeInteger(entry.size)
    || entry.size < 0
    || typeof entry.type !== 'string'
    || entry.type.length === 0
  ) return null;
  return {
    key: entry.key,
    name: entry.name,
    size: entry.size,
    type: entry.type,
  };
}

function uploadExtension(filename: string): string {
  const match = /\.([a-z0-9]{1,20})$/i.exec(filename);
  return match ? `.${match[1].toLowerCase()}` : '';
}

/** Best-effort cleanup for new objects which never became a committed answer. */
export async function rollbackInternalFormUploads(
  bucket: R2Bucket,
  keys: readonly string[],
): Promise<void> {
  await Promise.allSettled(keys.map((key) => bucket.delete(key)));
}

/**
 * Persist already-validated pending uploads using the original internal-form
 * R2 key and descriptor contract. A partial put failure cleans every attempted
 * key, including the key passed to the failed put.
 */
export async function storeInternalFormUploads(
  bucket: R2Bucket,
  formId: string,
  uploads: readonly PendingInternalUpload[],
): Promise<StoredInternalFormUploads> {
  const uploadedKeys: string[] = [];
  const attachmentsByField = Object.create(null) as Record<string, InternalFormAttachmentDescriptor[]>;
  try {
    for (const upload of uploads) {
      const metadata = attachmentsByField[upload.fieldId] ?? [];
      if (!Object.prototype.hasOwnProperty.call(attachmentsByField, upload.fieldId)) {
        Object.defineProperty(attachmentsByField, upload.fieldId, {
          configurable: true,
          enumerable: true,
          value: metadata,
          writable: true,
        });
      }
      for (const file of upload.files) {
        const key = `internal-form-submissions/${encodeURIComponent(formId)}/${encodeURIComponent(upload.fieldId)}/${crypto.randomUUID()}${uploadExtension(file.name)}`;
        const contentType = file.type || 'application/octet-stream';
        uploadedKeys.push(key);
        await bucket.put(key, file.stream(), {
          httpMetadata: { contentType },
        });
        metadata.push({
          key,
          name: file.name,
          size: file.size,
          type: contentType,
        });
      }
    }
    return { attachmentsByField, uploadedKeys };
  } catch (error) {
    await rollbackInternalFormUploads(bucket, uploadedKeys);
    throw error;
  }
}
