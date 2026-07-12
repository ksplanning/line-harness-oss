#!/usr/bin/env node
/**
 * line-staff-docs-chat T-A8 (Codex BLOCKER-3) — スタッフ資料 seed の実行方式。
 *
 * Cloudflare Worker は filesystem を読めない (FS 非対応)。よって repo の docs/staff-guide/*.md を **local Node
 * script (本ファイル)** が FS 読取して manifest を組み、admin 専用 `POST /api/staff-docs/seed` (Bearer API_KEY =
 * owner 認証) へ送る。Worker 側は manifest を受けて corpus に取込むだけ (FS を一切読まない)。
 *
 * executor = owner / 運用者 手動 or CI。冪等 (stable docKey = ファイル名) ゆえ何度流しても重複しない。
 * 部分失敗は retry (指数バックオフ) で再開でき、seed endpoint の戻り (revision→chunkId/docId) を出力する。
 *
 * 使い方:
 *   WORKER_URL=https://<worker> API_KEY=<admin key> node scripts/seed-staff-docs.mjs [--dir docs/staff-guide] [--dry-run]
 *   もしくは: node scripts/seed-staff-docs.mjs --worker-url https://... --api-key ... --dir docs/staff-guide
 *
 * docKey = ファイル名 (.md 抜き / stable)。title = 先頭の "# 見出し" or ファイル名。content = 本文全体。
 * 秘密値 (API_KEY) は argv/env で受け取り、ログには出さない (PUBLIC OSS / D-2)。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

function parseArgs(argv) {
  const args = { dir: 'docs/staff-guide', dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--worker-url') args.workerUrl = argv[++i];
    else if (a === '--api-key') args.apiKey = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
  }
  args.workerUrl = args.workerUrl ?? process.env.WORKER_URL ?? process.env.WORKER_PUBLIC_URL;
  args.apiKey = args.apiKey ?? process.env.API_KEY ?? process.env.ADMIN_API_KEY;
  return args;
}

/** md 本文の先頭 "# 見出し" を title にする (無ければ docKey)。 */
function extractTitle(content, docKey) {
  const m = content.match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : docKey;
}

/** docs/staff-guide/*.md → [{docKey, title, content}] の manifest を FS から組む。 */
function buildManifest(dir) {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new Error(`docs dir not found: ${abs}`);
  const files = readdirSync(abs).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  return files.map((f) => {
    const content = readFileSync(join(abs, f), 'utf8');
    const docKey = basename(f, '.md');
    return { docKey, title: extractTitle(content, docKey), content };
  });
}

async function postSeed(workerUrl, apiKey, docs, { retries = 3 } = {}) {
  const url = `${workerUrl.replace(/\/$/, '')}/api/staff-docs/seed`;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ docs }),
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const wait = 1000 * 2 ** (attempt - 1);
        console.error(`[seed] attempt ${attempt} failed (${e.message}); retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function main() {
  const args = parseArgs(process.argv);
  const docs = buildManifest(args.dir);
  if (docs.length === 0) {
    console.error(`[seed] no *.md found in ${args.dir}. nothing to seed.`);
    process.exit(1);
  }
  console.log(`[seed] manifest: ${docs.length} docs (${docs.map((d) => d.docKey).join(', ')})`);

  if (args.dryRun) {
    console.log('[seed] --dry-run: manifest built, not sending.');
    for (const d of docs) console.log(`  - ${d.docKey} :: "${d.title}" (${d.content.length} chars)`);
    return;
  }
  if (!args.workerUrl) throw new Error('WORKER_URL is required (env WORKER_URL or --worker-url).');
  if (!args.apiKey) throw new Error('API_KEY is required (env API_KEY or --api-key). Bearer=owner.');

  const result = await postSeed(args.workerUrl, args.apiKey, docs);
  const data = result?.data ?? result;
  console.log(
    `[seed] done. revision=${data.revision} created=${data.created} updated=${data.updated} unchanged=${data.unchanged} deleted=${data.deleted}`,
  );
  // O-1 点灯前 precondition: embed 被覆を surface (created の成功 ≠ 検索可能)。embedPending>0 は
  // 「資料が chat で検索できない = 質問すると必ず no_evidence」を意味する → 点灯前に provisioning/backfill を要す。
  if (typeof data.embedded === 'number' || typeof data.embedPending === 'number') {
    console.log(`[seed] embed coverage: embedded=${data.embedded ?? '?'} embedPending=${data.embedPending ?? '?'}`);
    if ((data.embedPending ?? 0) > 0) {
      console.error(
        `[seed] WARNING: ${data.embedPending} staff chunk(s) are NOT embedded (embedded_at NULL). ` +
          `chat will fail-closed (no_evidence) for these until Vectorize is provisioned / backfilled. ` +
          `Do NOT flip STAFF_DOCS_ENABLED for positive-path use while embedPending > 0.`,
      );
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`[seed] FAILED: ${e.message}`);
  process.exit(1);
});
