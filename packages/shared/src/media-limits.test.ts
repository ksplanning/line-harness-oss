import { describe, expect, test } from 'vitest';
import * as shared from './index.js';

describe('LINE media limits (official values pinned 2026-07-21)', () => {
  test('exports one shared limit contract for web and worker', () => {
    expect((shared as Record<string, unknown>).LINE_MEDIA_LIMITS).toEqual({
      messageImageBytes: 10 * 1024 * 1024,
      previewImageBytes: 1 * 1024 * 1024,
      videoBytes: 200 * 1024 * 1024,
      audioBytes: 200 * 1024 * 1024,
      directUploadBytes: 100_000_000,
      imagemapImageBytes: 10 * 1024 * 1024,
      imagemapWidths: [240, 300, 460, 700, 1040],
      richMenuImageBytes: 1 * 1024 * 1024,
      flexImageBytes: 10 * 1024 * 1024,
      flexAnimatedImageBytes: 300 * 1024,
      flexIconBytes: 1 * 1024 * 1024,
    });
  });
});
