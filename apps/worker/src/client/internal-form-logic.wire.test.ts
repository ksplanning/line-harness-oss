import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const clientRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(clientRoot, '../../../..');
const publicClientSource = readFileSync(resolve(clientRoot, 'internal-form-logic.ts'), 'utf8');
const previewSource = readFileSync(
  resolve(repoRoot, 'apps/web/src/components/forms-advanced/form-preview.tsx'),
  'utf8',
);
const publicRouteSource = readFileSync(
  resolve(repoRoot, 'apps/worker/src/routes/internal-forms-public.ts'),
  'utf8',
);

function importSourceFor(source: string, symbol: string): string | null {
  const imports = source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g);
  for (const match of imports) {
    const names = match[1].split(',').map((name) => name.trim().replace(/^type\s+/, ''));
    if (names.includes(symbol)) return match[2];
  }
  return null;
}

describe('internal form logic import wire', () => {
  test.each(['evaluateInternalFormLogic', 'nextInternalFormFieldId'])(
    'published client and preview import %s from the exact shared engine module',
    (symbol) => {
      expect(importSourceFor(publicClientSource, symbol)).toBe('@line-crm/shared/internal-form-logic');
      expect(importSourceFor(previewSource, symbol)).toBe('@line-crm/shared/internal-form-logic');
    },
  );

  test('public route never serializes shared logic functions into HTML', () => {
    expect(publicRouteSource).not.toContain('evaluateInternalFormLogic.toString()');
    expect(publicRouteSource).not.toContain('nextInternalFormFieldId.toString()');
  });
});
