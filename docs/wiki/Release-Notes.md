# Release Notes

## v0.14.1 (2026-05-20)

Patch release for the OSS sync line from the private `line-harness` repository.

### Changed

- Synced the latest allowlisted worker updates from private `line-harness` into `line-harness-oss`.
- Kept OSS-specific CI and regression guards intact during the sync.
- Cleaned up update-route typing and removed unused LIFF event booking aliases.

### Verification

- `pnpm --filter worker typecheck`
- `pnpm --filter worker test`
- `pnpm --filter worker build`

### Notes

- The sync does not delete OSS-only files. Paths reported by `harness-oss-sync` as `would_delete_manual` remain manual review items.
- Private uncommitted reminder-dedup work was not included; this release was prepared from private `HEAD`.
