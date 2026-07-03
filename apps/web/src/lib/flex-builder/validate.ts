/**
 * validateFlex — re-export shim (batch2 で packages/shared に移設・単一正典化)。
 *
 * 実体は `@line-crm/shared` (flex-validate.ts)。client (web) と server (worker) が同一関数・
 * 同一ルールを使い drift しない。既存 import (`@/lib/flex-builder/validate`) は本 shim 経由で
 * 不変に解決される (broadcast-form.tsx / flex-builder-modal.tsx / 各テスト)。
 */
export { validateFlex } from '@line-crm/shared';
