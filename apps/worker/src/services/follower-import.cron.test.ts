import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '../index.ts');

describe('follower import cron wiring', () => {
  test('resumes bounded imports only from the existing five-minute branch', () => {
    const source = readFileSync(INDEX_PATH, 'utf8');

    expect(source).toMatch(
      /import\s*\{[^}]*processDueFollowerImports[^}]*\}\s*from\s*['"]\.\/services\/follower-import\.js['"]/s,
    );
    expect(source).toMatch(
      /event\.cron\s*===\s*['"]\*\/5 \* \* \* \*['"][\s\S]{0,7000}processDueFollowerImports\s*\(\s*env\.DB\s*\)/,
    );
    expect(source.match(/processDueFollowerImports\s*\(\s*env\.DB\s*\)/g)).toHaveLength(1);
  });
});
