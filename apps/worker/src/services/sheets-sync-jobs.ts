import {
  getSheetsConnection,
  listActiveSheetsConnectionsForSync,
  toJstString,
  updateSheetsSyncStatus,
  type SheetsConnection,
  type SheetsSyncAuditSource,
  type SheetsSyncTarget,
} from '@line-crm/db';
import {
  drainFriendLedgerWebhookEvents,
  syncFriendLedger,
  type FriendLedgerChunkCursor,
  type FriendLedgerSyncResult,
  type SyncFriendLedgerOptions,
} from './friend-ledger-sync.js';
import {
  drainFormResultsWebhookEvents,
  syncFormResults,
  type FormResultsChunkCursor,
  type FormResultsSyncResult,
  type SyncFormResultsOptions,
} from './form-results-sync.js';

export const SHEETS_SYNC_CHUNK_SIZE = 200;
const JOB_LOCK_MS = 5 * 60_000;
const SAFE_ERROR_MESSAGE = '同期が途中で止まりました。接続設定を確認して、続きから再開してください。';
const DISPATCH_ERROR_MESSAGE = '次の同期処理を開始できませんでした。続きから再開してください。';
const RECOVERY_WARNING = '前回の同期が途中で止まりました。保存済みの続きから再開しました。';

type StoredSheetsSyncJobStatus = 'running' | 'completed' | 'warning' | 'failed';
export type SheetsSyncJobStatus = 'running' | 'success' | 'warning' | 'error';
export type SheetsSyncJobSource = Extract<SheetsSyncAuditSource, 'manual' | 'polling'>;

