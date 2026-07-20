-- Generated from schema.sql + migrations by scripts/generate-bootstrap.mjs.
-- Do not edit manually. Run `pnpm --dir packages/db generate:bootstrap`.
CREATE TABLE ab_tests (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES line_accounts (id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  metric              TEXT NOT NULL CHECK (metric IN ('open_rate', 'click_rate')),
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'decided')),
  winner_broadcast_id TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE account_health_logs (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  error_code      INTEGER,
  error_count     INTEGER NOT NULL DEFAULT 0,
  check_period    TEXT NOT NULL,
  risk_level      TEXT NOT NULL DEFAULT 'normal' CHECK (risk_level IN ('normal', 'warning', 'danger')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE account_migrations (
  id               TEXT PRIMARY KEY,
  from_account_id  TEXT NOT NULL,
  to_account_id    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  migrated_count   INTEGER NOT NULL DEFAULT 0,
  total_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  completed_at     TEXT
);

CREATE TABLE account_settings (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(line_account_id, key)
);

CREATE TABLE ad_conversion_logs (
  id                  TEXT PRIMARY KEY,
  ad_platform_id      TEXT NOT NULL,
  friend_id           TEXT NOT NULL,
  conversion_point_id TEXT,
  event_name          TEXT NOT NULL,
  click_id            TEXT,
  click_id_type       TEXT,
  status              TEXT DEFAULT 'pending',
  request_body        TEXT,
  response_body       TEXT,
  error_message       TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE ad_platforms (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  display_name TEXT,
  config       TEXT NOT NULL DEFAULT '{}',
  is_active    INTEGER DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE affiliate_clicks (
  id           TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliates (id) ON DELETE CASCADE,
  url          TEXT,
  ip_address   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE affiliates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  code            TEXT NOT NULL UNIQUE,
  commission_rate REAL NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE ai_faq_drafts (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT,
  friend_id         TEXT,
  question          TEXT NOT NULL,
  draft_answer      TEXT NOT NULL,
  evidence_faq_ids  TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'pending',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE ai_usage_budget (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  usage_date        TEXT NOT NULL,
  llm_neurons       INTEGER NOT NULL DEFAULT 0,
  embed_neurons     INTEGER NOT NULL DEFAULT 0,
  image_neurons     INTEGER NOT NULL DEFAULT 0,
  reply_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  UNIQUE(line_account_id, usage_date)
);

CREATE TABLE auto_replies (
  id               TEXT PRIMARY KEY,
  keyword          TEXT NOT NULL,
  match_type       TEXT NOT NULL CHECK (match_type IN ('exact', 'contains')) DEFAULT 'exact',
  response_type    TEXT NOT NULL DEFAULT 'text',
  response_content TEXT NOT NULL,
  template_id      TEXT REFERENCES templates(id) ON DELETE SET NULL,
  line_account_id  TEXT DEFAULT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE automation_logs (
  id             TEXT PRIMARY KEY,
  automation_id  TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  friend_id      TEXT REFERENCES friends (id) ON DELETE SET NULL,
  event_data     TEXT,
  actions_result TEXT,
  status         TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'partial', 'failed')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE automations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  event_type  TEXT NOT NULL,
  conditions  TEXT NOT NULL DEFAULT '{}',
  actions     TEXT NOT NULL DEFAULT '[]',
  is_active   INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);

CREATE TABLE booking_idempotency_keys (
  key              TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  friend_id        TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at       TEXT NOT NULL                  -- UTC ISO8601
);

CREATE TABLE booking_reminders (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('day_before','hours_before')),
  scheduled_at  TEXT NOT NULL,                                -- UTC ISO8601
  sent_at       TEXT,                                         -- UTC ISO8601
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','failed_permanent','cancelled')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

CREATE TABLE bookings (
  id                      TEXT PRIMARY KEY,
  line_account_id         TEXT NOT NULL,
  friend_id               TEXT NOT NULL,        -- friends.id
  staff_id                TEXT NOT NULL,
  menu_id                 TEXT NOT NULL,
  starts_at               TEXT NOT NULL,        -- UTC ISO8601 (Z)
  ends_at                 TEXT NOT NULL,        -- UTC ISO8601 (Z)
  block_ends_at           TEXT NOT NULL,        -- ends_at + buffer_after。衝突判定
  status                  TEXT NOT NULL CHECK (status IN ('requested','confirmed','rejected','expired','cancelled','completed','no_show')),
  customer_note           TEXT,
  internal_note           TEXT,
  price_at_booking        INTEGER NOT NULL,
  requested_at            TEXT NOT NULL,        -- UTC ISO8601
  decided_at              TEXT,                 -- UTC ISO8601
  decided_by_staff_id     TEXT,
  external_event_id       TEXT,                 -- Phase 3 余地 (Google Calendar)
  external_calendar_id    TEXT,                 -- Phase 3 余地
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id),
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (menu_id) REFERENCES menus(id)
);

CREATE TABLE broadcast_insights (
  id                  TEXT PRIMARY KEY,
  broadcast_id        TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  delivered           INTEGER,
  unique_impression   INTEGER,
  unique_click        INTEGER,
  unique_media_played INTEGER,
  open_rate           REAL,
  click_rate          REAL,
  raw_response        TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  retry_count         INTEGER NOT NULL DEFAULT 0,
  fetched_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE "broadcasts" (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  message_type       TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'video', 'audio', 'imagemap', 'richvideo')),
  message_content    TEXT NOT NULL,
  target_type        TEXT NOT NULL CHECK (target_type IN ('all', 'tag', 'segment', 'multi-account-dedup')) DEFAULT 'all',
  target_tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')) DEFAULT 'draft',
  scheduled_at       TEXT,
  sent_at            TEXT,
  total_count        INTEGER NOT NULL DEFAULT 0,
  success_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  line_account_id    TEXT,
  alt_text           TEXT,
  line_request_id    TEXT,
  aggregation_unit   TEXT,
  batch_offset       INTEGER NOT NULL DEFAULT 0,
  segment_conditions TEXT,
  account_ids        TEXT CHECK (account_ids IS NULL OR json_valid(account_ids)),
  dedup_priority     TEXT CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)),
  failed_account_ids TEXT CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids)),
  dedup_progress     TEXT,
  batch_lock_at      TEXT,
  campaign_id        TEXT REFERENCES campaigns (id) ON DELETE SET NULL
, sender_preset_id TEXT REFERENCES sender_presets (id) ON DELETE SET NULL, ab_test_id TEXT REFERENCES ab_tests (id) ON DELETE SET NULL, ab_variant TEXT, messages TEXT);

