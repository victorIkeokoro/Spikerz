import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { Store } from "./store.js";
import type { Account } from "./types.js";

/**
 * Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF).
 * Kept dependency-free on purpose: the inventory format is small and fixed.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** Lists inside a CSV cell are separated by ";" or "|". */
function splitList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v !== "string") return [];
  return v
    .split(/[;|]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Reject secret-like fields across snake_case, kebab-case and camelCase naming. */
const FORBIDDEN_FIELD_PATTERN =
  /password|passwd|passphrase|pwd|token|secret|cookie|apikey|privatekey|session|bearer|otp|mfa|2fa/;

/**
 * The only columns an inventory may contain. Anything else is rejected rather
 * than silently dropped: the allowlist is the actual safeguard, the pattern
 * above exists to give a clearer error for the obvious cases.
 */
const KNOWN_FIELDS = new Set([
  "account_id",
  "platform",
  "account_type",
  "environment",
  "owner",
  "status",
  "connection_status",
  "connected_assets",
  "permissions",
  "last_health_check",
  "notes",
  "credential_ref_id",
]);

export function recordToAccount(rec: Record<string, unknown>, defaultEnv = "qa"): Account {
  for (const key of Object.keys(rec)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_FIELD_PATTERN.test(normalizedKey)) {
      throw new Error(
        `inventory contains a "${key}" field. Secrets must not be stored in the inventory - ` +
          `use credential_ref_id and supply the secret through the environment.`
      );
    }
  }
  const unknown = Object.keys(rec)
    .map((k) => k.trim())
    .filter((k) => k !== "" && !KNOWN_FIELDS.has(k));
  if (unknown.length) {
    throw new Error(`inventory contains unknown field(s): ${unknown.join(", ")}`);
  }
  const str = (k: string, fallback = ""): string => {
    const v = rec[k];
    return v === undefined || v === null ? fallback : String(v).trim();
  };
  return {
    account_id: str("account_id"),
    platform: str("platform") as Account["platform"],
    account_type: str("account_type", "profile") as Account["account_type"],
    environment: str("environment", defaultEnv),
    owner: str("owner", "qa-team"),
    status: str("status", "active") as Account["status"],
    connection_status: str("connection_status", "pending") as Account["connection_status"],
    connected_assets: splitList(rec["connected_assets"]),
    permissions: splitList(rec["permissions"]),
    last_health_check: str("last_health_check") || null,
    notes: str("notes"),
    credential_ref_id: str("credential_ref_id"),
  };
}

export function parseInventory(text: string, format: "csv" | "json"): Account[] {
  if (format === "json") {
    const data = JSON.parse(text) as unknown;
    const list = Array.isArray(data) ? data : (data as { accounts?: unknown[] }).accounts;
    if (!Array.isArray(list)) throw new Error("JSON inventory must be an array or { accounts: [...] }");
    return list.map((r) => recordToAccount(r as Record<string, unknown>));
  }
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return rows.slice(1).map((cols) => {
    const rec: Record<string, unknown> = {};
    keys.forEach((k, i) => (rec[k] = cols[i] ?? ""));
    return recordToAccount(rec);
  });
}

export interface ImportSummary {
  created: number;
  updated: number;
  failed: Array<{ account_id: string; error: string }>;
}

export function importAccounts(store: Store, accounts: Account[], actor = "import"): ImportSummary {
  const summary: ImportSummary = { created: 0, updated: 0, failed: [] };
  for (const a of accounts) {
    try {
      const { created } = store.upsert(a, actor, "imported from inventory file");
      if (created) summary.created++;
      else summary.updated++;
    } catch (err) {
      summary.failed.push({ account_id: a.account_id || "(missing id)", error: (err as Error).message });
    }
  }
  return summary;
}

export function importFile(store: Store, file: string, actor = "import"): ImportSummary {
  const ext = extname(file).toLowerCase();
  if (ext !== ".csv" && ext !== ".json") throw new Error(`unsupported inventory format "${ext}" (use .csv or .json)`);
  const accounts = parseInventory(readFileSync(file, "utf8"), ext === ".csv" ? "csv" : "json");
  return importAccounts(store, accounts, actor);
}

const CSV_COLUMNS: Array<keyof Account> = [
  "account_id",
  "platform",
  "account_type",
  "environment",
  "owner",
  "status",
  "connection_status",
  "connected_assets",
  "permissions",
  "last_health_check",
  "notes",
  "credential_ref_id",
];

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function accountsToCsv(accounts: Account[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const a of accounts) {
    lines.push(
      CSV_COLUMNS.map((c) => {
        const v = a[c];
        return csvEscape(Array.isArray(v) ? v.join(";") : v);
      }).join(",")
    );
  }
  return lines.join("\n") + "\n";
}
