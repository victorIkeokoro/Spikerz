import type { DB } from "./db.js";
import {
  type Account,
  type AuditAction,
  type AuditEntry,
  type HealthCheckResult,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  CONNECTION_STATUSES,
  PLATFORMS,
} from "./types.js";

interface AccountRow {
  account_id: string;
  platform: string;
  account_type: string;
  environment: string;
  owner: string;
  status: string;
  connection_status: string;
  connected_assets: string;
  permissions: string;
  last_health_check: string | null;
  notes: string;
  credential_ref_id: string;
}

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function rowToAccount(r: AccountRow): Account {
  return {
    account_id: r.account_id,
    platform: r.platform as Account["platform"],
    account_type: r.account_type as Account["account_type"],
    environment: r.environment,
    owner: r.owner,
    status: r.status as Account["status"],
    connection_status: r.connection_status as Account["connection_status"],
    connected_assets: parseList(r.connected_assets),
    permissions: parseList(r.permissions),
    last_health_check: r.last_health_check,
    notes: r.notes,
    credential_ref_id: r.credential_ref_id,
  };
}

export interface AccountFilter {
  platform?: string;
  status?: string;
  connection_status?: string;
  environment?: string;
}

export class ValidationError extends Error {}

function validate(a: Account): void {
  if (!a.account_id) throw new ValidationError("account_id is required");
  if (!PLATFORMS.includes(a.platform)) {
    throw new ValidationError(`invalid platform "${a.platform}" (expected one of ${PLATFORMS.join(", ")})`);
  }
  if (!ACCOUNT_TYPES.includes(a.account_type)) {
    throw new ValidationError(`invalid account_type "${a.account_type}"`);
  }
  if (!ACCOUNT_STATUSES.includes(a.status)) {
    throw new ValidationError(`invalid status "${a.status}"`);
  }
  if (!CONNECTION_STATUSES.includes(a.connection_status)) {
    throw new ValidationError(`invalid connection_status "${a.connection_status}"`);
  }
  if (!a.credential_ref_id) {
    throw new ValidationError(`credential_ref_id is required for ${a.account_id}`);
  }
}

/** Repository + audit layer over the accounts / health_checks / audit_log tables. */
export class Store {
  constructor(private readonly db: DB) {}

  // ----- audit -------------------------------------------------------------