CREATE TABLE calendar_bookings (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL REFERENCES google_calendar_connections (id) ON DELETE CASCADE,
  friend_id      TEXT REFERENCES friends (id) ON DELETE SET NULL,
  event_id       TEXT,
  title          TEXT NOT NULL,
  start_at       TEXT NOT NULL,
  end_at         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  metadata       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE campaigns (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE canned_responses (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT DEFAULT NULL,
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE chats (
  id            TEXT PRIMARY KEY,
  friend_id     TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  operator_id   TEXT REFERENCES operators (id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'in_progress', 'resolved')),
  notes         TEXT,
  last_message_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);

CREATE TABLE conversion_events (
  id                  TEXT PRIMARY KEY,
  conversion_point_id TEXT NOT NULL REFERENCES conversion_points (id) ON DELETE CASCADE,
  friend_id           TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  user_id             TEXT,
  affiliate_code      TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE conversion_points (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  event_type TEXT NOT NULL,
  value      REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE entry_routes (
  id          TEXT PRIMARY KEY,
  ref_code    TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  redirect_url TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
, pool_id TEXT REFERENCES traffic_pools (id) ON DELETE SET NULL, intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, run_account_friend_add_scenarios INTEGER NOT NULL DEFAULT 1);

CREATE TABLE event_booking_idempotency_keys (
  key              TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  friend_id        TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at       TEXT NOT NULL
);

CREATE TABLE event_booking_reminders (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('day_before','hours_before')),
  scheduled_at  TEXT NOT NULL,
  sent_at       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','failed_permanent','cancelled')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  FOREIGN KEY (booking_id) REFERENCES event_bookings(id)
);

CREATE TABLE event_bookings (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  event_id              TEXT NOT NULL,
  slot_id               TEXT NOT NULL,
  friend_id             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('requested','confirmed','rejected','cancelled','expired','no_show','attended')),
  customer_note         TEXT,
  internal_note         TEXT,
  requested_at          TEXT NOT NULL,
  decided_at            TEXT,
  decided_by_staff_id   TEXT,
  cancelled_at          TEXT,
  cancelled_by          TEXT CHECK (cancelled_by IN ('friend','admin','system')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), identity_key TEXT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (slot_id) REFERENCES event_slots(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id)
);

CREATE TABLE event_slots (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  capacity    INTEGER,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE events (
  id                            TEXT PRIMARY KEY,
  line_account_id               TEXT NOT NULL,
  name                          TEXT NOT NULL,
  venue_name                    TEXT,
  venue_url                     TEXT,
  image_url                     TEXT,
  description                   TEXT,
  description_centered          INTEGER NOT NULL DEFAULT 0,
  max_bookings_per_friend       INTEGER,
  requires_approval             INTEGER NOT NULL DEFAULT 0,
  cancel_deadline_hours_before  INTEGER,
  reminder_day_before_enabled   INTEGER NOT NULL DEFAULT 1,
  reminder_hours_before         INTEGER,
  is_published                  INTEGER NOT NULL DEFAULT 0,
  folder_id                     TEXT,
  sort_order                    INTEGER NOT NULL DEFAULT 0,
  deleted_at                    TEXT,
  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), target_type TEXT NOT NULL DEFAULT 'single'
  CHECK (target_type IN ('single', 'multi-account-dedup')), account_ids TEXT
  CHECK (account_ids IS NULL OR json_valid(account_ids)), dedup_priority TEXT
  CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)), failed_account_ids TEXT
  CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids)), confirmation_message_extra TEXT, reminder_message_extra TEXT, og_title TEXT, og_description TEXT, og_image_url TEXT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE TABLE faqs (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT DEFAULT NULL,
  question         TEXT NOT NULL,
  variants         TEXT NOT NULL DEFAULT '[]',
  answer           TEXT NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  hit_count        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  answer_type      TEXT DEFAULT 'text',
  source_doc_id    TEXT,
  -- Phase B B-2 (091): アプリ層 (worker faq-fts.ts) が計算する 2-gram 空白連結の全文検索索引列。
  search_text      TEXT NOT NULL DEFAULT ''
  -- Phase B reserved (add with additive ALTER):
  --   embedding   BLOB  (B-4 / Vectorize)
);

CREATE VIRTUAL TABLE faqs_fts USING fts5(search_text, tokenize='unicode61');

