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