  audit(entry: Omit<AuditEntry, "id" | "at"> & { at?: string }): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (account_id, action, actor, at, detail)
         VALUES (@account_id, @action, @actor, @at, @detail)`
      )
      .run({ ...entry, at: entry.at ?? new Date().toISOString() });
  }

  auditTrail(accountId?: string): AuditEntry[] {
    const rows = accountId
      ? this.db.prepare(`SELECT * FROM audit_log WHERE account_id = ? ORDER BY id`).all(accountId)
      : this.db.prepare(`SELECT * FROM audit_log ORDER BY id`).all();
    return rows as AuditEntry[];
  }

  // ----- accounts CRUD -----------------------------------------------------

  upsert(account: Account, actor = "system", detail?: string): { created: boolean } {
    validate(account);
    const existing = this.get(account.account_id);
    this.db
      .prepare(
        `INSERT INTO accounts
          (account_id, platform, account_type, environment, owner, status,
           connection_status, connected_assets, permissions, last_health_check,
           notes, credential_ref_id)
         VALUES
          (@account_id, @platform, @account_type, @environment, @owner, @status,
           @connection_status, @connected_assets, @permissions, @last_health_check,
           @notes, @credential_ref_id)
         ON CONFLICT(account_id) DO UPDATE SET
           platform=excluded.platform,
           account_type=excluded.account_type,
           environment=excluded.environment,
           owner=excluded.owner,
           status=excluded.status,
           connection_status=excluded.connection_status,
           connected_assets=excluded.connected_assets,
           permissions=excluded.permissions,
           last_health_check=excluded.last_health_check,
           notes=excluded.notes,
           credential_ref_id=excluded.credential_ref_id`
      )
      .run({
        ...account,
        connected_assets: JSON.stringify(account.connected_assets),
        permissions: JSON.stringify(account.permissions),
      });
    this.audit({
      account_id: account.account_id,
      action: existing ? "update" : "create",
      actor,
      detail: detail ?? (existing ? "account updated" : "account created"),
    });
    return { created: !existing };
  }

  /** Partial update; throws if the account does not exist. */
  update(accountId: string, patch: Partial<Account>, actor = "system"): Account {
    const current = this.get(accountId);
    if (!current) throw new ValidationError(`account ${accountId} not found`);
    const next: Account = { ...current, ...patch, account_id: accountId };
    const changed = (Object.keys(patch) as Array<keyof Account>)
      .filter((k) => k !== "account_id")
      .filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]))
      .map((k) => `${k}: ${JSON.stringify(current[k])} -> ${JSON.stringify(next[k])}`);
    this.upsert(next, actor, `fields changed: ${changed.join("; ") || "none"}`);
    return next;
  }

  get(accountId: string): Account | undefined {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE account_id = ?`).get(accountId) as
      | AccountRow
      | undefined;
    return row ? rowToAccount(row) : undefined;
  }

  list(filter: AccountFilter = {}): Account[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    for (const key of ["platform", "status", "connection_status", "environment"] as const) {
      const val = filter[key];
      if (val) {
        clauses.push(`${key} = @${key}`);
        params[key] = val;
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM accounts ${where} ORDER BY platform, account_id`)
      .all(params) as AccountRow[];
    return rows.map(rowToAccount);
  }

  delete(accountId: string, actor = "system"): boolean {
    const info = this.db.prepare(`DELETE FROM accounts WHERE account_id = ?`).run(accountId);
    if (info.changes > 0) {
      this.audit({ account_id: accountId, action: "delete", actor, detail: "account deleted" });
      return true;
    }
    return false;
  }

  /** Soft-retire an account (keeps the record and its history). */
  retire(accountId: string, actor = "system"): Account {
    const next = this.update(
      accountId,
      { status: "retired", connection_status: "disconnected" },
      actor
    );
    this.audit({ account_id: accountId, action: "retire", actor, detail: "account retired" });
    return next;
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) c FROM accounts`).get() as { c: number }).c;
  }

  reset(): void {
    this.db.exec(`DELETE FROM accounts; DELETE FROM health_checks; DELETE FROM audit_log;`);
  }

  // ----- health checks -----------------------------------------------------

  saveHealthCheck(r: HealthCheckResult, actor = "healthcheck"): void {
    this.db
      .prepare(
        `INSERT INTO health_checks
          (account_id, checked_at, check_day, account_status, connection_status,
           token_valid, token_expires_at, connected_assets, permissions, healthy,
           anomalies, message, attempts, latency_ms, run_mode)
         VALUES
          (@account_id, @checked_at, @check_day, @account_status, @connection_status,
           @token_valid, @token_expires_at, @connected_assets, @permissions, @healthy,
           @anomalies, @message, @attempts, @latency_ms, @run_mode)
         ON CONFLICT(account_id, check_day) DO UPDATE SET
           checked_at=excluded.checked_at,
           account_status=excluded.account_status,
           connection_status=excluded.connection_status,
           token_valid=excluded.token_valid,
           token_expires_at=excluded.token_expires_at,
           connected_assets=excluded.connected_assets,
           permissions=excluded.permissions,
           healthy=excluded.healthy,
           anomalies=excluded.anomalies,
           message=excluded.message,
           attempts=excluded.attempts,
           latency_ms=excluded.latency_ms,
           run_mode=excluded.run_mode`
      )
      .run({
        account_id: r.account_id,
        checked_at: r.checked_at,
        check_day: r.check_day,
        account_status: r.account_status,
        connection_status: r.connection_status,
        token_valid: r.token_valid === null ? null : r.token_valid ? 1 : 0,
        token_expires_at: r.token_expires_at,
        connected_assets: JSON.stringify(r.connected_assets),
        permissions: JSON.stringify(r.permissions),
        healthy: r.healthy ? 1 : 0,
        anomalies: JSON.stringify(r.anomalies),
        message: r.message,
        attempts: r.attempts,
        latency_ms: r.latency_ms,
        run_mode: r.run_mode,
      });

    // Reflect the latest observed state back onto the account record
    // (skipped when a later day has already been recorded, e.g. on a re-run).
    // connected_assets / permissions on the account are the EXPECTED baseline
    // and are deliberately not overwritten: drift is detected by comparing the
    // observed values in each health check against that baseline.
    this.db
      .prepare(
        `UPDATE accounts
           SET last_health_check = @checked_at,
               status = @account_status,
               connection_status = @connection_status
         WHERE account_id = @account_id
           AND NOT EXISTS (
             SELECT 1 FROM health_checks
              WHERE account_id = @account_id AND check_day > @check_day
           )`
      )
      .run({
        account_id: r.account_id,
        check_day: r.check_day,
        checked_at: r.checked_at,
        account_status: r.account_status,
        connection_status: r.connection_status,
      });

    this.audit({
      account_id: r.account_id,
      action: "health_check",
      actor,
      at: r.checked_at,
      detail: r.healthy ? "healthy" : `anomalies: ${r.anomalies.join(", ")}`,
    });
  }

  healthChecks(filter: { accountId?: string; day?: string } = {}): HealthCheckResult[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter.accountId) {
      clauses.push("account_id = @accountId");
      params.accountId = filter.accountId;
    }
    if (filter.day) {
      clauses.push("check_day = @day");
      params.day = filter.day;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM health_checks ${where} ORDER BY check_day, account_id`)
      .all(params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as number,
      account_id: row.account_id as string,
      checked_at: row.checked_at as string,
      check_day: row.check_day as string,
      account_status: row.account_status as HealthCheckResult["account_status"],
      connection_status: row.connection_status as HealthCheckResult["connection_status"],
      token_valid: row.token_valid === null ? null : row.token_valid === 1,
      token_expires_at: (row.token_expires_at as string | null) ?? null,
      connected_assets: parseList(row.connected_assets as string),
      permissions: parseList(row.permissions as string),
      healthy: row.healthy === 1,
      anomalies: parseList(row.anomalies as string),
      message: row.message as string,
      attempts: row.attempts as number,
      latency_ms: row.latency_ms as number,
      run_mode: row.run_mode as HealthCheckResult["run_mode"],
    }));
  }

  /** Distinct calendar days that have at least one health check, ascending. */
  checkDays(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT check_day FROM health_checks ORDER BY check_day`)
      .all() as Array<{ check_day: string }>;
    return rows.map((r) => r.check_day);
  }

  logAction(
    accountId: string,
    action: AuditAction,
    actor: string,
    detail: string,
    at?: string
  ): void {
    this.audit({ account_id: accountId, action, actor, detail, at });
  }
}
