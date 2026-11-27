# Maintenance log

Generated from the health-check history and audit trail by `qa-accounts report all`. One section per monitored calendar day. Do not edit by hand - record actions with `qa-accounts maintenance add` and regenerate.

## Day 0 - setup and onboarding

- 15 account record(s) in the inventory:
  - LinkedIn: 3
  - Facebook: 3
  - Instagram: 3
  - TikTok: 3
  - X: 3
- 15 of 15 account(s) with mock onboarding records for the proposed connection workflow (docs/connection-workflow.md):
  - LI-001, LI-002, LI-003, FB-001, FB-002, FB-003, IG-001, IG-002, IG-003, TT-001, TT-002, TT-003, X-001, X-002, X-003: 2026-11-23 - Mock onboarding record: proposed manual connection workflow documented; no Spikerz UI steps performed and no live connection created [evidence: docs/connection-workflow.md] _(by qa-engineer)_

## Day 1 - 2026-11-23

- Check type: live-clock run · 15 accounts checked · 15 healthy, 0 warning, 0 failing.
- Changes since previous check: none.
- Actions recorded ("Simulated:" = runbook response, not carried out): none.

## Day 2 - 2026-11-24

- Check type: live-clock run · 15 accounts checked · 13 healthy, 1 warning, 1 failing.
- Changes since previous check:
  - **FB-003** raised `PERMISSION_MISSING` - Page admin role downgraded; pages_manage_posts no longer granted | missing permission(s): pages_manage_posts
  - **X-003** raised `RETRY_RECOVERED` - succeeded on attempt 3 after: HTTP 429 Too Many Requests returned by mock X API on the first two attempts
- Actions recorded ("Simulated:" = runbook response, not carried out):
  - X-003 - Simulated: Runbook response to RETRY_RECOVERED (two HTTP 429 responses, third attempt succeeded): no action, watch for recurrence. _(by scenario-script)_
  - FB-003 - Simulated: Runbook response to PERMISSION_MISSING: confirm which scope is missing (pages_manage_posts) and ask the Page owner to restore the admin role. Not carried out - there is no real Page or owner behind this mock account. _(by scenario-script)_

## Day 3 - 2026-11-25

- Check type: live-clock run · 15 accounts checked · 12 healthy, 0 warning, 3 failing.
- Changes since previous check:
  - **LI-002** raised `TOKEN_EXPIRED` - 401 invalid_token: access token expired and refresh token was not rotated
  - **LI-002** connection connected -> error
  - **TT-002** raised `ACCOUNT_RESTRICTED` - Account flagged by platform integrity checks; API returns account_restricted
  - **TT-002** account status active -> restricted
  - **X-003** cleared `RETRY_RECOVERED`
- Actions recorded ("Simulated:" = runbook response, not carried out):
  - FB-003 - Simulated: Runbook response, next step: once the admin role is restored, reconnect so pages_manage_posts is re-granted. Not carried out - the scenario script clears the anomaly on the next day. _(by scenario-script)_
  - LI-002 - Simulated: Runbook response to TOKEN_EXPIRED: re-authorise to mint a new access token and investigate why the refresh did not run. Not carried out - no real token exists; the scenario script clears the anomaly on the next day. _(by scenario-script)_
  - TT-002 - Simulated: Runbook response to ACCOUNT_RESTRICTED: pause tests that use TT-002 and re-check for 48h before replacing it. Not carried out. _(by scenario-script)_

## Day 4 - 2026-11-26

- Check type: live-clock run · 15 accounts checked · 12 healthy, 1 warning, 2 failing.
- Changes since previous check:
  - **FB-003** cleared `PERMISSION_MISSING`
  - **IG-001** raised `DISCONNECTED` - Session invalidated after a password change on the linked account
  - **IG-001** connection connected -> disconnected
  - **LI-002** cleared `TOKEN_EXPIRED`
  - **LI-002** connection error -> connected
  - **LI-003** raised `TOKEN_EXPIRING_SOON` - Access token reaches end of lifetime in 3 days | token expires in 3 day(s)
- Actions recorded ("Simulated:" = runbook response, not carried out):
  - IG-001 - Simulated: Runbook response to DISCONNECTED: reconnect through the proposed connection workflow. Not carried out - no UI reconnection was performed; the scenario script clears the anomaly on the next day. _(by scenario-script)_
  - LI-003 - Simulated: Runbook response to TOKEN_EXPIRING_SOON: re-authorise before the token expires. Not carried out. _(by scenario-script)_

## Day 5 - 2026-11-27

- Check type: live-clock run · 15 accounts checked · 13 healthy, 0 warning, 2 failing.
- Changes since previous check:
  - **FB-002** raised `ASSET_MISSING` - Page no longer returned by /me/accounts for the connected user | missing asset(s): page:Mock QA Page A
  - **IG-001** cleared `DISCONNECTED`
  - **IG-001** connection disconnected -> connected
  - **LI-003** cleared `TOKEN_EXPIRING_SOON`
- Actions recorded ("Simulated:" = runbook response, not carried out):
  - TT-002 - Simulated: Runbook response when a restriction lasts more than 48h: retire the account with `account retire TT-002` and request a standby TikTok test account. Not carried out. _(by scenario-script)_
  - FB-002 - Simulated: Runbook response to ASSET_MISSING: check whether the Page was unlinked or the connected user lost access. Not carried out; issue left open. _(by scenario-script)_

