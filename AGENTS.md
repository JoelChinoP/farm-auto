<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# GenFarmer Control Panel

## Purpose

This directory is the local control plane for GenFarmer. The browser only calls Next.js Route Handlers on `127.0.0.1:3000`; it must never call port `55554` directly.

The supported workflow is deliberately human-supervised:

- DeepSeek creates drafts only.
- Public likes, comments, and social interactions remain manual after navigation.
- WhatsApp automation is limited to one approved message, one consented recipient, and one sender device.
- Every device action starts from the Home screen when appropriate. Navigation sessions stay open for the operator and the `Ir a inicio` action closes them.
- Do not add bulk engagement, fake personas, coordinated likes, spam, rate-limit evasion, or unattended public posting.

## Architecture

- Next.js 16 App Router and React 19 provide UI and server-only Route Handlers.
- SQLite at `data/control-panel.sqlite` stores drafts, approvals, operations, idempotency keys, device locks, and imported automation IDs.
- `src/lib/genfarmer.ts` is the only GenFarmer HTTP client.
- `src/lib/adb.ts` uses `execFile`, validates connected device IDs, and never builds a host shell command from user input.
- `src/lib/automation-service.ts` owns import, task assignment, variable updates, execution, polling, and cleanup.
- `src/lib/messages.ts` owns DeepSeek generation, approval rules, consent, and single-message sending.

## GenFarmer Rules

- Use `/automation/...`, never renderer `/app/...` routes.
- Every list request must send `limit`, `page`, `order`, and `orderBy`.
- Import `.genfarm` by posting `{ "data": "<complete JSON file as a string>" }`.
- Create runs with status `0`; status `1` prevents the runner from starting.
- A task device entry uses ADB `currentDeviceId` as `id` and the GenFarmer `serialNo` for deduplication.
- A task must have `input: []`; the runner calls `forEach` on it.
- Runtime follows node `successNode` and `failNode`. Keep every non-null pointer synchronized with a visual `edge`.
- Run status `4` is not enough by itself. Check all device statuses and logs for `logType: "Failed"`.
- Never embed a real phone, message, API key, or account credential in an automation package.

## Automation Responsibilities

- `automations/device-home.genfarm`: only normalizes the device to Android Home.
- `automations/open-social-content.genfarm`: only opens a server-validated HTTPS URL in an allowlisted app.
- `automations/whatsapp-send-consented.genfarm`: types and sends one approved WhatsApp message, then returns Home.

Do not combine message generation with device execution. Do not add `SetVariable` nodes with operational values; task variables are updated by the server immediately before a locked execution.

## Security Invariants

- Keep `API_DEEPSEEK` in the root `.env`; never use a `NEXT_PUBLIC_` secret.
- Keep `GENFARMER_URL` loopback-only. `src/lib/config.ts` rejects non-local hosts.
- Validate social URL protocol and hostname before variable substitution.
- Normalize recipients to 8-15 international digits and require explicit consent.
- Preserve failed idempotent operations instead of retrying an uncertain send.
- Assign each task to one device. Do not broaden a sender task to a device pool.
- Never log secrets or full `.env` values.

## Development

Use Node.js 24 or newer in this environment.

```powershell
npm install
npm run dev
npm run check
```

`npm run dev` and `npm start` bind to `127.0.0.1`. Before changing Next.js conventions, read the matching guide under `node_modules/next/dist/docs/` as required by the generated rules above.

## Change Checklist

- Run `npm run lint`.
- Run `npm test`.
- Run `npm run build`.
- Validate every `.genfarm` as JSON and run `test/automations.test.ts`.
- For device changes, test success, invalid input, missing app, disconnected device, and cleanup to Home.
- Do not mark WhatsApp end-to-end as verified unless `com.whatsapp` is actually installed and a consented test recipient is available.

## Current Machine Blockers

- On 2026-08-26, GenFarmer imported all three packages and tasks but rejected runs for `emulator-5554` with `Automation feature is expired` during remote serial validation. Do not bypass this check; activate the device/license and rerun integration tests.
- TikTok and Facebook intents and Home were verified directly through ADB to isolate the entitlement failure. WhatsApp is not installed.
- GenFarmer's two inbound firewall allow rules remain enabled because this session is not elevated. Run `scripts/secure-genfarmer-firewall.ps1` from an administrator PowerShell and verify loopback afterward.
