# Account onboarding and connection workflow

How a test account goes from "exists in the inventory" to "connected to the Spikerz UI and monitored".

## Approach used in this submission

**All 15 accounts are mock accounts, and connection is manual.**

- I did not create real social-media accounts. Bulk-creating accounts for testing runs against the terms of every platform in scope (fake-identity and automation clauses), triggers bot detection, and in a 72-hour window would have produced restricted accounts rather than useful test data. A real programme needs platform-sanctioned test assets (Meta test users / test Pages, TikTok sandbox apps, X developer test accounts, LinkedIn developer test companies) owned by the company.
- I did not automate the connection step. Connecting a real account means going through each platform's OAuth consent screen. Scripting someone's login and consent is credential handling the tool should not do, and it breaks on 2FA and CAPTCHA anyway. The connection is therefore a documented manual procedure; after a person completes it, the tool records who did it, when, and where the evidence is.

For this mock submission, no Spikerz UI steps were performed. The `account connect` entries are mock onboarding records for the proposed workflow, not evidence of a completed connection. The evidence table at the bottom is where real screenshots go once authorised test accounts and Spikerz workspace access are available.

## Workflow

| # | Step | Where | Recorded as |
|---|---|---|---|
| 1 | Add the account to the inventory with `connection_status = pending` | `account add` or `account import` | `create` audit entry |
| 2 | Store the account's secret in the secrets manager under its credential reference ID | Secrets manager / `.env` locally | Nothing in the repo or DB; `creds` shows presence only |
| 3 | Sign in to the Spikerz workspace used for QA | Spikerz UI | - |
| 4 | Start "connect account" for the platform and complete the platform's own consent screen | Spikerz UI -> platform OAuth | Screenshot of consent screen (scopes visible) |
| 5 | Select the assets to connect (Page, IG business account, handle) | Spikerz UI | Screenshot of asset selection |
| 6 | Confirm the account shows as connected in Spikerz | Spikerz UI | Screenshot of connected state |
| 7 | Record the connection | `account connect <id> --note "..." --evidence <path>` | `connect` audit entry + line in `data/maintenance-actions.json` |
| 8 | Run a health check to confirm the baseline | `check run --account <id>` | Health-check row; must be healthy before monitoring starts |

Step 7 example:

```bash
npm run cli -- --actor victor account connect IG-001 \
  --note "Connected via Spikerz UI; instagram_basic, instagram_manage_comments, instagram_content_publish granted" \
  --evidence docs/evidence/IG-001-connected.png
```

## Platform-specific notes

| Platform | Account types | What is granted at connection | Things that commonly break it later |
|---|---|---|---|
| LinkedIn | Member profile, Company Page | Member and organisation scopes; Page requires the member to be a Page admin | 60-day access tokens; admin role removed |
| Facebook | Profile, Page | Page scopes via a user who has a role on the Page | Role downgraded; Page unpublished; user password change invalidates tokens |
| Instagram | Business, Creator | Granted through the linked Facebook Page | Page unlinked from IG account; account switched back to personal |
| TikTok | Business, Creator | Scopes approved for the app | New-account restrictions; scope not approved for the app |
| X | Profile, Brand | OAuth 2.0 scopes; `offline.access` needed for refresh | API tier rate limits; refresh token rotation |

These are the failure modes the mock scenarios in `data/mock-scenarios.json` are modelled on.

## Reconnection

A `DISCONNECTED` or `TOKEN_EXPIRED` result is fixed by repeating steps 3-8 for that account. The reconnection is recorded with the same `account connect` command and shows up under that day's corrective actions in the maintenance log and in the related issue.

## Retirement

```bash
npm run cli -- account retire TT-002
```

Marks the account `retired` and `disconnected`, keeps its history and audit trail, and removes it from future health checks. Manual follow-up: disconnect it in the Spikerz UI, revoke the app grant on the platform, delete its secret from the secrets manager.

## Connection evidence

| Account | Platform | Mock onboarding recorded | Evidence |
|---|---|---|---|
| LI-001 | LinkedIn | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| LI-002 | LinkedIn | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| LI-003 | LinkedIn | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| FB-001 | Facebook | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| FB-002 | Facebook | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| FB-003 | Facebook | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| IG-001 | Instagram | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| IG-002 | Instagram | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| IG-003 | Instagram | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| TT-001 | TikTok | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| TT-002 | TikTok | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| TT-003 | TikTok | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| X-001 | X | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| X-002 | X | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |
| X-003 | X | 2026-11-23 | Mock onboarding record only - no Spikerz UI connection performed |

<!-- If Spikerz workspace access is available: add screenshots under docs/evidence/ and replace the Evidence cell with the image link. -->