CREATE TABLE form_opens (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  friend_id TEXT,
  friend_name TEXT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE form_submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE formaloo_account_bindings (
  line_account_id      TEXT PRIMARY KEY,
  default_workspace_id TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE formaloo_ai_chat_history (
  id                  TEXT PRIMARY KEY,
  tenant_scope        TEXT NOT NULL,
  line_account_id     TEXT NOT NULL,
  form_id             TEXT NOT NULL REFERENCES formaloo_forms (id) ON DELETE CASCADE,
  question            TEXT NOT NULL,
  answer_json         TEXT,
  answer_text         TEXT,
  analysis_slug       TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  provider_status     TEXT,
  error_code          TEXT,
  error_message       TEXT,
  credits_consumed    INTEGER NOT NULL DEFAULT 0 CHECK (credits_consumed IN (0, 1)),
  credit_reserved     INTEGER NOT NULL DEFAULT 1 CHECK (credit_reserved IN (0, 1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE formaloo_choice_lists (
  id         TEXT PRIMARY KEY,
  form_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE formaloo_drift_events (
  id             TEXT PRIMARY KEY,                 -- de_...
  form_id        TEXT NOT NULL,                    -- formaloo_forms.id (FK はアプリ層 / D1 FK off)
  detected_at    TEXT NOT NULL,                    -- 検知時刻 (JST ISO)
  action         TEXT NOT NULL,                    -- notified | auto_applied | conflict_held | bootstrapped
  remote_hash    TEXT,                             -- 検知した Formaloo fingerprint
  prev_hash      TEXT,                             -- 直前 baseline (差分の起点)
  has_warnings   INTEGER NOT NULL DEFAULT 0,       -- 弱化 warnings 有無 (1/0)
  warnings_json  TEXT,                             -- warnings 文言 (任意)
  sync_status_at TEXT,                             -- 検知時の sync_status (競合判定の証跡)
  detail         TEXT,                             -- 補足 (任意)
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE formaloo_edit_mail_sends (
  id                       TEXT PRIMARY KEY,
  submission_id            TEXT NOT NULL UNIQUE,   -- 冪等 claim (1 submission = 1 送信 / 再配信で 2 通目を出さない)
  form_id                  TEXT NOT NULL,
  recipient_hash           TEXT NOT NULL,          -- 宛先メールの hash のみ (平文非保存 = PII / PUBLIC repo)
  requested_at             TEXT NOT NULL,          -- JST ISO8601 (claim/pending 予約時刻)
  status                   TEXT NOT NULL,          -- pending | sent | failed | skipped
  attempt_count            INTEGER NOT NULL DEFAULT 0,  -- 再送回数 (bounded 再送の上限判定 / Phase B)
  provider_idempotency_key TEXT,                   -- provider 側冪等キー (再送で provider 二重送信しない / Phase B)
  last_attempt_at          TEXT,                   -- 最終試行時刻 (JST ISO)
  provider_message_id      TEXT,                   -- provider ack の message id (送達証跡)
  error                    TEXT                    -- 失敗理由 (soft-200-safe 証跡)
);

CREATE TABLE formaloo_field_map (
  id                  TEXT PRIMARY KEY,
  form_id             TEXT NOT NULL,
  formaloo_field_slug TEXT,
  field_type          TEXT NOT NULL,
  label               TEXT NOT NULL DEFAULT '',
  position            INTEGER NOT NULL DEFAULT 0,
  config_json         TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE formaloo_folders (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  parent_id       TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE formaloo_forms (
  id                    TEXT PRIMARY KEY,
  formaloo_slug         TEXT,
  title                 TEXT NOT NULL DEFAULT '',
  description           TEXT,
  definition_json       TEXT NOT NULL DEFAULT '{}',
  on_submit_tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  on_submit_scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  submit_message        TEXT,
  submit_count          INTEGER NOT NULL DEFAULT 0,
  deleted               INTEGER NOT NULL DEFAULT 0,
  builder_status        TEXT NOT NULL DEFAULT 'draft',   -- migration 080: draft|in_review|published (publish gate / N-7)
  published_at          TEXT,                            -- migration 080: 初回公開時刻 (NULL=未公開)
  gsheet_connected      INTEGER NOT NULL DEFAULT 0,      -- migration 083: Google Sheets 連携済 (T-E1)
  gsheet_url            TEXT,                            -- migration 083: 連携先 Sheet URL (表示用 / NULL=未連携)
  line_account_id       TEXT,                            -- migration 095: 表示スコープ (NULL=全アカウント共通 / F6-2 本柱②)
  workspace_id          TEXT,                            -- migration 095: 作成先 Formaloo workspace (NULL=env 鍵 fallback / F6-2 本柱④)
  folder_id             TEXT,                            -- migration 096: ハーネス側フォルダ分類 (NULL=未分類 / F6-3 本柱③)
  friend_metadata_mappings_json TEXT NOT NULL DEFAULT '[]', -- migration 103: Formaloo row → friend.metadata (空配列=OFF)
  render_backend        TEXT NOT NULL DEFAULT 'formaloo' -- migration 113: formaloo|internal (既存は Formaloo 維持)
                        CHECK (render_backend IN ('formaloo', 'internal')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, allow_post_edit INTEGER NOT NULL DEFAULT 0, allow_edit_mail INTEGER NOT NULL DEFAULT 0, edit_mail_field_slug TEXT, edit_link_epoch INTEGER NOT NULL DEFAULT 0, formaloo_webhook_enabled INTEGER NOT NULL DEFAULT 0, formaloo_webhook_id TEXT, formaloo_webhook_secret TEXT, formaloo_webhook_url TEXT, formaloo_webhook_lock_token TEXT, formaloo_webhook_lock_until INTEGER, formaloo_webhook_pull_generation INTEGER NOT NULL DEFAULT 0, formaloo_webhook_pull_processed_generation INTEGER NOT NULL DEFAULT 0, formaloo_webhook_pull_lock_token TEXT, formaloo_webhook_pull_lock_until INTEGER, formaloo_webhook_pull_not_before INTEGER NOT NULL DEFAULT 0);

CREATE TABLE formaloo_recurring_submissions (
  id                   TEXT PRIMARY KEY,
  form_id              TEXT NOT NULL REFERENCES formaloo_forms (id) ON DELETE CASCADE,
  idempotency_key      TEXT NOT NULL,
  request_fingerprint  TEXT NOT NULL,
  remote_slug          TEXT,
  schedule_json        TEXT NOT NULL,
  submission_data_json TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'resumed' CHECK (status IN ('resumed', 'paused', 'cancelled')),
  sync_state           TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending', 'synced', 'failed')),
  last_error           TEXT,
  operation_token      TEXT,
  operation_lock_until INTEGER,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (form_id, idempotency_key)
);

CREATE TABLE formaloo_saved_filters (
  id          TEXT PRIMARY KEY,
  form_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  filter_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE formaloo_submission_edits (
  id              TEXT PRIMARY KEY,
  submission_id   TEXT NOT NULL,
  form_id         TEXT NOT NULL,
  editor_staff_id TEXT,                 -- 編集した staff (認証文脈から解決 / NULL=不明系)
  edited_at       TEXT NOT NULL,        -- JST ISO8601
  field_slug      TEXT NOT NULL,        -- Formaloo field slug (編集した項目)
  old_value       TEXT,                 -- 前値 (表示用スナップショット)
  new_value       TEXT                  -- 後値
);

CREATE TABLE formaloo_submissions (
  id            TEXT PRIMARY KEY,
  form_id       TEXT NOT NULL,
  formaloo_slug TEXT,
  friend_id     TEXT,
  answers_json  TEXT NOT NULL DEFAULT '{}',
  submitted_at  TEXT NOT NULL,
  synced_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  line_processed INTEGER NOT NULL DEFAULT 0,   -- migration 081: LINE 後処理発火済 claim (再送二重発火防止 / N-3)
  verified       INTEGER NOT NULL DEFAULT 0    -- migration 081: 署名 or pull-verify 済 (未署名隔離 / N-12)
, formaloo_row_slug TEXT, tracking_code TEXT, submit_number TEXT, pdf_link TEXT);

CREATE TABLE formaloo_sync_state (
  form_id        TEXT PRIMARY KEY,
  last_pushed_at TEXT,
  last_pulled_at TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'idle',
  last_error     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  -- migration 098 (formaloo-auto-pull): drift 検知の別軸 (sync_status と直交)。
  remote_definition_hash TEXT,                          -- baseline fingerprint (NULL=未 bootstrap)
  pending_remote_hash    TEXT,                          -- 通知中 drift の fingerprint (dedup キー)
  drift_status           TEXT NOT NULL DEFAULT 'none',  -- none|detected|applied|conflict
  drift_detected_at      TEXT,                          -- 最新 drift 検知時刻 (JST ISO)
  remote_updated_at      TEXT                           -- optional: list timestamp フィルタ用 (live 実在時)
);

CREATE TABLE formaloo_workspaces (
  id                 TEXT PRIMARY KEY,
  label              TEXT NOT NULL DEFAULT '',
  business_slug      TEXT,
  key_ciphertext     TEXT NOT NULL,                 -- AES-GCM(base64) 暗号文: API KEY (平文非保持)
  key_iv             TEXT NOT NULL,                 -- KEY 用 12-byte IV (base64)
  secret_ciphertext  TEXT NOT NULL,                 -- AES-GCM(base64) 暗号文: API SECRET (平文非保持)
  secret_iv          TEXT NOT NULL,                 -- SECRET 用 12-byte IV (base64)
  kek_version        INTEGER NOT NULL DEFAULT 1,    -- migration 094: KEK ローテーション前方互換 (Codex gap #4)
  is_active          INTEGER NOT NULL DEFAULT 1,    -- 1=有効 / 0=無効 (enable/disable soft-delete)
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE forms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  fields TEXT NOT NULL DEFAULT '[]',
  on_submit_tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL,
  on_submit_scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  save_to_metadata INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  submit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, on_submit_message_type TEXT CHECK (on_submit_message_type IN ('text', 'flex')) DEFAULT NULL, on_submit_message_content TEXT DEFAULT NULL, on_submit_webhook_url TEXT, on_submit_webhook_headers TEXT, on_submit_webhook_fail_message TEXT, og_title TEXT, og_description TEXT, og_image_url TEXT);

CREATE TABLE friend_field_definitions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  default_value TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE friend_reminder_deliveries (
  id                TEXT PRIMARY KEY,
  friend_reminder_id TEXT NOT NULL REFERENCES friend_reminders (id) ON DELETE CASCADE,
  reminder_step_id  TEXT NOT NULL REFERENCES reminder_steps (id) ON DELETE CASCADE,
  delivered_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (friend_reminder_id, reminder_step_id)
);

CREATE TABLE friend_reminders (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  reminder_id     TEXT NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
  target_date     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE "friend_scenarios" (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  scenario_id        TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  current_step_order INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'delivering')) DEFAULT 'active',
  started_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  next_delivery_at   TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE friend_scores (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  scoring_rule_id TEXT REFERENCES scoring_rules (id) ON DELETE SET NULL,
  score_change    INTEGER NOT NULL,
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE friend_tags (
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (friend_id, tag_id)
);

CREATE TABLE friends (
  id               TEXT PRIMARY KEY,
  line_user_id     TEXT UNIQUE NOT NULL,
  display_name     TEXT,
  picture_url      TEXT,
  status_message   TEXT,
  is_following     INTEGER NOT NULL DEFAULT 1,
  user_id          TEXT,
  ig_igsid         TEXT,
  score            INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, ref_code TEXT, metadata TEXT NOT NULL DEFAULT '{}', line_account_id TEXT REFERENCES line_accounts(id), first_tracked_link_id TEXT REFERENCES tracked_links (id) ON DELETE SET NULL);

CREATE TABLE google_calendar_connections (
  id            TEXT PRIMARY KEY,
  calendar_id   TEXT NOT NULL,
  access_token  TEXT,
  refresh_token TEXT,
  api_key       TEXT,
  auth_type     TEXT NOT NULL DEFAULT 'api_key',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE incoming_webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'custom',
  secret      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE internal_form_submissions (
  id           TEXT PRIMARY KEY,
  form_id      TEXT NOT NULL,
  friend_id    TEXT,
  answers_json TEXT NOT NULL DEFAULT '{}',
  submitted_at TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE knowledge_chunks (
  id              TEXT PRIMARY KEY,
  source_doc_id   TEXT NOT NULL REFERENCES knowledge_documents(id),
  line_account_id TEXT,
  chunk_index     INTEGER NOT NULL,
  content         TEXT NOT NULL,
  search_text     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  embedded_at     TEXT,
  embed_model     TEXT,
  UNIQUE(source_doc_id, chunk_index)
);

CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(search_text, tokenize='unicode61');

CREATE TABLE knowledge_documents (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT,
  source_type     TEXT NOT NULL,
  source_url      TEXT,
  title           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE line_accounts (
  id                   TEXT PRIMARY KEY,
  channel_id           TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  channel_access_token TEXT NOT NULL,
  channel_secret       TEXT NOT NULL,
  is_active            INTEGER NOT NULL DEFAULT 1,
  country              TEXT,
  role                 TEXT,
  display_order        INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  -- monthly_cap (migration 057 / F2 batch4 G2): 月次送信上限 (NULL = 無制限 = 既定挙動不変)。
  monthly_cap          INTEGER
, login_channel_id TEXT, login_channel_secret TEXT, liff_id TEXT, token_expires_at TEXT, og_site_name TEXT, og_default_image_url TEXT, og_default_description TEXT);

CREATE TABLE link_clicks (
  id TEXT PRIMARY KEY,
  tracked_link_id TEXT NOT NULL REFERENCES tracked_links (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  clicked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lp_pages (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  entry_key  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE lp_views (
  id          TEXT PRIMARY KEY,
  lp_slug     TEXT NOT NULL,
  friend_id   TEXT,
  friend_name TEXT,
  referrer    TEXT,
  viewed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE menus (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  name                  TEXT NOT NULL,
  category_label        TEXT,
  description           TEXT,
  duration_minutes      INTEGER NOT NULL,
  buffer_after_minutes  INTEGER NOT NULL DEFAULT 0,
  base_price            INTEGER NOT NULL,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 1,
  deleted_at            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), auto_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE TABLE message_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'flex')),
  message_content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE "messages_log" (
  id                  TEXT PRIMARY KEY,
  friend_id           TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  direction           TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type        TEXT NOT NULL,
  content             TEXT NOT NULL,
  broadcast_id        TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  scenario_step_id    TEXT REFERENCES scenario_steps (id) ON DELETE SET NULL,
  template_id_at_send TEXT,
  delivery_type       TEXT CHECK (delivery_type IN ('push', 'reply', 'test')),
  source              TEXT,
  line_account_id     TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE notification_rules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  conditions   TEXT NOT NULL DEFAULT '{}',
  channels     TEXT NOT NULL DEFAULT '["webhook"]',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  rule_id         TEXT REFERENCES notification_rules (id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE operators (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE outgoing_webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  event_types TEXT NOT NULL DEFAULT '[]',
  secret      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE pool_accounts (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES traffic_pools(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pool_id, line_account_id)
);

CREATE TABLE ref_tracking (
  id              TEXT PRIMARY KEY,
  ref_code        TEXT NOT NULL,
  friend_id       TEXT REFERENCES friends (id) ON DELETE CASCADE,
  entry_route_id  TEXT REFERENCES entry_routes (id) ON DELETE SET NULL,
  source_url      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
, fbclid TEXT, gclid TEXT, twclid TEXT, ttclid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, user_agent TEXT, ip_address TEXT);

CREATE TABLE reminder_steps (
  id              TEXT PRIMARY KEY,
  reminder_id     TEXT NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
  offset_minutes  INTEGER NOT NULL,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  message_content TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE reminders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);

CREATE TABLE response_schedules (
  id                 TEXT PRIMARY KEY,
  line_account_id    TEXT DEFAULT NULL,
  is_enabled         INTEGER NOT NULL DEFAULT 0,
  timezone           TEXT NOT NULL DEFAULT 'Asia/Tokyo'
                     CHECK (timezone = 'Asia/Tokyo'),
  outside_hours_mode TEXT NOT NULL DEFAULT 'auto_reply'
                     CHECK (outside_hours_mode IN ('auto_reply','away_message','none')),
  away_message       TEXT DEFAULT NULL,
  weekly_hours       TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE rich_menu_areas (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES rich_menu_pages(id) ON DELETE CASCADE,
  bounds_x        INTEGER NOT NULL,
  bounds_y        INTEGER NOT NULL,
  bounds_width    INTEGER NOT NULL,
  bounds_height   INTEGER NOT NULL,
  action_type     TEXT NOT NULL CHECK (action_type IN ('uri','message','postback','richmenuswitch')),
  action_data     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE rich_menu_display_rules (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  condition_type  TEXT NOT NULL CHECK (condition_type IN ('tag_exists', 'tag_not_exists', 'metadata_equals', 'metadata_not_equals', 'metadata_contains', 'metadata_not_contains', 'tag_name_contains', 'tag_name_not_contains')),
  condition_value TEXT NOT NULL CHECK (length(condition_value) BETWEEN 1 AND 10000),
  rich_menu_id    TEXT NOT NULL CHECK (length(rich_menu_id) BETWEEN 1 AND 200),
  priority        INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000000 AND 1000000),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  active_from     TEXT,
  active_until    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE rich_menu_friend_assignments (
  friend_id    TEXT PRIMARY KEY REFERENCES friends(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  rule_id      TEXT REFERENCES rich_menu_display_rules(id) ON DELETE SET NULL,
  rich_menu_id TEXT,
  applied_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE rich_menu_groups (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  chat_bar_text      TEXT NOT NULL,
  size               TEXT NOT NULL CHECK (size IN ('large','compact')),
  default_page_id    TEXT,
  is_default_for_all INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  publishing_at      TEXT,
  -- schedule_start / schedule_end (migration 058 / F2 batch4 G17): 期間限定メニューの開始/終了
  -- (ISO8601 JST・NULL = スケジュールなし)。自動切替は RICH_MENU_SCHEDULE_ENABLED flag OFF + crons=[]
  -- で dark-ship (発火しない)。
  schedule_start     TEXT,
  schedule_end       TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE rich_menu_pages (
  id                 TEXT PRIMARY KEY,
  group_id           TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  order_index        INTEGER NOT NULL,
  name               TEXT NOT NULL,
  alias_id           TEXT NOT NULL,
  line_richmenu_id   TEXT,
  image_r2_key       TEXT,
  image_content_type TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (group_id, order_index)
);

CREATE TABLE rich_menu_rule_evaluation_queue (
  friend_id    TEXT PRIMARY KEY REFERENCES friends(id) ON DELETE CASCADE,
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  last_error   TEXT,
  lease_token  TEXT,
  revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE rich_menu_rule_reapply_jobs (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed')),
  total_count     INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  applied_count   INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  skipped_count   INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count    INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  last_friend_id  TEXT,
  locked_until    TEXT,
  lock_token      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  completed_at    TEXT
);

CREATE TABLE rich_menu_rule_schedule_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TEXT NOT NULL
);

CREATE TABLE role_permissions (
  id          TEXT PRIMARY KEY,
  role_id     TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  allowed     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  base_role   TEXT NOT NULL DEFAULT 'staff',
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE saved_searches (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT DEFAULT NULL,
  name             TEXT NOT NULL,
  conditions       TEXT NOT NULL DEFAULT '{"operator":"AND","rules":[]}',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE scenario_steps (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  delay_minutes   INTEGER NOT NULL DEFAULT 0,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  message_content TEXT NOT NULL,
  offset_days     INTEGER,
  offset_minutes  INTEGER,
  delivery_time   TEXT,
  template_id     TEXT REFERENCES templates(id) ON DELETE SET NULL,
  on_reach_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), condition_type TEXT, condition_value TEXT, next_step_on_false INTEGER,
  UNIQUE (scenario_id, step_order)
);

CREATE TABLE scenarios (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('friend_add', 'tag_added', 'manual')),
  trigger_tag_id  TEXT REFERENCES tags (id) ON DELETE SET NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  delivery_mode   TEXT NOT NULL DEFAULT 'relative' CHECK (delivery_mode IN ('relative', 'elapsed', 'absolute_time')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);

CREATE TABLE scoring_rules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  score_value INTEGER NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE sender_presets (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  icon_url        TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE sheets_connections (
  id              TEXT PRIMARY KEY,
  -- Keep the connection/audit chain when an account is removed. The orphan
  -- trigger below deactivates the setting so it can never be synchronized.
  line_account_id TEXT REFERENCES line_accounts (id) ON DELETE SET NULL,
  form_id         TEXT NOT NULL CHECK (length(form_id) BETWEEN 1 AND 200),
  spreadsheet_id  TEXT NOT NULL CHECK (length(spreadsheet_id) BETWEEN 1 AND 512),
  sheet_name      TEXT NOT NULL DEFAULT 'Sheet1' CHECK (length(sheet_name) BETWEEN 1 AND 200),
  sync_direction  TEXT NOT NULL DEFAULT 'bidirectional'
                  CHECK (sync_direction IN ('to_sheets', 'from_sheets', 'bidirectional')),
  conflict_policy TEXT NOT NULL DEFAULT 'last_write_wins'
                  CHECK (conflict_policy = 'last_write_wins'),
  -- LWW is ordered by a Worker-assigned sequence when a write is accepted.
  -- Sheets values.get exposes no trustworthy human-edit timestamp, so wall-clock
  -- observation time is deliberately not the conflict clock.
  conflict_clock  TEXT NOT NULL DEFAULT 'server_sequence'
                  CHECK (conflict_clock = 'server_sequence'),
  config_version  INTEGER NOT NULL DEFAULT 1 CHECK (config_version >= 1),
  next_sync_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sync_sequence >= 1),
  friend_field_mappings_json TEXT NOT NULL DEFAULT '[]'
                  CHECK (json_valid(friend_field_mappings_json) AND json_type(friend_field_mappings_json) = 'array'),
  last_sync_at    TEXT,
  last_sync_status TEXT NOT NULL DEFAULT 'idle'
                  CHECK (last_sync_status IN ('idle', 'running', 'success', 'warning', 'error')),
  last_sync_warning TEXT,
  last_sync_error_code TEXT,
  sync_lock_token TEXT,
  sync_lock_expires_at TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  deleted_at      TEXT
);

CREATE TABLE sheets_sync_audit_details (
  id          TEXT PRIMARY KEY,
  audit_id    TEXT NOT NULL REFERENCES sheets_sync_audit_log (id) ON DELETE RESTRICT,
  actor       TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 320),
  column_name TEXT NOT NULL CHECK (length(column_name) BETWEEN 1 AND 200),
  old_value   TEXT,
  new_value   TEXT,
  source      TEXT NOT NULL CHECK (source IN ('webhook', 'polling', 'manual')),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('custom_field', 'identity_sync', 'identity_ignored', 'conflict')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE sheets_sync_audit_log (
  id                   TEXT PRIMARY KEY,
  connection_id        TEXT NOT NULL REFERENCES sheets_connections (id) ON DELETE RESTRICT,
  connection_version   INTEGER NOT NULL CHECK (connection_version >= 1),
  apply_sequence       INTEGER NOT NULL CHECK (apply_sequence >= 1),
  -- Immutable target snapshot: later connection edits cannot rewrite history.
  line_account_id      TEXT NOT NULL,
  form_id              TEXT NOT NULL,
  spreadsheet_id       TEXT NOT NULL,
  sheet_name           TEXT NOT NULL,
  record_key           TEXT,
  sheet_row_number      INTEGER CHECK (sheet_row_number IS NULL OR sheet_row_number >= 1),
  direction             TEXT NOT NULL CHECK (direction IN ('to_sheets', 'from_sheets')),
  action                TEXT NOT NULL CHECK (action IN ('append', 'read', 'update', 'conflict')),
  outcome               TEXT NOT NULL CHECK (outcome IN ('applied', 'skipped', 'failed')),
  conflict_resolution   TEXT CHECK (
    conflict_resolution IS NULL OR conflict_resolution IN ('harness_wins', 'sheet_wins', 'same_sequence')
  ),
  harness_updated_at    TEXT,
  sheet_observed_at     TEXT,
  before_fingerprint   TEXT,
  after_fingerprint    TEXT,
  error_code            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE sheets_sync_ledger (
  connection_id      TEXT NOT NULL REFERENCES sheets_connections (id) ON DELETE CASCADE,
  connection_version INTEGER NOT NULL DEFAULT 1 CHECK (connection_version >= 1),
  record_key         TEXT NOT NULL CHECK (length(record_key) BETWEEN 1 AND 200),
  sheet_row_number   INTEGER CHECK (sheet_row_number IS NULL OR sheet_row_number >= 1),
  row_fingerprint    TEXT NOT NULL CHECK (length(row_fingerprint) BETWEEN 1 AND 256),
  harness_updated_at TEXT,
  -- API observation time is diagnostic only and is never used as the conflict clock.
  sheet_observed_at  TEXT,
  last_synced_at     TEXT NOT NULL,
  last_sync_direction TEXT NOT NULL CHECK (last_sync_direction IN ('to_sheets', 'from_sheets')),
  last_applied_sequence INTEGER NOT NULL CHECK (last_applied_sequence >= 1),
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  canonical_snapshot_json TEXT NOT NULL DEFAULT '{}'
                     CHECK (json_valid(canonical_snapshot_json) AND json_type(canonical_snapshot_json) = 'object'),
  PRIMARY KEY (connection_id, record_key)
);

CREATE TABLE staff (
  id                       TEXT PRIMARY KEY,
  line_account_id          TEXT NOT NULL,
  name                     TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  role                     TEXT,
  profile_image_url        TEXT,
  bio                      TEXT,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  is_designation_optional  INTEGER NOT NULL DEFAULT 0,
  is_active                INTEGER NOT NULL DEFAULT 1,
  deleted_at               TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE TABLE staff_members (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
  api_key    TEXT UNIQUE NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  -- ID/PASS ログイン (migration 076 / batch F)。既存行は NULL のまま = api_key ログイン維持。
  login_id            TEXT,
  password_hash       TEXT,
  password_salt       TEXT,
  password_algo       TEXT DEFAULT 'pbkdf2-sha256',
  password_iterations INTEGER,
  password_updated_at TEXT,
  failed_login_count  INTEGER DEFAULT 0,
  locked_until        TEXT,
  -- カスタムロール (migration 088 / G64)。NULL = built-in preset (role 列) で従来通り解決。
  role_id             TEXT
);

CREATE TABLE staff_menus (
  staff_id                  TEXT NOT NULL,
  menu_id                   TEXT NOT NULL,
  is_offered                INTEGER NOT NULL DEFAULT 1,
  override_duration_minutes INTEGER,
  override_price            INTEGER,
  PRIMARY KEY (staff_id, menu_id),
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (menu_id) REFERENCES menus(id)
);

CREATE TABLE staff_shifts (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  work_date   TEXT NOT NULL,    -- YYYY-MM-DD (JST)
  start_time  TEXT NOT NULL,    -- HH:MM (JST)
  end_time    TEXT NOT NULL,    -- HH:MM (JST)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (staff_id, work_date),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);

CREATE TABLE stripe_events (
  id               TEXT PRIMARY KEY,
  stripe_event_id  TEXT NOT NULL UNIQUE,
  event_type       TEXT NOT NULL,
  friend_id        TEXT REFERENCES friends (id) ON DELETE SET NULL,
  amount           REAL,
  currency         TEXT,
  metadata         TEXT,
  processed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  color      TEXT NOT NULL DEFAULT '#3B82F6',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE template_pack_items (
  id               TEXT PRIMARY KEY,
  pack_id          TEXT NOT NULL REFERENCES template_packs(id) ON DELETE CASCADE,
  order_index      INTEGER NOT NULL,
  message_type     TEXT NOT NULL CHECK (message_type IN ('text', 'flex')),
  message_content  TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE template_packs (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general',
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'carousel')),
  message_content TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE test_send_requests (
  idempotency_key TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  source           TEXT NOT NULL,
  request_payload  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  response_json    TEXT,
  created_at       TEXT NOT NULL,
  completed_at     TEXT
);

CREATE TABLE tracked_links (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_url TEXT NOT NULL,
  tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, reward_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, og_title TEXT, og_description TEXT, og_image_url TEXT);

CREATE TABLE traffic_pools (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  active_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE unmatched_questions (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT DEFAULT NULL,
  friend_id        TEXT REFERENCES friends(id) ON DELETE SET NULL,
  question         TEXT NOT NULL,
  top_score        REAL,
  resolved_faq_id  TEXT REFERENCES faqs(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE update_history (
  id                          TEXT PRIMARY KEY,
  started_at                  INTEGER NOT NULL,
  completed_at                INTEGER,
  from_version                TEXT NOT NULL,
  to_version                  TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('running','success','failed','rolled_back')),
  snapshot_worker_url         TEXT,
  snapshot_admin_deployment   TEXT,
  snapshot_liff_deployment    TEXT,
  events_jsonl                TEXT NOT NULL DEFAULT '',
  error                       TEXT,
  rollback_of                 TEXT REFERENCES update_history(id),
  rollback_expires_at         INTEGER
);

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  phone        TEXT,
  external_id  TEXT,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX idx_ab_tests_account ON ab_tests (account_id);

CREATE INDEX idx_ad_conversion_logs_friend ON ad_conversion_logs (friend_id);

CREATE INDEX idx_ad_conversion_logs_platform ON ad_conversion_logs (ad_platform_id);

CREATE INDEX idx_ad_conversion_logs_status ON ad_conversion_logs (status);

CREATE INDEX idx_affiliate_clicks_affiliate ON affiliate_clicks (affiliate_id);

CREATE INDEX idx_ai_faq_drafts_account_status ON ai_faq_drafts(line_account_id, status);

CREATE INDEX idx_ai_usage_budget_date ON ai_usage_budget(usage_date);

CREATE INDEX idx_auto_replies_template_id ON auto_replies(template_id);

CREATE INDEX idx_automation_logs_automation ON automation_logs (automation_id);

CREATE INDEX idx_automations_active ON automations (is_active);

CREATE INDEX idx_automations_event ON automations (event_type);

CREATE INDEX idx_bookings_account_status_starts ON bookings (line_account_id, status, starts_at);

CREATE INDEX idx_bookings_friend_starts ON bookings (friend_id, starts_at DESC);

CREATE INDEX idx_bookings_staff_overlap ON bookings (staff_id, status, starts_at, block_ends_at);

CREATE INDEX idx_broadcast_insights_broadcast_id ON broadcast_insights(broadcast_id);

CREATE INDEX idx_broadcast_insights_status ON broadcast_insights(status);

CREATE INDEX idx_broadcasts_ab_test_id ON broadcasts (ab_test_id);

CREATE INDEX idx_broadcasts_campaign ON broadcasts (campaign_id);

CREATE INDEX idx_broadcasts_status ON broadcasts (status);

CREATE INDEX idx_calendar_bookings_friend ON calendar_bookings (friend_id);

CREATE INDEX idx_calendar_bookings_start ON calendar_bookings (start_at);

CREATE INDEX idx_campaigns_account ON campaigns(account_id);

CREATE INDEX idx_canned_responses_account ON canned_responses(line_account_id);

CREATE INDEX idx_chats_friend ON chats (friend_id);

CREATE INDEX idx_chats_operator ON chats (operator_id);

CREATE INDEX idx_chats_status ON chats (status);

CREATE INDEX idx_conversion_events_affiliate ON conversion_events (affiliate_code);

CREATE INDEX idx_conversion_events_friend ON conversion_events (friend_id);

CREATE INDEX idx_conversion_events_point ON conversion_events (conversion_point_id);

CREATE INDEX idx_entry_routes_pool ON entry_routes (pool_id);

CREATE INDEX idx_entry_routes_ref ON entry_routes (ref_code);

CREATE INDEX idx_event_booking_idempotency_expires ON event_booking_idempotency_keys (expires_at);

CREATE INDEX idx_event_booking_reminders_status_scheduled ON event_booking_reminders (status, scheduled_at);

CREATE INDEX idx_event_bookings_account_status_event ON event_bookings (line_account_id, status, event_id);

CREATE INDEX idx_event_bookings_friend_requested ON event_bookings (friend_id, requested_at DESC);

CREATE INDEX idx_event_bookings_identity_status
  ON event_bookings (event_id, identity_key, status);

CREATE INDEX idx_event_bookings_slot_status ON event_bookings (slot_id, status);

CREATE INDEX idx_event_slots_event_starts ON event_slots (event_id, starts_at);

CREATE INDEX idx_events_account_published_sort ON events (line_account_id, is_published, sort_order);

CREATE INDEX idx_faqs_account_active ON faqs(line_account_id, is_active);

CREATE INDEX idx_form_opens_form ON form_opens (form_id, opened_at);

CREATE INDEX idx_form_submissions_form ON form_submissions (form_id);

CREATE INDEX idx_form_submissions_friend ON form_submissions (friend_id);

CREATE INDEX idx_formaloo_ai_chat_daily_guard
  ON formaloo_ai_chat_history (tenant_scope, credit_reserved, created_at);

CREATE INDEX idx_formaloo_ai_chat_history_scope
  ON formaloo_ai_chat_history (tenant_scope, line_account_id, form_id, created_at DESC);

CREATE UNIQUE INDEX idx_formaloo_ai_chat_one_pending
  ON formaloo_ai_chat_history (tenant_scope, line_account_id, form_id)
  WHERE status = 'pending';

CREATE INDEX idx_formaloo_choice_lists_form ON formaloo_choice_lists (form_id, updated_at);

CREATE INDEX idx_formaloo_drift_events_form ON formaloo_drift_events (form_id, detected_at);

CREATE INDEX idx_formaloo_edit_mail_sends_form ON formaloo_edit_mail_sends (form_id, requested_at);

CREATE INDEX idx_formaloo_edit_mail_sends_status ON formaloo_edit_mail_sends (status, requested_at);

CREATE INDEX idx_formaloo_field_map_form ON formaloo_field_map (form_id, position);

CREATE INDEX idx_formaloo_folders_account ON formaloo_folders (line_account_id);

CREATE INDEX idx_formaloo_forms_account ON formaloo_forms (line_account_id, deleted, updated_at);

CREATE INDEX idx_formaloo_forms_folder ON formaloo_forms (folder_id);

CREATE INDEX idx_formaloo_forms_slug ON formaloo_forms (formaloo_slug);

CREATE UNIQUE INDEX idx_formaloo_recurring_active_fingerprint
  ON formaloo_recurring_submissions (form_id, request_fingerprint)
  WHERE status != 'cancelled';

CREATE INDEX idx_formaloo_recurring_form
  ON formaloo_recurring_submissions (form_id, created_at DESC);

CREATE UNIQUE INDEX idx_formaloo_recurring_remote_slug
  ON formaloo_recurring_submissions (form_id, remote_slug)
  WHERE remote_slug IS NOT NULL;

CREATE INDEX idx_formaloo_saved_filters_form ON formaloo_saved_filters (form_id);

CREATE INDEX idx_formaloo_submission_edits_form ON formaloo_submission_edits (form_id, edited_at);

CREATE INDEX idx_formaloo_submission_edits_submission ON formaloo_submission_edits (submission_id, edited_at);

CREATE INDEX idx_formaloo_submissions_form ON formaloo_submissions (form_id, submitted_at);

CREATE INDEX idx_formaloo_submissions_friend ON formaloo_submissions (friend_id);

CREATE INDEX idx_formaloo_submissions_friend_latest ON formaloo_submissions (form_id, friend_id, submitted_at);

CREATE INDEX idx_formaloo_submissions_unverified ON formaloo_submissions (form_id, verified);

CREATE INDEX idx_formaloo_workspaces_active ON formaloo_workspaces (is_active);

CREATE INDEX idx_friend_field_definitions_active_order
  ON friend_field_definitions (is_active, display_order, id);

CREATE UNIQUE INDEX idx_friend_field_definitions_name
  ON friend_field_definitions (name);

CREATE INDEX idx_friend_reminders_friend ON friend_reminders (friend_id);

CREATE INDEX idx_friend_reminders_status ON friend_reminders (status);

CREATE INDEX idx_friend_scenarios_friend_id ON friend_scenarios (friend_id);

CREATE INDEX idx_friend_scenarios_next_delivery_at ON friend_scenarios (next_delivery_at);

CREATE INDEX idx_friend_scenarios_status ON friend_scenarios (status);

CREATE UNIQUE INDEX idx_friend_scenarios_unique ON friend_scenarios (friend_id, scenario_id) WHERE status != 'completed';

CREATE INDEX idx_friend_scores_created ON friend_scores (created_at);

CREATE INDEX idx_friend_scores_friend ON friend_scores (friend_id);

CREATE INDEX idx_friend_tags_tag_id ON friend_tags (tag_id);

CREATE INDEX idx_friends_ig_igsid ON friends (ig_igsid);

CREATE INDEX idx_friends_line_user_id ON friends (line_user_id);

CREATE INDEX idx_friends_user_id ON friends (user_id);

CREATE INDEX idx_health_logs_account ON account_health_logs (line_account_id);

CREATE INDEX idx_idempotency_expires ON booking_idempotency_keys (expires_at);

CREATE INDEX idx_internal_form_submissions_form
  ON internal_form_submissions (form_id, submitted_at);

CREATE INDEX idx_internal_form_submissions_friend
  ON internal_form_submissions (friend_id);

CREATE INDEX idx_knowledge_chunks_acct ON knowledge_chunks(line_account_id);

CREATE INDEX idx_knowledge_chunks_doc ON knowledge_chunks(source_doc_id);

CREATE INDEX idx_line_accounts_display_order
  ON line_accounts (display_order, created_at);

CREATE INDEX idx_link_clicks_friend ON link_clicks (friend_id);

CREATE INDEX idx_link_clicks_link ON link_clicks (tracked_link_id);

CREATE INDEX idx_lp_views_friend ON lp_views (friend_id);

CREATE INDEX idx_lp_views_slug ON lp_views (lp_slug, viewed_at);

CREATE INDEX idx_menus_account_sort ON menus (line_account_id, sort_order);

CREATE INDEX idx_messages_log_broadcast_id ON messages_log (broadcast_id);

CREATE INDEX idx_messages_log_created_at ON messages_log (created_at);

CREATE INDEX idx_messages_log_friend_direction_created ON messages_log (friend_id, direction, created_at);

CREATE INDEX idx_messages_log_friend_id ON messages_log (friend_id);

CREATE INDEX idx_messages_log_friend_source ON messages_log (friend_id, source);

CREATE INDEX idx_notifications_created ON notifications (created_at);

CREATE INDEX idx_notifications_status ON notifications (status);

CREATE INDEX idx_ref_tracking_friend ON ref_tracking (friend_id);

CREATE INDEX idx_ref_tracking_ref    ON ref_tracking (ref_code);

CREATE INDEX idx_reminder_steps_reminder ON reminder_steps (reminder_id);

CREATE INDEX idx_reminders_status_scheduled ON booking_reminders (status, scheduled_at);

CREATE INDEX idx_response_schedules_account ON response_schedules(line_account_id);

CREATE INDEX idx_rich_menu_areas_page     ON rich_menu_areas(page_id);

CREATE INDEX idx_rich_menu_display_rules_winner
  ON rich_menu_display_rules(account_id, is_active, priority DESC, created_at ASC, id ASC);

CREATE INDEX idx_rich_menu_friend_assignments_account
  ON rich_menu_friend_assignments(account_id, friend_id);

CREATE INDEX idx_rich_menu_groups_account ON rich_menu_groups(account_id, status);

CREATE INDEX idx_rich_menu_pages_group    ON rich_menu_pages(group_id, order_index);

CREATE INDEX idx_rich_menu_rule_queue_ready
  ON rich_menu_rule_evaluation_queue(available_at, friend_id);

CREATE INDEX idx_rich_menu_rule_reapply_jobs_latest
  ON rich_menu_rule_reapply_jobs(account_id, created_at DESC);

CREATE UNIQUE INDEX idx_rich_menu_rule_reapply_jobs_one_running
  ON rich_menu_rule_reapply_jobs(account_id) WHERE status = 'running';

CREATE INDEX idx_rich_menu_rule_schedule_friends
  ON friends(line_account_id, is_following, id);

CREATE INDEX idx_rich_menu_rule_schedule_from
  ON rich_menu_display_rules(is_active, active_from, account_id) WHERE active_from IS NOT NULL;

CREATE INDEX idx_rich_menu_rule_schedule_until
  ON rich_menu_display_rules(is_active, active_until, account_id) WHERE active_until IS NOT NULL;

CREATE UNIQUE INDEX idx_role_permissions_role_feature
  ON role_permissions(role_id, feature_key);

CREATE INDEX idx_saved_searches_account ON saved_searches(line_account_id);

CREATE INDEX idx_scenario_steps_scenario_id ON scenario_steps (scenario_id);

CREATE INDEX idx_sender_presets_account ON sender_presets (line_account_id);

CREATE INDEX idx_sheets_connections_account
  ON sheets_connections (line_account_id, is_active, updated_at);

CREATE UNIQUE INDEX idx_sheets_connections_active_form
  ON sheets_connections (line_account_id, form_id)
  WHERE is_active = 1 AND deleted_at IS NULL;

CREATE INDEX idx_sheets_sync_audit_connection
  ON sheets_sync_audit_log (connection_id, created_at);

CREATE INDEX idx_sheets_sync_audit_details_parent
  ON sheets_sync_audit_details (audit_id, created_at, id);

CREATE UNIQUE INDEX idx_sheets_sync_audit_sequence
  ON sheets_sync_audit_log (connection_id, connection_version, apply_sequence);

CREATE UNIQUE INDEX idx_sheets_sync_ledger_row
  ON sheets_sync_ledger (connection_id, sheet_row_number)
  WHERE sheet_row_number IS NOT NULL;

CREATE INDEX idx_shifts_staff_date ON staff_shifts (staff_id, work_date);

CREATE INDEX idx_staff_account_sort ON staff (line_account_id, sort_order);

CREATE UNIQUE INDEX idx_staff_members_api_key ON staff_members(api_key);

CREATE UNIQUE INDEX idx_staff_members_login_id
  ON staff_members(login_id) WHERE login_id IS NOT NULL;

CREATE INDEX idx_staff_members_role ON staff_members(role);

CREATE INDEX idx_staff_members_role_id ON staff_members(role_id);

CREATE INDEX idx_stripe_events_friend ON stripe_events (friend_id);

CREATE INDEX idx_stripe_events_type ON stripe_events (event_type);

CREATE INDEX idx_template_pack_items_pack ON template_pack_items(pack_id, order_index);

CREATE INDEX idx_template_packs_account ON template_packs(account_id);

CREATE INDEX idx_templates_category ON templates (category);

CREATE INDEX idx_test_send_requests_account_created
  ON test_send_requests (line_account_id, created_at);

CREATE INDEX idx_unmatched_account_created ON unmatched_questions(line_account_id, created_at);

CREATE INDEX idx_update_history_started ON update_history(started_at DESC);

CREATE INDEX idx_users_email ON users (email);

CREATE INDEX idx_users_external_id ON users (external_id);

CREATE INDEX idx_users_phone ON users (phone);

CREATE TRIGGER faqs_fts_ad AFTER DELETE ON faqs BEGIN DELETE FROM faqs_fts WHERE rowid = OLD.rowid; END;

CREATE TRIGGER faqs_fts_ai AFTER INSERT ON faqs BEGIN INSERT INTO faqs_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text); END;

CREATE TRIGGER faqs_fts_au AFTER UPDATE ON faqs BEGIN DELETE FROM faqs_fts WHERE rowid = OLD.rowid; INSERT INTO faqs_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text); END;

CREATE TRIGGER knowledge_chunks_fts_ad AFTER DELETE ON knowledge_chunks BEGIN DELETE FROM knowledge_chunks_fts WHERE rowid = OLD.rowid; END;

CREATE TRIGGER knowledge_chunks_fts_ai AFTER INSERT ON knowledge_chunks BEGIN INSERT INTO knowledge_chunks_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text); END;

CREATE TRIGGER knowledge_chunks_fts_au AFTER UPDATE ON knowledge_chunks BEGIN DELETE FROM knowledge_chunks_fts WHERE rowid = OLD.rowid; INSERT INTO knowledge_chunks_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text); END;

CREATE TRIGGER trg_rich_menu_rule_account_reactivate AFTER UPDATE OF is_active ON line_accounts WHEN OLD.is_active IS NOT 1 AND NEW.is_active = 1 BEGIN INSERT INTO rich_menu_rule_evaluation_queue (friend_id, attempts, available_at, last_error, lease_token, revision, updated_at) SELECT f.id, 0, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'), NULL, NULL, 1, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') FROM friends f WHERE f.line_account_id = NEW.id AND f.is_following = 1 AND (EXISTS (SELECT 1 FROM rich_menu_display_rules r WHERE r.account_id = NEW.id AND r.is_active = 1) OR EXISTS (SELECT 1 FROM rich_menu_friend_assignments a WHERE a.friend_id = f.id)) ON CONFLICT(friend_id) DO UPDATE SET attempts = 0, available_at = CASE WHEN rich_menu_rule_evaluation_queue.lease_token IS NULL THEN excluded.available_at ELSE rich_menu_rule_evaluation_queue.available_at END, last_error = NULL, revision = rich_menu_rule_evaluation_queue.revision + 1, updated_at = excluded.updated_at; END;

CREATE TRIGGER trg_rich_menu_rule_friend_update AFTER UPDATE OF metadata, line_account_id, is_following ON friends WHEN OLD.metadata IS NOT NEW.metadata OR OLD.line_account_id IS NOT NEW.line_account_id OR (OLD.is_following IS NOT 1 AND NEW.is_following = 1) BEGIN INSERT INTO rich_menu_rule_evaluation_queue (friend_id, attempts, available_at, last_error, lease_token, revision, updated_at) SELECT NEW.id, 0, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'), NULL, NULL, 1, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE EXISTS (SELECT 1 FROM rich_menu_display_rules r WHERE r.account_id = NEW.line_account_id AND r.is_active = 1) OR EXISTS (SELECT 1 FROM rich_menu_friend_assignments a WHERE a.friend_id = NEW.id) ON CONFLICT(friend_id) DO UPDATE SET attempts = 0, available_at = CASE WHEN rich_menu_rule_evaluation_queue.lease_token IS NULL THEN excluded.available_at ELSE rich_menu_rule_evaluation_queue.available_at END, last_error = NULL, revision = rich_menu_rule_evaluation_queue.revision + 1, updated_at = excluded.updated_at; END;

CREATE TRIGGER trg_rich_menu_rule_tag_delete AFTER DELETE ON friend_tags BEGIN INSERT INTO rich_menu_rule_evaluation_queue (friend_id, attempts, available_at, last_error, lease_token, revision, updated_at) SELECT OLD.friend_id, 0, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'), NULL, NULL, 1, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE EXISTS (SELECT 1 FROM friends WHERE id = OLD.friend_id) AND (EXISTS (SELECT 1 FROM friends f JOIN rich_menu_display_rules r ON r.account_id = f.line_account_id AND r.is_active = 1 WHERE f.id = OLD.friend_id) OR EXISTS (SELECT 1 FROM rich_menu_friend_assignments a WHERE a.friend_id = OLD.friend_id)) ON CONFLICT(friend_id) DO UPDATE SET attempts = 0, available_at = CASE WHEN rich_menu_rule_evaluation_queue.lease_token IS NULL THEN excluded.available_at ELSE rich_menu_rule_evaluation_queue.available_at END, last_error = NULL, revision = rich_menu_rule_evaluation_queue.revision + 1, updated_at = excluded.updated_at; END;

CREATE TRIGGER trg_rich_menu_rule_tag_insert AFTER INSERT ON friend_tags BEGIN INSERT INTO rich_menu_rule_evaluation_queue (friend_id, attempts, available_at, last_error, lease_token, revision, updated_at) SELECT NEW.friend_id, 0, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'), NULL, NULL, 1, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE EXISTS (SELECT 1 FROM friends f JOIN rich_menu_display_rules r ON r.account_id = f.line_account_id AND r.is_active = 1 WHERE f.id = NEW.friend_id) OR EXISTS (SELECT 1 FROM rich_menu_friend_assignments a WHERE a.friend_id = NEW.friend_id) ON CONFLICT(friend_id) DO UPDATE SET attempts = 0, available_at = CASE WHEN rich_menu_rule_evaluation_queue.lease_token IS NULL THEN excluded.available_at ELSE rich_menu_rule_evaluation_queue.available_at END, last_error = NULL, revision = rich_menu_rule_evaluation_queue.revision + 1, updated_at = excluded.updated_at; END;

CREATE TRIGGER trg_rich_menu_rule_tag_name_update AFTER UPDATE OF name ON tags WHEN OLD.name IS NOT NEW.name BEGIN INSERT INTO rich_menu_rule_evaluation_queue (friend_id, attempts, available_at, last_error, lease_token, revision, updated_at) SELECT ft.friend_id, 0, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'), NULL, NULL, 1, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') FROM friend_tags ft JOIN friends f ON f.id = ft.friend_id WHERE ft.tag_id = NEW.id AND (EXISTS (SELECT 1 FROM rich_menu_display_rules r WHERE r.account_id = f.line_account_id AND r.is_active = 1) OR EXISTS (SELECT 1 FROM rich_menu_friend_assignments a WHERE a.friend_id = ft.friend_id)) ON CONFLICT(friend_id) DO UPDATE SET attempts = 0, available_at = CASE WHEN rich_menu_rule_evaluation_queue.lease_token IS NULL THEN excluded.available_at ELSE rich_menu_rule_evaluation_queue.available_at END, last_error = NULL, revision = rich_menu_rule_evaluation_queue.revision + 1, updated_at = excluded.updated_at; END;

CREATE TRIGGER trg_sheets_connections_orphan_deactivate
AFTER UPDATE OF line_account_id ON sheets_connections
WHEN NEW.line_account_id IS NULL AND NEW.is_active = 1
BEGIN DELETE FROM sheets_sync_ledger WHERE connection_id = NEW.id; UPDATE sheets_connections SET is_active = 0, deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE id = NEW.id; END;

CREATE TRIGGER trg_sheets_sync_audit_details_no_delete
BEFORE DELETE ON sheets_sync_audit_details
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_details is append-only'); END;

CREATE TRIGGER trg_sheets_sync_audit_details_no_replace
BEFORE INSERT ON sheets_sync_audit_details
WHEN EXISTS (SELECT 1 FROM sheets_sync_audit_details WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_details is append-only'); END;

CREATE TRIGGER trg_sheets_sync_audit_details_no_update
BEFORE UPDATE ON sheets_sync_audit_details
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_details is append-only'); END;

CREATE TRIGGER trg_sheets_sync_audit_no_delete
BEFORE DELETE ON sheets_sync_audit_log
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_log is append-only'); END;

CREATE TRIGGER trg_sheets_sync_audit_no_replace
BEFORE INSERT ON sheets_sync_audit_log
WHEN EXISTS (SELECT 1 FROM sheets_sync_audit_log WHERE id = NEW.id)
  OR EXISTS (
    SELECT 1 FROM sheets_sync_audit_log
    WHERE connection_id = NEW.connection_id
      AND connection_version = NEW.connection_version
      AND apply_sequence = NEW.apply_sequence
  )
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_log is append-only'); END;

CREATE TRIGGER trg_sheets_sync_audit_no_update
BEFORE UPDATE ON sheets_sync_audit_log
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_log is append-only'); END;

CREATE TRIGGER trg_sheets_sync_ledger_version_insert
BEFORE INSERT ON sheets_sync_ledger
WHEN NOT EXISTS (SELECT 1 FROM sheets_connections WHERE id = NEW.connection_id AND config_version = NEW.connection_version AND is_active = 1 AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'sheets_sync_ledger connection version mismatch'); END;

CREATE TRIGGER trg_sheets_sync_ledger_version_update
BEFORE UPDATE ON sheets_sync_ledger
WHEN NOT EXISTS (SELECT 1 FROM sheets_connections WHERE id = NEW.connection_id AND config_version = NEW.connection_version AND is_active = 1 AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'sheets_sync_ledger connection version mismatch'); END;
