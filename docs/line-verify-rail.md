# LINE verification rail

This rail turns the repeated deployed checks for LINE webhooks and hosted forms into one command. It is intentionally limited to verification, measurement, contracts, and non-regression checks. It does not automate the LINE mobile application and it never enables production flags.

## One-command run

Prerequisites:

- `LINE_CHANNEL_SECRET` is exported from the approved secret store. Do not pass it as a CLI argument.
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are exported for live Worker tail evidence.
- Chrome DevTools Protocol is listening on `127.0.0.1:9222`.
- `pnpm install --frozen-lockfile` has completed.

Run every verification in the rail:

```bash
pnpm exec tsx scripts/line-verify-rail.ts \
  --scenario all \
  --evidence-dir .sola/evidence/line-verify-rail
```

Run only one area by replacing `all` with `webhook` or `liff-form`. A successful run prints one summary line and writes `summary.json`; any missing credential, target mismatch, render mismatch, response mismatch, or absent live log branch exits non-zero.

## Scenario ledger

[`scripts/line-verify-scenarios.json`](../scripts/line-verify-scenarios.json) is the machine-readable ledger. `caseTypes` maps each change class to verification IDs, `verifications` maps those IDs to runners, and `targets` is the exact URL/form allowlist. The CLI always consumes this reviewed in-repository ledger and rejects a caller-supplied registry.

- `webhook`: local HMAC contract plus deployed positive/negative signature branches.
- `liff-form`: hosted form initial render, prefill, submit, re-entry, and edit.
- `worker-change`: both webhook and hosted-form rails.
- `all`: every rail verification.

Add a target only when it is an explicitly dedicated test object. A form target must include `testOnly: true`, the hosted service's exact form ID and path, the exact submission origin/path, a visible marker, selectors, and synthetic values. Before it types or clicks, the runner reads the deployed form metadata and matches the form ID, public address, title, success text, and field ID. Every observed page path and submission endpoint is checked against the ledger; any mismatch is rejected.

## Webhook evidence contract

The local check signs the raw body with HMAC-SHA256, then calls the same verifier used by the Worker. It requires a valid signature to pass and a one-byte-tampered signature to fail.

The deployed Worker intentionally returns HTTP 200 for both valid and invalid LINE signatures. Therefore HTTP status alone is not accepted as evidence. The rail opens a live Wrangler tail and requires both observable branches:

- valid signature over intentionally malformed JSON → `Failed to parse webhook body`, proving signature verification passed before parsing;
- same body with a tampered signature → `Invalid LINE signature`, proving rejection before parsing.

It then sends one valid batch containing `follow`, `message`, and `postback`. Every event uses a group source with no `userId`. The current Worker returns before friend creation, message logging, scenario enrollment, reply, or push delivery for that shape. `assertSafeWebhookRequest` rejects user-scoped fixtures before network I/O.

Artifacts:

- `webhook-local.json`
- `webhook-deployed.json`

No secret, access token, Authorization header, or `X-Line-Signature` value is persisted.

## Hosted form evidence contract

The allowlisted form is visibly named `LINE VERIFY RAIL TEST ONLY` and is reserved for synthetic submissions. The probe uses a LINE Android user agent and a 390×844 viewport through CDP. The local test-fixture ID is retained for traceability, while the hosted form ID is verified from Formaloo's deployed metadata before interaction.

It executes five phases:

1. initial render: marker visible and field empty;
2. prefill: allowlisted query parameter renders the synthetic value;
3. submit: CDP mouse input clicks the real submit button, observes the configured success text, and requires a successful POST from that action to the exact allowlisted form endpoint;
4. re-entry: the deployed form is loaded again and prefill is measured again;
5. edit: the field is changed to a second synthetic value, submitted, and independently requires the success render plus a second successful POST.

Each phase saves a PNG screenshot and an HTML fragment. `form-probe.json` records the live form identity, DOM assertions, filtered render responses, and separate `submit`/`edit` POST responses. Query values are redacted from JSON evidence.

## Closer / browser-evaluator handoff

Closer:

1. Select the case type from the ledger and run the one-command rail.
2. Require `summary.json.status === "PASS"` and the expected verification ID set.
3. For webhook work, require both live branch names in `webhook-deployed.json`; never infer rejection from HTTP 200.
4. For form work, require the allowlisted live form identity, all five phases, marker gating, LINE UA, screenshots, HTML fragments, and distinct successful `submit`/`edit` POST responses.
5. Run the unchanged regression suites before handoff:

```bash
pnpm --filter @line-crm/shared test
pnpm --filter worker test
pnpm --filter web test
```

Browser evaluator should inspect `01-initial.png` through `05-edit.png`, compare each with its matching HTML fragment, and confirm `form-probe.json` contains the five phases in order. A missing image, missing marker, selector mismatch, off-allowlist redirect, or failed submit is a failure.

## Safety boundary

- The hosted form is a dedicated test form; existing owner forms and submissions are not read, edited, or deleted.
- Webhook live checks use a no-user event shape that cannot reach the current Worker write/reply branches.
- The endpoint, hosted form ID/path, field ID, and form submission endpoint are exact allowlist entries; unknown URLs and IDs fail closed before a click or write.
- Credentials stay in environment memory and are never written to tracked files or evidence.
- The only deployed writes are synthetic submissions to the dedicated test form.
