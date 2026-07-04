/**
 * sender_presets (送信者プリセット) の db model — F2 batch3 G25。
 *
 * account-scoped。broadcasts は sender_preset_id で id 参照するだけで、送信時に server が
 * このプリセット (自 account の実在 id) から name/iconUrl を解決する = client が生の sender
 * 文字列を注入できない (なりすまし防止・Codex[6] 方式2)。
 *
 * 本ファイルの read model (getSenderPresetById / listSenderPresets) は T-C5 (broadcasts の
 * sender 照合 + 送信時解決) が使う。write model (create/update/delete) + 値検証は T-C6 で追加。
 */

export interface SenderPreset {
  id: string;
  line_account_id: string;
  name: string;
  icon_url: string | null;
  created_at: string;
}

/** 自 account に属するプリセットのみ取得 (別 account の id は null = なりすまし防止)。 */
export async function getSenderPresetById(
  db: D1Database,
  id: string,
  accountId: string,
): Promise<SenderPreset | null> {
  return db
    .prepare(`SELECT * FROM sender_presets WHERE id = ? AND line_account_id = ?`)
    .bind(id, accountId)
    .first<SenderPreset>();
}

/** account-scoped 一覧 (別 account のプリセットは出ない)。 */
export async function listSenderPresets(
  db: D1Database,
  accountId: string,
): Promise<SenderPreset[]> {
  const r = await db
    .prepare(`SELECT * FROM sender_presets WHERE line_account_id = ? ORDER BY created_at DESC`)
    .bind(accountId)
    .all<SenderPreset>();
  return r.results;
}

/** 送信時に付与する sender ({name, iconUrl}) をプリセットから解決する。未設定/別 account は undefined。 */
export async function resolveSenderForBroadcast(
  db: D1Database,
  senderPresetId: string | null | undefined,
  accountId: string | null | undefined,
): Promise<{ name: string; iconUrl?: string } | undefined> {
  if (!senderPresetId || !accountId) return undefined;
  const preset = await getSenderPresetById(db, senderPresetId, accountId);
  if (!preset) return undefined;
  return { name: preset.name, iconUrl: preset.icon_url ?? undefined };
}

// ─── write model (T-C6・値検証は route が正典) ────────────────────────────────

export async function createSenderPreset(
  db: D1Database,
  input: { accountId: string; name: string; iconUrl?: string | null },
): Promise<SenderPreset> {
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO sender_presets (id, line_account_id, name, icon_url) VALUES (?, ?, ?, ?)`)
    .bind(id, input.accountId, input.name, input.iconUrl ?? null)
    .run();
  return (await getSenderPresetById(db, id, input.accountId))!;
}

/** account-scoped update (別 account の行は WHERE で除外され更新されない)。 */
export async function updateSenderPreset(
  db: D1Database,
  id: string,
  accountId: string,
  updates: { name?: string; iconUrl?: string | null },
): Promise<SenderPreset | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.iconUrl !== undefined) {
    fields.push('icon_url = ?');
    values.push(updates.iconUrl);
  }
  if (fields.length > 0) {
    values.push(id, accountId);
    await db
      .prepare(`UPDATE sender_presets SET ${fields.join(', ')} WHERE id = ? AND line_account_id = ?`)
      .bind(...values)
      .run();
  }
  return getSenderPresetById(db, id, accountId);
}

/** account-scoped delete (別 account の行は消えない)。 */
export async function deleteSenderPreset(db: D1Database, id: string, accountId: string): Promise<void> {
  await db.prepare(`DELETE FROM sender_presets WHERE id = ? AND line_account_id = ?`).bind(id, accountId).run();
}
