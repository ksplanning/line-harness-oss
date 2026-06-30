import * as p from "@clack/prompts";
import { writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { wrangler, WranglerError } from "../lib/wrangler.js";
import {
  renderInstalledWranglerToml,
  type InstalledWranglerConfig,
} from "../lib/installed-wrangler.js";
import { repoPnpm } from "../lib/pnpm.js";

const WORKERS_DEV_URL = /(https:\/\/[^\s]+\.workers\.dev)/;
const TTY_REQUIRED = /non[- ]?interactive|cloudflare_api_token|consent denied|authentication error|expired/i;
const RETRYABLE_NETWORK_ERROR =
  /fetch failed|connectivity issue|network connectivity|connection reset|socket hang up/i;
const MAX_DEPLOY_ATTEMPTS = 3;

interface DeployWorkerOptions {
  repoDir: string;
  d1DatabaseId: string;
  d1DatabaseName: string;
  workerName: string;
  accountId: string;
  liffId: string;
  botBasicId: string;
  r2BucketName: string;
}

interface DeployWorkerResult {
  workerUrl: string;
}

interface SyncInstalledWorkerConfigOptions extends InstalledWranglerConfig {
  repoDir: string;
}

async function deployWorkerBundle(
  workerDir: string,
  workerName: string,
): Promise<string> {
  const deployAndParseUrl = async (): Promise<string> => {
    const output = await wrangler(["deploy"], { cwd: workerDir });
    const match = output.match(WORKERS_DEV_URL);
    if (!match) {
      throw new Error(`Worker URL を出力からパースできません:\n${output}`);
    }
    return match[1];
  };

  const isAuthError = (error: unknown): boolean =>
    error instanceof WranglerError &&
    TTY_REQUIRED.test(`${error.message}\n${error.stderr}`);

  const isRetryableNetworkError = (error: unknown): boolean => {
    const text =
      error instanceof WranglerError
        ? `${error.message}\n${error.stderr}`
        : error instanceof Error
          ? error.message
          : String(error);
    return RETRYABLE_NETWORK_ERROR.test(text);
  };

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  for (let attempt = 1; attempt <= MAX_DEPLOY_ATTEMPTS; attempt++) {
    try {
      return await deployAndParseUrl();
    } catch (firstError) {
      if (isAuthError(firstError)) {
        p.log.warn(
          "wrangler の認証を更新するため、対話モードで再実行します（出力が表示されます）...",
        );
        await wrangler(["deploy"], { cwd: workerDir, tty: true });

        try {
          return await deployAndParseUrl();
        } catch (urlError) {
          if (
            isRetryableNetworkError(urlError) &&
            attempt < MAX_DEPLOY_ATTEMPTS
          ) {
            p.log.warn(
              `Worker デプロイ後の確認中に一時的な通信エラーが発生したため再試行します (${attempt}/${MAX_DEPLOY_ATTEMPTS})...`,
            );
            await sleep(attempt * 2_000);
            continue;
          }

          const reason =
            urlError instanceof Error ? urlError.message : String(urlError);
          throw new Error(
            [
              "Worker のデプロイは完了しましたが URL を取得できませんでした。",
              `理由: ${reason}`,
              "",
              "対処:",
              "  1. もう一度同じコマンドを実行すると、worker ステップが再試行され URL を取得します。",
              `  2. または \`npx wrangler deployments list --name ${workerName}\` で URL を確認してください。`,
            ].join("\n"),
          );
        }
      }

      if (isRetryableNetworkError(firstError) && attempt < MAX_DEPLOY_ATTEMPTS) {
        p.log.warn(
          `Worker デプロイ中に一時的な通信エラーが発生したため再試行します (${attempt}/${MAX_DEPLOY_ATTEMPTS})...`,
        );
        await sleep(attempt * 2_000);
        continue;
      }

      throw firstError;
    }
  }

  throw new Error("Worker デプロイの再試行回数を超えました");
}

export async function deployWorker(
  options: DeployWorkerOptions,
): Promise<DeployWorkerResult> {
  const workerDir = join(options.repoDir, "apps/worker");
  const tomlPath = join(workerDir, "wrangler.toml");

  // Backup existing wrangler.toml
  const originalToml = existsSync(tomlPath)
    ? readFileSync(tomlPath, "utf-8")
    : null;

  // Write deploy wrangler.toml
  const deployToml = `name = "${options.workerName}"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
account_id = "${options.accountId}"

# Static assets (LIFF pages) served by Workers Assets
# SPA fallback ensures all non-API paths serve index.html
[assets]
not_found_handling = "single-page-application"

[[d1_databases]]
binding = "DB"
database_name = "${options.d1DatabaseName}"
database_id = "${options.d1DatabaseId}"

[[r2_buckets]]
binding = "IMAGES"
bucket_name = "${options.r2BucketName}"

[triggers]
crons = ["*/5 * * * *"]
`;
  writeFileSync(tomlPath, deployToml);

  // Write .env for Vite build (LIFF client env vars)
  const envPath = join(workerDir, ".env");
  const envContent = `VITE_LIFF_ID=${options.liffId}\nVITE_BOT_BASIC_ID=${options.botBasicId}\n`;
  writeFileSync(envPath, envContent);

  const buildSpinner = p.spinner();
  buildSpinner.start("Worker ビルド中...");
  try {
    // Build workspace dependencies that the worker needs
    await repoPnpm(
      options.repoDir,
      [
        "-r",
        "--filter",
        "./packages/shared",
        "--filter",
        "./packages/line-sdk",
        "--filter",
        "./packages/db",
        "--filter",
        "./packages/update-engine",
        "build",
      ],
      { cwd: options.repoDir },
    );
    await execa("npx", ["vite", "build"], { cwd: workerDir });
    buildSpinner.stop("Worker ビルド完了");

    // Pipe-first: capture deploy output so we can parse the real URL
    // (Cloudflare serves Workers at https://<worker>.<account-subdomain>.workers.dev,
    // so guessing the hostname is unsafe).
    const workerUrl = await deployWorkerBundle(workerDir, options.workerName);

    p.log.success(`Worker デプロイ完了: ${workerUrl}`);
    return { workerUrl };
  } catch (error) {
    // Make sure the spinner is stopped before the error bubbles up
    try {
      buildSpinner.stop("Worker デプロイ失敗");
    } catch {
      // already stopped
    }
    throw error;
  } finally {
    // Restore original wrangler.toml
    if (originalToml) {
      writeFileSync(tomlPath, originalToml);
    }
    // Clean up .env
    const deployEnvPath = join(workerDir, ".env");
    if (existsSync(deployEnvPath)) {
      unlinkSync(deployEnvPath);
    }
  }
}

export async function syncInstalledWorkerConfig(
  options: SyncInstalledWorkerConfigOptions,
): Promise<void> {
  const workerDir = join(options.repoDir, "apps/worker");
  const tomlPath = join(workerDir, "wrangler.toml");
  writeFileSync(tomlPath, renderInstalledWranglerToml(options));

  const s = p.spinner();
  s.start("Worker 設定反映中...");
  try {
    await deployWorkerBundle(workerDir, options.workerName);
    s.stop("Worker 設定反映完了");
  } catch (error) {
    s.stop("Worker 設定反映失敗");
    throw error;
  }
}
