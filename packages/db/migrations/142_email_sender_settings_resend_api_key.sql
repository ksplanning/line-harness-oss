-- Migration 142: optional Resend credential scoped to one LINE account.
-- The value follows the existing LINE token storage pattern: D1-only and
-- never serialized to public API responses as plaintext.

ALTER TABLE email_sender_settings ADD COLUMN resend_api_key TEXT;
