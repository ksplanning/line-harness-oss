import { Hono } from 'hono';
import { LINE_MEDIA_LIMITS } from '@line-crm/shared';
import type { Env } from '../index.js';

const images = new Hono<Env>();

type UploadKind = 'image' | 'video' | 'audio' | 'imagemap';

type UploadSpec = {
  maxBytes: number;
  maxLabel: string;
  allowedTypes: readonly string[];
};

const UPLOAD_KINDS = new Set<UploadKind>(['image', 'video', 'audio', 'imagemap']);
const IMAGEMAP_WIDTHS: readonly number[] = LINE_MEDIA_LIMITS.imagemapWidths;
const IMAGEMAP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uploadSpec(kind: UploadKind): UploadSpec {
  if (kind === 'video') {
    return {
      maxBytes: LINE_MEDIA_LIMITS.directUploadBytes,
      maxLabel: '100MB',
      allowedTypes: ['video/mp4'],
    };
  }
  if (kind === 'audio') {
    return {
      maxBytes: LINE_MEDIA_LIMITS.directUploadBytes,
      maxLabel: '100MB',
      // Browsers use all three MPEG-4 values for .m4a files. LINE also accepts
      // MP3, represented by the standard audio/mpeg media type.
      allowedTypes: ['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg'],
    };
  }
  if (kind === 'imagemap') {
    return {
      maxBytes: LINE_MEDIA_LIMITS.imagemapImageBytes,
      maxLabel: '10MB',
      allowedTypes: ['image/png', 'image/jpeg'],
    };
  }
  return {
    maxBytes: LINE_MEDIA_LIMITS.messageImageBytes,
    maxLabel: '10MB',
    // Keep the existing media-library contract. Message-specific callers
    // already narrow this to JPEG/PNG before upload.
    allowedTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  };
}

function parseUploadKind(raw: string | undefined): UploadKind | null {
  if (!raw) return 'image';
  return UPLOAD_KINDS.has(raw as UploadKind) ? raw as UploadKind : null;
}

function parseDeclaredLength(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'video/mp4') return 'mp4';
  if (mimeType === 'audio/mpeg') return 'mp3';
  if (mimeType.startsWith('audio/')) return 'm4a';
  return mimeType.split('/')[1] || 'bin';
}

function uploadKey(kind: UploadKind, id: string, mimeType: string, width?: number): string {
  if (kind === 'imagemap') return `imagemaps/${id}/${width}`;
  if (kind === 'video' || kind === 'audio') {
    return `media-direct/${kind}/${id}.${extensionFor(mimeType)}`;
  }
  return `media/${id}.${extensionFor(mimeType)}`;
}

type ResolvedByteRange = { start: number; end: number; length: number };

/** Resolve one RFC 9110 byte range after the R2 object size is known. */
function resolveByteRange(raw: string, totalSize: number): ResolvedByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw.trim());
  if (!match || totalSize <= 0 || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, totalSize);
    return { start: totalSize - length, end: totalSize - 1, length };
  }

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) return null;
  const requestedEnd = match[2] ? Number(match[2]) : totalSize - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  const end = Math.min(requestedEnd, totalSize - 1);
  return { start, end, length: end - start + 1 };
}