interface SheetsSyncJobRow {
  id: string;
  connection_id: string;
  line_account_id: string;
  config_version: number;
  source: SheetsSyncJobSource;
  actor: string;
  target: SheetsSyncTarget;
  status: StoredSheetsSyncJobStatus;
  total_count: number;
  processed_count: number;
  last_friend_created_at: string | null;
  last_record_key: string | null;
  snapshot_friend_created_at: string | null;
  snapshot_record_key: string | null;
  appended_rows: number;
  updated_rows: number;
  imported_fields: number;
  ignored_identity_edits: number;
  warning_message: string | null;
  error_code: string | null;
  error_message: string | null;
  lock_token: string | null;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SheetsSyncJob {
  id: string;
  connectionId: string;
  lineAccountId: string;
  configVersion: number;
  source: SheetsSyncJobSource;
  actor: string;
  target: SheetsSyncTarget;
  status: SheetsSyncJobStatus;
  totalCount: number;
  processedCount: number;
  /** Ledger jobs: friend created_at cursor. Results jobs: submission submitted_at cursor. */
  lastFriendCreatedAt: string | null;
  /** Ledger jobs: friend id cursor. Results jobs: submission id cursor. */
  lastFriendId: string | null;
  appendedRows: number;
  updatedRows: number;
  importedFields: number;
  ignoredIdentityEdits: number;
  warning: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function publicStatus(status: StoredSheetsSyncJobStatus): SheetsSyncJobStatus {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  return status;
}

function serializeJob(row: SheetsSyncJobRow): SheetsSyncJob {
  return {
    id: row.id,
    connectionId: row.connection_id,
    lineAccountId: row.line_account_id,
    configVersion: row.config_version,
    source: row.source,
    actor: row.actor,
    target: row.target,
    status: publicStatus(row.status),
    totalCount: row.total_count,
    processedCount: row.processed_count,
    lastFriendCreatedAt: row.last_friend_created_at,
    lastFriendId: row.last_record_key,
    appendedRows: row.appended_rows,
    updatedRows: row.updated_rows,
    importedFields: row.imported_fields,
    ignoredIdentityEdits: row.ignored_identity_edits,
    warning: row.warning_message,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function cleanActor(actor: string, source: SheetsSyncJobSource): string {
  const cleaned = actor.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 320);
  return cleaned || (source === 'polling' ? 'system_poll' : 'owner');
}

function truncateDiagnostic(value: string | null): string | null {
  return value ? value.slice(0, 500) : null;
}

function mergeWarning(previous: string | null, current: string | null): string | null {
  if (!current) return previous;
  if (!previous || previous === current || previous.includes(current)) return truncateDiagnostic(previous ?? current);
  return truncateDiagnostic(`${previous} / ${current}`);
}

async function jobById(db: D1Database, id: string): Promise<SheetsSyncJobRow | null> {
  return db.prepare('SELECT * FROM sheets_sync_jobs WHERE id = ?')
    .bind(id)
    .first<SheetsSyncJobRow>();
}

export async function getLatestSheetsSyncJob(
  db: D1Database,
  lineAccountId: string,
  connectionId: string,
  target?: SheetsSyncTarget,
): Promise<SheetsSyncJob | null> {
  const row = await db.prepare(
    `SELECT * FROM sheets_sync_jobs
     WHERE line_account_id = ? AND connection_id = ?
       AND (? IS NULL OR target = ?)
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(lineAccountId, connectionId, target ?? null, target ?? null).first<SheetsSyncJobRow>();
  return row ? serializeJob(row) : null;
}

export async function startSheetsSyncJob(options: {
  db: D1Database;
  connection: SheetsConnection;
  source: SheetsSyncJobSource;
  actor: string;
  target?: SheetsSyncTarget;
}): Promise<SheetsSyncJob> {
  const actor = cleanActor(options.actor, options.source);
  const target: SheetsSyncTarget = options.target ?? 'ledger';
  const running = await options.db.prepare(
    `SELECT * FROM sheets_sync_jobs
     WHERE connection_id = ? AND target = ? AND status = 'running'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(options.connection.id, target).first<SheetsSyncJobRow>();
  if (running?.config_version === options.connection.configVersion) return serializeJob(running);
  if (running) {
    await options.db.prepare(
      `UPDATE sheets_sync_jobs SET status = 'failed',
         error_code = 'sheets_connection_changed',
         error_message = '同期設定が変更されたため、この処理を終了しました。もう一度同期してください。',
         lock_token = NULL, locked_until = NULL,
         completed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       WHERE id = ? AND status = 'running'`,
    ).bind(running.id).run();
  }

  const failed = await options.db.prepare(
    `SELECT * FROM sheets_sync_jobs
     WHERE connection_id = ? AND line_account_id = ? AND config_version = ?
       AND target = ? AND status = 'failed'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(
    options.connection.id,
    options.connection.lineAccountId,
    options.connection.configVersion,
    target,
  ).first<SheetsSyncJobRow>();
  if (failed) {
    const resumed = await options.db.prepare(
      `UPDATE sheets_sync_jobs SET status = 'running', source = ?, actor = ?,
         error_code = NULL, error_message = NULL, completed_at = NULL,
         lock_token = NULL, locked_until = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       WHERE id = ? AND status = 'failed'
       RETURNING *`,
    ).bind(options.source, actor, failed.id).first<SheetsSyncJobRow>();
    if (resumed) return serializeJob(resumed);
  }

  // The snapshot bound freezes the record set of this job: friends for the
  // ledger target, verified submissions for the form-results target.
  const snapshot = target === 'form_results'
    ? await options.db.prepare(
      `SELECT submission.id, submission.submitted_at AS created_at,
              COUNT(*) OVER () AS total_count
       FROM internal_form_submissions submission
       INNER JOIN friends friend
         ON friend.id = submission.friend_id AND friend.line_account_id = ?
       WHERE submission.form_id = ? AND submission.friend_id IS NOT NULL
       ORDER BY submission.submitted_at DESC, submission.id DESC LIMIT 1`,
    ).bind(options.connection.lineAccountId, options.connection.formId).first<{
      id: string;
      created_at: string;
      total_count: number;
    }>()
    : await options.db.prepare(
      `SELECT id, created_at, COUNT(*) OVER () AS total_count FROM friends
       WHERE line_account_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).bind(options.connection.lineAccountId).first<{
      id: string;
      created_at: string;
      total_count: number;
    }>();
  const id = `gsj_${crypto.randomUUID()}`;
  try {
    const created = await options.db.prepare(
      `INSERT INTO sheets_sync_jobs
       (id, connection_id, line_account_id, config_version, source, actor, target,
        total_count, snapshot_friend_created_at, snapshot_record_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).bind(
      id,
      options.connection.id,
      options.connection.lineAccountId,
      options.connection.configVersion,
      options.source,
      actor,
      target,
      snapshot?.total_count ?? 0,
      snapshot?.created_at ?? null,
      snapshot?.id ?? null,
    ).first<SheetsSyncJobRow>();
    if (!created) throw new Error('sheets_sync_job_create_failed');
    return serializeJob(created);
  } catch (error) {
    const concurrent = await options.db.prepare(
      `SELECT * FROM sheets_sync_jobs
       WHERE connection_id = ? AND target = ? AND status = 'running'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).bind(options.connection.id, target).first<SheetsSyncJobRow>();
    if (concurrent) return serializeJob(concurrent);
    throw error;
  }
}

export async function enqueueSheetsSyncPollingJobs(
  db: D1Database,
  maxConnections: number,
): Promise<{ enqueued: number; runnable: number }> {
  const connections = await listActiveSheetsConnectionsForSync(db, maxConnections);
  let enqueued = 0;
  for (const connection of connections) {
    const targets: SheetsSyncTarget[] = [
      ...(connection.friendLedgerEnabled ? ['ledger' as const] : []),
      ...(connection.formResultsEnabled && connection.formResultsSheetName
        ? ['form_results' as const]
        : []),
    ];
    for (const target of targets) {
      const before = await db.prepare(
        `SELECT id FROM sheets_sync_jobs
         WHERE connection_id = ? AND target = ? AND status = 'running' LIMIT 1`,
      ).bind(connection.id, target).first<{ id: string }>();
      await startSheetsSyncJob({ db, connection, source: 'polling', actor: 'system_poll', target });
      if (!before) enqueued += 1;
    }
  }
  const running = await db.prepare(
    `SELECT COUNT(*) AS count FROM sheets_sync_jobs WHERE status = 'running'`,
  ).first<{ count: number }>();
  return { enqueued, runnable: running?.count ?? 0 };
}

type SyncImplementation = (options: SyncFriendLedgerOptions) => Promise<FriendLedgerSyncResult>;
type ResultsSyncImplementation = (options: SyncFormResultsOptions) => Promise<FormResultsSyncResult>;

export interface ProcessNextSheetsSyncJobOptions {
  db: D1Database;
  credentialsJson?: string;
  client?: SyncFriendLedgerOptions['client'];
  adminOrigin?: string | null;
  chunkSize?: number;
  sync?: SyncImplementation;
  syncResults?: ResultsSyncImplementation;
  now?: () => Date;
}

export interface ProcessNextSheetsSyncJobResult {
  attempted: number;
  hasMore: boolean;
  continuationJobId: string | null;
  job: SheetsSyncJob | null;
}

async function nextRunnableJobId(
  db: D1Database,
  now: string,
  excludeJobId: string | null = null,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT id FROM sheets_sync_jobs
     WHERE status = 'running'
       AND (locked_until IS NULL OR julianday(locked_until) <= julianday(?))
       AND (? IS NULL OR id <> ?)
     ORDER BY created_at ASC, id ASC LIMIT 1`,
  ).bind(now, excludeJobId, excludeJobId).first<{ id: string }>();
  return row?.id ?? null;
}

async function failClaimedJob(
  options: ProcessNextSheetsSyncJobOptions,
  row: SheetsSyncJobRow,
  lockToken: string,
  errorCode = 'sheets_sync_chunk_failed',
  errorMessage = SAFE_ERROR_MESSAGE,
): Promise<SheetsSyncJob> {
  const now = toJstString((options.now ?? (() => new Date()))());
  const failed = await options.db.prepare(
    `UPDATE sheets_sync_jobs SET status = 'failed', error_code = ?, error_message = ?,
       lock_token = NULL, locked_until = NULL, completed_at = ?, updated_at = ?
     WHERE id = ? AND lock_token = ?
     RETURNING *`,
  ).bind(errorCode, errorMessage, now, now, row.id, lockToken).first<SheetsSyncJobRow>();
  if (failed) {
    await updateSheetsSyncStatus(options.db, row.line_account_id, row.connection_id, {
      status: 'error', lastSyncAt: now, warning: errorMessage, errorCode,
    }).catch(() => null);
  }
  const latest = failed ?? await jobById(options.db, row.id);
  return serializeJob(latest ?? row);
}

export async function processNextSheetsSyncJob(
  options: ProcessNextSheetsSyncJobOptions,
): Promise<ProcessNextSheetsSyncJobResult> {
  const nowFactory = options.now ?? (() => new Date());
  const now = toJstString(nowFactory());
  const row = await options.db.prepare(
    `SELECT * FROM sheets_sync_jobs
     WHERE status = 'running'
       AND (locked_until IS NULL OR julianday(locked_until) <= julianday(?))
     ORDER BY created_at ASC, id ASC LIMIT 1`,
  ).bind(now).first<SheetsSyncJobRow>();
  if (!row) return { attempted: 0, hasMore: false, continuationJobId: null, job: null };

  const lockToken = `gsjl_${crypto.randomUUID()}`;
  const lockedUntil = toJstString(new Date(nowFactory().getTime() + JOB_LOCK_MS));
  const claimed = await options.db.prepare(
    `UPDATE sheets_sync_jobs SET lock_token = ?, locked_until = ?, updated_at = ?,
       warning_message = CASE
         WHEN lock_token IS NULL THEN warning_message
         WHEN warning_message IS NULL THEN ?
         WHEN instr(warning_message, ?) > 0 THEN warning_message
         ELSE substr(warning_message || ' / ' || ?, 1, 500)
       END,
       error_code = CASE WHEN lock_token IS NULL THEN error_code ELSE 'sheets_sync_interrupted' END,
       error_message = CASE WHEN lock_token IS NULL THEN error_message
         ELSE '前回の同期が途中で止まりました。保存済みの続きから再開しています。' END
     WHERE id = ? AND status = 'running' AND processed_count = ?
       AND last_record_key IS ? AND last_friend_created_at IS ?
       AND (locked_until IS NULL OR julianday(locked_until) <= julianday(?))
     RETURNING *`,
  ).bind(
    lockToken,
    lockedUntil,
    now,
    RECOVERY_WARNING,
    RECOVERY_WARNING,
    RECOVERY_WARNING,
    row.id,
    row.processed_count,
    row.last_record_key,
    row.last_friend_created_at,
    now,
  ).first<SheetsSyncJobRow>();
  if (!claimed) {
    const continuationJobId = await nextRunnableJobId(options.db, now, row.id);
    return {
      attempted: 0,
      hasMore: continuationJobId !== null,
      continuationJobId,
      job: serializeJob(row),
    };
  }

  const connection = await getSheetsConnection(
    options.db,
    claimed.line_account_id,
    claimed.connection_id,
  );
  if (!connection || connection.configVersion !== claimed.config_version) {
    const job = await failClaimedJob(
      options,
      claimed,
      lockToken,
      'sheets_connection_changed',
      '同期設定が変更されたため、この処理を終了しました。もう一度同期してください。',
    );
    const continuationJobId = await nextRunnableJobId(options.db, toJstString(nowFactory()));
    return { attempted: 1, hasMore: continuationJobId !== null, continuationJobId, job };
  }

  const chunkSize = Math.min(500, Math.max(1, Math.trunc(options.chunkSize ?? SHEETS_SYNC_CHUNK_SIZE)));
  const initialWarnings = claimed.warning_message ? [claimed.warning_message] : [];

  try {
    let result: FriendLedgerSyncResult | FormResultsSyncResult;
    if (claimed.target === 'form_results') {
      const after: FormResultsChunkCursor | null = claimed.last_record_key
        ? { submittedAt: claimed.last_friend_created_at ?? '', submissionId: claimed.last_record_key }
        : null;
      const through: FormResultsChunkCursor | null = claimed.snapshot_record_key
        ? { submittedAt: claimed.snapshot_friend_created_at!, submissionId: claimed.snapshot_record_key }
        : null;
      if (claimed.source === 'polling' && claimed.processed_count === 0) {
        const drained = await drainFormResultsWebhookEvents({
          db: options.db,
          connection,
          client: options.client,
          credentialsJson: options.credentialsJson,
          maxEvents: 1,
          now: options.now,
        });
        initialWarnings.push(...drained.warnings);
      }
      result = await (options.syncResults ?? syncFormResults)({
        db: options.db,
        connection,
        client: options.client,
        credentialsJson: options.credentialsJson,
        source: claimed.source,
        actor: claimed.actor,
        initialWarnings,
        now: options.now,
        chunk: { limit: chunkSize, after, through },
      });
    } else {
      const after: FriendLedgerChunkCursor | null = claimed.last_record_key
        ? { createdAt: claimed.last_friend_created_at ?? '', friendId: claimed.last_record_key }
        : null;
      const through: FriendLedgerChunkCursor | null = claimed.snapshot_record_key
        ? { createdAt: claimed.snapshot_friend_created_at!, friendId: claimed.snapshot_record_key }
        : null;
      if (claimed.source === 'polling' && claimed.processed_count === 0) {
        const drained = await drainFriendLedgerWebhookEvents({
          db: options.db,
          connection,
          client: options.client,
          credentialsJson: options.credentialsJson,
          maxEvents: 1,
          now: options.now,
        });
        initialWarnings.push(...drained.warnings);
      }
      result = await (options.sync ?? syncFriendLedger)({
        db: options.db,
        connection,
        client: options.client,
        credentialsJson: options.credentialsJson,
        adminOrigin: options.adminOrigin,
        source: claimed.source,
        actor: claimed.actor,
        initialWarnings,
        now: options.now,
        chunk: { limit: chunkSize, after, through },
      });
    }
    if (result.busy) {
      await options.db.prepare(
        `UPDATE sheets_sync_jobs SET lock_token = NULL, locked_until = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
         WHERE id = ? AND lock_token = ?`,
      ).bind(claimed.id, lockToken).run();
      const latest = await jobById(options.db, claimed.id);
      const continuationJobId = await nextRunnableJobId(
        options.db,
        toJstString(nowFactory()),
        claimed.id,
      );
      return {
        attempted: 0,
        hasMore: continuationJobId !== null,
        continuationJobId,
        job: latest ? serializeJob(latest) : null,
      };
    }
    if (!result.chunk) throw new Error('sheets_sync_chunk_metadata_missing');
    const processedCount = Math.min(claimed.total_count, claimed.processed_count + result.chunk.processed);
    let warning = mergeWarning(claimed.warning_message, result.warning);
    if (!result.chunk.hasMore && processedCount < claimed.total_count) {
      const changedSubject = claimed.target === 'form_results' ? 'フォーム回答' : '友だち台帳';
      warning = mergeWarning(
        warning,
        `同期中に${changedSubject}が変更されたため、${processedCount} / ${claimed.total_count}件を処理して終了しました。`,
      );
    }
    const storedStatus: StoredSheetsSyncJobStatus = result.chunk.hasMore
      ? 'running'
      : warning ? 'warning' : 'completed';
    const completedAt = storedStatus === 'running' ? null : toJstString(nowFactory());
    const rawCursor = result.chunk.cursor;
    const cursor = rawCursor === null
      ? null
      : 'friendId' in rawCursor
        ? { createdAt: rawCursor.createdAt, recordKey: rawCursor.friendId }
        : { createdAt: rawCursor.submittedAt, recordKey: rawCursor.submissionId };
    const updated = await options.db.prepare(
      `UPDATE sheets_sync_jobs SET status = ?, processed_count = ?,
         last_friend_created_at = ?, last_record_key = ?,
         appended_rows = appended_rows + ?, updated_rows = updated_rows + ?,
         imported_fields = imported_fields + ?,
         ignored_identity_edits = ignored_identity_edits + ?,
         warning_message = ?, error_code = NULL, error_message = NULL,
         lock_token = NULL, locked_until = NULL, completed_at = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       WHERE id = ? AND lock_token = ? AND processed_count = ?
         AND last_record_key IS ? AND last_friend_created_at IS ?
       RETURNING *`,
    ).bind(
      storedStatus,
      processedCount,
      cursor?.createdAt ?? claimed.last_friend_created_at,
      cursor?.recordKey ?? claimed.last_record_key,
      result.appendedRows,
      result.updatedRows,
      result.importedFields,
      result.ignoredIdentityEdits,
      warning,
      completedAt,
      claimed.id,
      lockToken,
      claimed.processed_count,
      claimed.last_record_key,
      claimed.last_friend_created_at,
    ).first<SheetsSyncJobRow>();
    if (!updated) {
      const latest = await jobById(options.db, claimed.id);
      return {
        attempted: 0,
        hasMore: false,
        continuationJobId: null,
        job: latest ? serializeJob(latest) : null,
      };
    }
    const continuationJobId = await nextRunnableJobId(options.db, toJstString(nowFactory()));
    return {
      attempted: 1,
      hasMore: continuationJobId !== null,
      continuationJobId,
      job: serializeJob(updated),
    };
  } catch {
    const job = await failClaimedJob(options, claimed, lockToken);
    const continuationJobId = await nextRunnableJobId(options.db, toJstString(nowFactory()));
    return { attempted: 1, hasMore: continuationJobId !== null, continuationJobId, job };
  }
}

export async function recordSheetsSyncDispatchError(db: D1Database, jobId?: string): Promise<void> {
  const candidates = jobId
    ? (await db.prepare(
      `SELECT * FROM sheets_sync_jobs
       WHERE id = ? AND status = 'running' AND lock_token IS NULL LIMIT 1`,
    ).bind(jobId).all<SheetsSyncJobRow>()).results
    : (await db.prepare(
      `SELECT * FROM sheets_sync_jobs
       WHERE status = 'running' AND lock_token IS NULL
       ORDER BY created_at ASC, id ASC LIMIT 100`,
    ).all<SheetsSyncJobRow>()).results;
  for (const candidate of candidates) {
    const failed = await db.prepare(
      `UPDATE sheets_sync_jobs SET status = 'failed',
         error_code = 'sheets_sync_dispatch_failed', error_message = ?,
         lock_token = NULL, locked_until = NULL,
         completed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       WHERE id = ? AND status = 'running' AND lock_token IS NULL
       RETURNING *`,
    ).bind(DISPATCH_ERROR_MESSAGE, candidate.id).first<SheetsSyncJobRow>();
    if (!failed) continue;
    await updateSheetsSyncStatus(db, failed.line_account_id, failed.connection_id, {
      status: 'error',
      lastSyncAt: failed.completed_at,
      warning: DISPATCH_ERROR_MESSAGE,
      errorCode: 'sheets_sync_dispatch_failed',
    }).catch(() => null);
  }
}
