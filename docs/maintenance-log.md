# Maintenance log

Generated from the health-check history and audit trail by `qa-accounts report all`. One section per monitored calendar day. Do not edit by hand - record actions with `qa-accounts maintenance add` and regenerate.

> **Data source.** All accounts are mock accounts served by the mock platform layer. 4 of 5 day(s) below (2026-11-24, 2026-11-25, 2026-11-26, 2026-11-27) are simulated-clock runs: the real health-check engine executed with an injected date, and the actions logged on those days are the scripted responses from `data/maintenance-actions.json`. Days marked "live run" were executed on that calendar day.

## Day 0 - setup and onboarding

- 15 account record(s) in the inventory:
  - LinkedIn: 3
  - Facebook: 3
  - Instagram: 3
  - TikTok: 3
  - X: 3
- 15 of 15 account(s) taken through the connection workflow (docs/connection-workflow.md):
  - LI-001, LI-002, LI-003, FB-001, FB-002, FB-003, IG-001, IG-002, IG-003, TT-001, TT-002, TT-003, X-001, X-002, X-003: 2026-11-23 - Onboarded: connection workflow walked through and recorded against the mock platform layer (mock account - no live Spikerz connection) [evidence: docs/connection-workflow.md] _(by qa-engineer)_

## Day 1 - 2026-11-23

- Check type: live run · 15 accounts checked · 15 healthy, 0 warning, 0 failing.
- Changes since previous check: none.
- Corrective / maintenance actions: none required.

## Day 2 - 2026-11-24

- Check type: simulated-clock run · 15 accounts checked · 13 healthy, 1 warning, 1 failing.
- Changes since previous check:
  - **FB-003** raised `PERMISSION_MISSING` - Page admin role downgraded; pages_manage_posts no longer granted | missing permission(s): pages_manage_posts
  - **X-003** raised `RETRY_RECOVERED` - succeeded on attempt 3 after: HTTP 429 Too Many Requests returned by mock X API on the first two attempts
- Corrective / maintenance actions:
  - X-003 - Reviewed RETRY_RECOVERED warning: two HTTP 429 responses, third attempt succeeded. No action; watching for recurrence. _(by qa-engineer)_
  - FB-003 - Confirmed pages_manage_posts missing from granted scopes. Raised with Page owner to restore the admin role. _(by qa-engineer)_

## Day 3 - 2026-11-25

- Check type: simulated-clock run · 15 accounts checked · 12 healthy, 0 warning, 3 failing.
- Changes since previous check:
  - **LI-002** raised `TOKEN_EXPIRED` - 401 invalid_token: access token expired and refresh token was not rotated
  - **LI-002** connection connected -> error
  - **TT-002** raised `ACCOUNT_RESTRICTED` - Account flagged by platform integrity checks; API returns account_restricted
  - **TT-002** account status active -> restricted
  - **X-003** cleared `RETRY_RECOVERED`
- Corrective / maintenance actions:
  - FB-003 - Admin role restored on Mock QA Page B and account reconnected so pages_manage_posts is re-granted. Expect clear on next check. _(by qa-engineer)_
  - LI-002 - Token expired. Re-authorised the account to mint a new access token; opened follow-up to find out why refresh did not run. _(by qa-engineer)_
  - TT-002 - Account restricted by platform. Paused all tests that use TT-002; will re-check for 48h before replacing. _(by qa-engineer)_

## Day 4 - 2026-11-26

- Check type: simulated-clock run · 15 accounts checked · 12 healthy, 1 warning, 2 failing.
- Changes since previous check:
  - **FB-003** cleared `PERMISSION_MISSING`
  - **IG-001** raised `DISCONNECTED` - Session invalidated after a password change on the linked account
  - **IG-001** connection connected -> disconnected
  - **LI-002** cleared `TOKEN_EXPIRED`
  - **LI-002** connection error -> connected
  - **LI-003** raised `TOKEN_EXPIRING_SOON` - Access token reaches end of lifetime in 3 days | token expires in 3 day(s)
- Corrective / maintenance actions:
  - IG-001 - Reconnected through the connection workflow after the session was invalidated by a password change [evidence: docs/connection-workflow.md] _(by qa-engineer)_
  - LI-003 - Token expiring in 3 days. Re-authorised proactively to avoid a disconnect. _(by qa-engineer)_

## Day 5 - 2026-11-27

- Check type: simulated-clock run · 15 accounts checked · 13 healthy, 0 warning, 2 failing.
- Changes since previous check:
  - **FB-002** raised `ASSET_MISSING` - Page no longer returned by /me/accounts for the connected user | missing asset(s): page:Mock QA Page A
  - **IG-001** cleared `DISCONNECTED`
  - **IG-001** connection disconnected -> connected
  - **LI-003** cleared `TOKEN_EXPIRING_SOON`
- Corrective / maintenance actions:
  - TT-002 - Restriction has now lasted 3 checks (>48h). Proposed retirement via `account retire TT-002` and requested a standby TikTok test account. _(by qa-engineer)_
  - FB-002 - Mock QA Page A no longer returned for the connected user. Investigating whether the Page was unlinked or the user lost access; issue left open. _(by qa-engineer)_

