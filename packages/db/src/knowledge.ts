import { jstNow } from './utils';

/**
 * Phase B B-3 (T-C3) — 取込ナレッジの db 層 (保存/取得のみ・計算しない)。
 *
 * search_text は worker 層 (apps/worker/src/services/knowledge.ts の buildChunkSearchText) が
 * normalize→2-gram→空白連結で計算して渡す (db は保存のみ = 依存方向。packages/db は apps/worker を
 * import しない)。faqs (B-2) と同思想。knowledge_chunks_fts への反映は 092 の同期トリガが行う。
 */

export interface KnowledgeDocument {
  id: string;
  line_account_id: string | null;
  source_type: 'url' | 'text';
  source_url: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunk {
  id: string;
  source_doc_id: string;
  line_account_id: string | null;
  chunk_index: number;
  content: string;
  search_text: string;
  created_at: string;
  /** Vectorize upsert 確認後にセットされる embed 時刻 (JST)。null = 未 embed (backfill 対象 / B-4 T-D6)。 */
  embedded_at: string | null;
  /** どの embedding モデルで embed したか (モデル変更→再 embed 判定 / B-4 T-D6)。 */
  embed_model: string | null;
}

export interface CreateKnowledgeDocumentInput {
  lineAccountId: string | null;
  sourceType: 'url' | 'text';
  sourceUrl?: string | null;
  title?: string | null;
}

export async function createKnowledgeDocument(
  db: D1Database,
  input: CreateKnowledgeDocumentInput,
): Promise<KnowledgeDocument> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO knowledge_documents
         (id, line_account_id, source_type, source_url, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.lineAccountId ?? null, input.sourceType, input.sourceUrl ?? null, input.title ?? null, now, now)
    .run();
  return (await getKnowledgeDocumentById(db, id))!;
}

/**
 * 1 チャンクの保存用入力。content は取込時サニタイズ済のデータ領域テキスト、searchText は
 * worker 層が計算済の 2-gram 空白連結列 (db は保存のみ)。
 */
export interface KnowledgeChunkInput {
  chunkIndex: number;
  content: string;
  searchText: string;
}

/**
 * 1 資料の全チャンクを D1 batch で原子的に INSERT (途中失敗で部分挿入を残さない / Codex #18)。
 * chunk.line_account_id は親 document の line_account_id (呼出側が渡す) を全チャンクにコピー
 * (document と chunk のスコープ同値 / Codex #9・cross-account 漏洩防止)。
 * UNIQUE(source_doc_id, chunk_index) が再送/部分挿入の重複を弾く。
 */
export async function insertKnowledgeChunks(
  db: D1Database,
  sourceDocId: string,
  lineAccountId: string | null,
  chunks: KnowledgeChunkInput[],
): Promise<void> {
  if (chunks.length === 0) return;
  const now = jstNow();
  const stmts = chunks.map((ch) =>
    db
      .prepare(
        `INSERT INTO knowledge_chunks
           (id, source_doc_id, line_account_id, chunk_index, content, search_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), sourceDocId, lineAccountId, ch.chunkIndex, ch.content, ch.searchText, now),
  );
  await db.batch(stmts);
}

export async function getKnowledgeDocumentById(db: D1Database, id: string): Promise<KnowledgeDocument | null> {
  return db.prepare(`SELECT * FROM knowledge_documents WHERE id = ?`).bind(id).first<KnowledgeDocument>();
}

/**
 * account スコープ一覧 (global(null) + 指定 account)。faqs.getFaqs (packages/db/src/faqs.ts:30) と同一式。
 */
export async function listKnowledgeDocuments(
  db: D1Database,
  lineAccountId: string | null,
): Promise<KnowledgeDocument[]> {
  const result = await db
    .prepare(
      `SELECT * FROM knowledge_documents
        WHERE (line_account_id IS NULL OR line_account_id = ?)
        ORDER BY created_at DESC`,
    )
    .bind(lineAccountId)
    .all<KnowledgeDocument>();
  return result.results;
}

/**
 * 資料単位削除。D1 は migration-time FK off (M-5) につき CASCADE に依存せず、chunks を明示 DELETE →
 * document を DELETE の順に batch (chunks の ad トリガが knowledge_chunks_fts から除去)。
 * scope 検証 (accountScopeReject) は呼出 route が事前に行う (本 helper は保存操作のみ)。
 */
export async function deleteKnowledgeDocument(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM knowledge_chunks WHERE source_doc_id = ?`).bind(id),
    db.prepare(`DELETE FROM knowledge_documents WHERE id = ?`).bind(id),
  ]);
}

/**
 * 1 資料の全チャンクを chunk_index 順で返す (B-4 T-D6)。取込直後の embed / 資料削除時の Vectorize cleanup が
 * chunk.id を得るために使う (id は insertKnowledgeChunks が crypto.randomUUID で採番するため DB から読み戻す)。
 * embedded_at/embed_model 列 (093) を含む。scope 検証は呼出 route が行う (本 helper は取得のみ)。
 */
