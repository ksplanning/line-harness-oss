import { describe, expect, test, vi } from 'vitest';
import {
  mergeInternalFormAttachments,
  parseInternalFormAttachmentDescriptor,
  retainInternalFormAttachments,
  rollbackInternalFormUploads,
  storeInternalFormUploads,
  type InternalFormAttachmentDescriptor,
} from './internal-form-attachments.js';

function descriptor(name: string, key = `internal-form-submissions/form-1/docs/${name}`): InternalFormAttachmentDescriptor {
  return { key, name, size: name.length, type: 'application/pdf' };
}

function r2Stub(options: { failAt?: number; deleteFailsAt?: number } = {}) {
  let putCount = 0;
  let deleteCount = 0;
  const putError = new Error('R2 put failed');
  const put = vi.fn(async () => {
    putCount += 1;
    if (putCount === options.failAt) throw putError;
    return {};
  });
  const del = vi.fn(async () => {
    deleteCount += 1;
    if (deleteCount === options.deleteFailsAt) throw new Error('R2 delete failed');
  });
  return {
    bucket: { put, delete: del } as unknown as R2Bucket,
    del,
    put,
    putError,
  };
}

describe('retainInternalFormAttachments', () => {
  test('deduplicates strict indexes and preserves every untouched entry verbatim', () => {
    const first = descriptor('first.pdf');
    const removed = { legacy: true };
    const last = descriptor('last.pdf');

    const result = retainInternalFormAttachments([first, removed, last], ['1', '1']);

    expect(result).toEqual({ ok: true, retained: [first, last], removedIndexes: [1] });
    if (!result.ok) return;
    expect(result.retained[0]).toBe(first);
    expect(result.retained[1]).toBe(last);
  });

  test.each([
    ['', 'empty'],
    ['01', 'leading zero'],
    ['-1', 'negative'],
    ['1.0', 'decimal'],
    [' 1', 'whitespace'],
    ['2', 'out of range'],
  ])('rejects %s as an invalid removal index (%s)', (index) => {
    expect(retainInternalFormAttachments([descriptor('a.pdf'), descriptor('b.pdf')], [index]))
      .toEqual({ ok: false, error: 'invalid_attachment_removal' });
  });

  test('treats a non-array stored value as an empty list without inventing entries', () => {
    expect(retainInternalFormAttachments({ unexpected: true }, []))
      .toEqual({ ok: true, retained: [], removedIndexes: [] });
    expect(retainInternalFormAttachments(null, ['0']))
      .toEqual({ ok: false, error: 'invalid_attachment_removal' });
  });
});

describe('mergeInternalFormAttachments', () => {
  test('keeps final order as retained existing entries followed by additions', () => {
    const kept = descriptor('kept.pdf');
    const addedOne = descriptor('added-1.pdf');
    const addedTwo = descriptor('added-2.pdf');

    const finalList = mergeInternalFormAttachments([kept], [addedOne, addedTwo]);

    expect(finalList).toEqual([kept, addedOne, addedTwo]);
    expect(finalList[0]).toBe(kept);
  });
});

describe('parseInternalFormAttachmentDescriptor', () => {
  test('returns a safe copy of a complete descriptor within the requested key prefix', () => {
    const stored = descriptor('estimate.pdf');

    const parsed = parseInternalFormAttachmentDescriptor(
      stored,
      'internal-form-submissions/form-1/',
    );

    expect(parsed).toEqual(stored);
    expect(parsed).not.toBe(stored);
  });

  test.each([
    null,
    [],
    {},
    { key: '', name: 'a.pdf', size: 1, type: 'application/pdf' },
    { key: 'internal-form-submissions/form-1/docs/a.pdf', name: '', size: 1, type: 'application/pdf' },
    { key: 'internal-form-submissions/form-1/docs/a.pdf', name: 'a.pdf', size: -1, type: 'application/pdf' },
    { key: 'internal-form-submissions/form-1/docs/a.pdf', name: 'a.pdf', size: 1.5, type: 'application/pdf' },
    { key: 'internal-form-submissions/form-1/docs/a.pdf', name: 'a.pdf', size: 1, type: '' },
  ])('rejects a malformed stored descriptor: %j', (stored) => {
    expect(parseInternalFormAttachmentDescriptor(stored)).toBeNull();
  });

  test('rejects a structurally valid descriptor outside the required form prefix', () => {
    const stored = descriptor(
      'foreign.pdf',
      'internal-form-submissions/other-form/docs/foreign.pdf',
    );

    expect(parseInternalFormAttachmentDescriptor(
      stored,
      'internal-form-submissions/form-1/',
    )).toBeNull();
  });
});

describe('storeInternalFormUploads', () => {
  test('uses the existing private key, metadata, and content-type descriptor semantics', async () => {
    const r2 = r2Stub();
    const pdf = new File(['pdf'], 'Estimate.PDF', { type: 'application/pdf' });
    const extensionless = new File(['raw'], 'README');

    const stored = await storeInternalFormUploads(r2.bucket, 'form / 日本', [{
      fieldId: 'docs / 日本',
      fieldIndex: 7,
      files: [pdf, extensionless],
    }]);

    expect(r2.put).toHaveBeenCalledTimes(2);
    const firstKey = String(r2.put.mock.calls[0]?.[0]);
    const secondKey = String(r2.put.mock.calls[1]?.[0]);
    const prefix = 'internal-form-submissions/form%20%2F%20%E6%97%A5%E6%9C%AC/docs%20%2F%20%E6%97%A5%E6%9C%AC/';
    expect(firstKey).toMatch(new RegExp(`^${prefix}[0-9a-f-]+\\.pdf$`));
    expect(secondKey).toMatch(new RegExp(`^${prefix}[0-9a-f-]+$`));
    expect(r2.put.mock.calls[0]?.[2]).toEqual({
      httpMetadata: { contentType: 'application/pdf' },
    });
    expect(r2.put.mock.calls[1]?.[2]).toEqual({
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    expect(stored.uploadedKeys).toEqual([firstKey, secondKey]);
    expect(stored.attachmentsByField['docs / 日本']).toEqual([
      { key: firstKey, name: 'Estimate.PDF', size: 3, type: 'application/pdf' },
      { key: secondKey, name: 'README', size: 3, type: 'application/octet-stream' },
    ]);
    expect(r2.del).not.toHaveBeenCalled();
  });

  test('rolls back every attempted key, including the key whose put failed', async () => {
    const r2 = r2Stub({ failAt: 2 });
    const files = [
      new File(['one'], 'one.pdf', { type: 'application/pdf' }),
      new File(['two'], 'two.pdf', { type: 'application/pdf' }),
    ];

    await expect(storeInternalFormUploads(r2.bucket, 'form-1', [{
      fieldId: 'docs', fieldIndex: 0, files,
    }])).rejects.toBe(r2.putError);

    const attemptedKeys = r2.put.mock.calls.map(([key]) => key);
    expect(r2.del.mock.calls.map(([key]) => key)).toEqual(attemptedKeys);
  });
});

describe('rollbackInternalFormUploads', () => {
  test('attempts every deletion and resolves even when one delete fails', async () => {
    const r2 = r2Stub({ deleteFailsAt: 1 });

    await expect(rollbackInternalFormUploads(r2.bucket, ['new-1', 'new-2']))
      .resolves.toBeUndefined();
    expect(r2.del.mock.calls.map(([key]) => key)).toEqual(['new-1', 'new-2']);
    expect(r2.del).toHaveBeenCalledTimes(2);
  });
});