// POST /api/images — upload image or a purpose-scoped binary media variant.
// Existing callers omit `kind` and retain the media-library image contract.
images.post('/api/images', async (c) => {
  try {
    const kind = parseUploadKind(c.req.query('kind'));
    if (!kind) {
      return c.json({ success: false, error: 'Unsupported upload kind' }, 400);
    }

    const spec = uploadSpec(kind);
    const contentType = c.req.header('Content-Type') || '';

    let data: ArrayBuffer | ReadableStream<Uint8Array>;
    let mimeType: string;
    let filename: string | undefined;
    let size = 0;

    let imagemapWidth: number | undefined;
    if (kind === 'imagemap') {
      imagemapWidth = Number(c.req.query('width'));
      if (!Number.isInteger(imagemapWidth) || !IMAGEMAP_WIDTHS.includes(imagemapWidth)) {
        return c.json({
          success: false,
          error: `Unsupported imagemap width. Allowed: ${IMAGEMAP_WIDTHS.join(', ')}`,
        }, 400);
      }
    }

    const requestedId = kind === 'imagemap' ? c.req.query('id') : undefined;
    if (requestedId && !IMAGEMAP_ID_RE.test(requestedId)) {
      return c.json({ success: false, error: 'Invalid imagemap upload id' }, 400);
    }

    if (contentType.includes('application/json')) {
      if (kind !== 'image') {
        return c.json({ success: false, error: `${kind} requires a binary request body` }, 400);
      }
      const body = await c.req.json<{
        data: string;
        mimeType?: string;
        filename?: string;
      }>();

      if (!body.data) {
        return c.json({ success: false, error: 'data (base64) is required' }, 400);
      }

      let base64 = body.data;
      if (base64.startsWith('data:')) {
        const match = base64.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          base64 = match[2];
        }
      }
      mimeType ??= body.mimeType ?? 'image/png';
      filename = body.filename;

      const binary = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      data = binary.buffer;
      size = binary.byteLength;
    } else {
      mimeType = contentType.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
      if (!spec.allowedTypes.includes(mimeType)) {
        return c.json({
          success: false,
          error: `Unsupported ${kind} type: ${mimeType}. Allowed: ${spec.allowedTypes.join(', ')}`,
        }, 400);
      }

      const declaredLength = parseDeclaredLength(c.req.header('Content-Length'));
      if (declaredLength !== null && declaredLength > spec.maxBytes) {
        return c.json({ success: false, error: `${kind} too large (max ${spec.maxLabel})` }, kind === 'image' || kind === 'imagemap' ? 400 : 413);
      }

      // Browser Blob uploads carry Content-Length. Require it for every binary
      // upload so we can reject overages before reading the body and preserve
      // the fixed-length Request stream that Cloudflare R2 requires.
      if (declaredLength === null) {
        return c.json({
          success: false,
          error: `${kind} upload requires Content-Length (max ${spec.maxLabel})`,
        }, 411);
      }

      const requestBody = c.req.raw.body;
      if (!requestBody) {
        return c.json({ success: false, error: 'Binary request body is required' }, 400);
      }
      // Important Cloudflare R2 contract: retain the runtime's fixed-length
      // metadata by passing request.body directly. Re-wrapping it in a new
      // ReadableStream makes the length unknown and R2 rejects the upload.
      data = requestBody;
      size = declaredLength;
    }

    if (size > spec.maxBytes) {
      return c.json({ success: false, error: `${kind} too large (max ${spec.maxLabel})` }, 400);
    }

    if (!spec.allowedTypes.includes(mimeType)) {
      return c.json({
        success: false,
        error: `Unsupported ${kind} type: ${mimeType}. Allowed: ${spec.allowedTypes.join(', ')}`,
      }, 400);
    }

    const id = requestedId ?? crypto.randomUUID();
    // Only ordinary images stay under media/: GET /api/images is an image
    // library and must not start returning video/audio/imagemap objects.
    const key = uploadKey(kind, id, mimeType, imagemapWidth);

    const stored = await c.env.IMAGES.put(key, data, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { originalFilename: filename ?? key },
    });
    if (stored && Number.isSafeInteger(stored.size)) size = stored.size;

    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    const url = `${workerUrl}/images/${key}`;
    const baseUrl = kind === 'imagemap' ? `${workerUrl}/images/imagemaps/${id}` : undefined;

    return c.json({
      success: true,
      data: {
        id,
        key,
        url,
        mimeType,
        size,
        kind,
        ...(baseUrl ? { baseUrl, width: imagemapWidth } : {}),
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/images error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/images — list uploaded media library images (media/ prefix scope)
//
// R2 IMAGES バケットには broadcast 用アップロード (media/) 以外に受信画像 (incoming-*) や
// リッチメニュー素材 (rich-menus/*) も同居する。media/ prefix でスコープし混入を防ぐ (G15/T-M2)。
// R2 .list() は既定 1000 件 cutoff のため truncated 時は cursor を返し、UI が「もっと見る」で追う。
images.get('/api/images', async (c) => {
  try {
    const cursor = c.req.query('cursor') || undefined;
    const listed = await c.env.IMAGES.list({ prefix: 'media/', cursor });

    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    const items = listed.objects.map((obj) => ({
      key: obj.key,
      url: `${workerUrl}/images/${obj.key}`,
      size: obj.size,
      uploaded: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : String(obj.uploaded),
    }));

    return c.json({
      success: true,
      data: {
        items,
        cursor: listed.truncated ? listed.cursor : undefined,
      },
    });
  } catch (err) {
    console.error('GET /api/images error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /images/:key — serve image (public, no auth)
// key は slash を含みうる (media/xxx.png) ため wildcard param (`:key{.+}`) で受ける (T-M3)。
// 既存 flat key (legacy-uuid.png) も引き続き serve できる。
images.get('/images/:key{.+}', async (c) => {
  const key = c.req.param('key');
  // 回答添付は管理画面の回答データからのみ参照する private object。
  // 公開メディア用 route に key が渡っても存在を明かさず、R2 も読まない。
  if (key.startsWith('internal-form-submissions/')) {
    return c.json({ success: false, error: 'Image not found' }, 404);
  }
  const requestedRange = c.req.header('Range');
  if (requestedRange) {
    const metadata = await c.env.IMAGES.head(key);
    if (!metadata) {
      return c.json({ success: false, error: 'Image not found' }, 404);
    }

    const range = resolveByteRange(requestedRange, metadata.size);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${metadata.size}`,
          'Content-Length': '0',
        },
      });
    }

    const object = await c.env.IMAGES.get(key, {
      range: { offset: range.start, length: range.length },
    });
    if (!object) {
      return c.json({ success: false, error: 'Image not found' }, 404);
    }

    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || metadata.httpMetadata?.contentType || 'image/png');
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('ETag', object.httpEtag ?? `"${object.etag}"`);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`);
    headers.set('Content-Length', String(range.length));
    return new Response(object.body, { status: 206, headers });
  }

  const object = await c.env.IMAGES.get(key);

  if (!object) {
    return c.json({ success: false, error: 'Image not found' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/png');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag ?? `"${object.etag}"`);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(object.size));

  return new Response(object.body, { headers });
});

// DELETE /api/images/:key — delete image
// key は slash を含みうる (media/xxx.png) ため wildcard param 化 (T-M3)。既存 flat key も削除可。
images.delete('/api/images/:key{.+}', async (c) => {
  try {
    const key = c.req.param('key');
    await c.env.IMAGES.delete(key);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/images/:key error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { images };