export async function getChunksBySourceDoc(db: D1Database, sourceDocId: string): Promise<KnowledgeChunk[]> {
  const result = await db
    .prepare(`SELECT * FROM knowledge_chunks WHERE source_doc_id = ? ORDER BY chunk_index`)
    .bind(sourceDocId)
    .all<KnowledgeChunk>();
  return result.results;
}

/**
 * Vectorize upsert 成功を確認した後に呼び、指定 id の chunk へ embed 時刻 (JST) と model を書く (B-4 T-D6)。
 * `embedded_at IS NULL` を backfill 対象にするため、upsert 確認前にセットしてはならない (spec §8)。
 * 空配列は no-op (SQL を発行しない)。冪等: 再実行は同じ id に新しい時刻を書くだけ。
 */
export async function markChunksEmbedded(db: D1Database, ids: string[], embedModel: string): Promise<void> {
  if (ids.length === 0) return;
  const now = jstNow();
  const placeholders = ids.map(() => '?').join(', ');
  await db
    .prepare(`UPDATE knowledge_chunks SET embedded_at = ?, embed_model = ? WHERE id IN (${placeholders})`)
    .bind(now, embedModel, ...ids)
    .run();
}

/**
 * まだ embed していない (embedded_at IS NULL) chunk を account スコープ (global(null) + 指定 account) で返す
 * (B-4 T-D6・冪等 backfill / 無料枠超過で defer した chunk の後追い embed 用)。listKnowledgeDocuments と同一の
 * account 式 (cross-account 漏洩防止 / M-account-scope)。
 */
export async function getUnembeddedChunks(
  db: D1Database,
  lineAccountId: string | null,
  limit = 200,
): Promise<KnowledgeChunk[]> {
  const result = await db
    .prepare(
      `SELECT * FROM knowledge_chunks
        WHERE embedded_at IS NULL
          AND (line_account_id IS NULL OR line_account_id = ?)
        ORDER BY created_at
        LIMIT ?`,
    )
    .bind(lineAccountId, limit)
    .all<KnowledgeChunk>();
  return result.results;
}

export interface DocumentChunkStat {
  chunkCount: number;
  embeddedCount: number;
}

// D1 の prepared statement bind 変数上限 (100) を account 条件 (+1) 込みで越えないための安全 batch サイズ
// (unanswered-inbox の本番事故 2026-05-08 と同じ IN×bind 上限を回避 / M-account-scope)。
const DOC_STATS_BATCH = 90;

/**
 * 資料 (docIds) 単位の chunk 総数 + embed 済 chunk 数 (embedded_at NOT NULL) を **account 条件付き JOIN 集計**で返す
 * (B-5 T-E2)。account 式は listKnowledgeDocuments と同一 (global(null) + 指定 account・他 account doc は集計対象外 =
 * cross-account 0 の二重防御)。docIds は bind 上限を超えないよう batch 分割 (§10)。戻りは chunk を持つ doc のみ
 * (chunk 0 の doc はキー無し → 呼出 route が {chunkCount:0, embeddedCount:0} を default にする)。空配列は SQL 非発行。
 */
export async function getDocumentChunkStats(
  db: D1Database,
  lineAccountId: string | null,
  docIds: string[],
): Promise<Record<string, DocumentChunkStat>> {
  const out: Record<string, DocumentChunkStat> = {};
  for (let i = 0; i < docIds.length; i += DOC_STATS_BATCH) {
    const batch = docIds.slice(i, i + DOC_STATS_BATCH);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(', ');
    const result = await db
      .prepare(
        `SELECT source_doc_id AS docId,
                COUNT(*) AS chunkCount,
                SUM(CASE WHEN embedded_at IS NOT NULL THEN 1 ELSE 0 END) AS embeddedCount
           FROM knowledge_chunks
          WHERE source_doc_id IN (${placeholders})
            AND (line_account_id IS NULL OR line_account_id = ?)
          GROUP BY source_doc_id`,
      )
      .bind(...batch, lineAccountId)
      .all<{ docId: string; chunkCount: number; embeddedCount: number }>();
    for (const r of result.results) {
      out[r.docId] = { chunkCount: Number(r.chunkCount), embeddedCount: Number(r.embeddedCount) };
    }
  }
  return out;
}

/**
 * embed 済 (embedded_at NOT NULL) chunk の総数を account スコープ (global(null) + 指定 account) で返す (B-5 T-E4)。
 * Vectorize stored dims の**下限推定** (embed 済数 × 埋込次元) に使う (§4-4)。孤児 Vectorize は数えられないため
 * 上限保証ではない。accountId=null は global のみ (listKnowledgeDocuments と同一 account 式)。
 */
export async function countEmbeddedChunks(db: D1Database, lineAccountId: string | null): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM knowledge_chunks
        WHERE embedded_at IS NOT NULL
          AND (line_account_id IS NULL OR line_account_id = ?)`,
    )
    .bind(lineAccountId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}
