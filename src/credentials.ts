/**
 * Credential resolution.
 *
 * The inventory and database store ONLY a credential-reference ID
 * (e.g. "CRED-LI-001"). The actual secret never touches the database or the
 * repo. It is resolved at runtime from an environment variable:
 *
 *     QA_CRED_<NORMALIZED_REF_ID>
 *
 * where NORMALIZED_REF_ID uppercases the ref, replaces every run of
 * non-alphanumeric characters with a single underscore and drops a leading
 * "CRED_" (so "CRED-LI-001" resolves from QA_CRED_LI_001).
 *
 * In CI/production the same env var is injected from a secrets manager
 * (GitHub Actions encrypted secrets, Vault, AWS/GCP Secrets Manager, ...).
 */

export function envVarForRef(refId: string): string {
  const normalized = refId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^CRED_/, "");
  return `QA_CRED_${normalized}`;
}

export interface CredentialStatus {
  refId: string;
  envVar: string;
  present: boolean;
}

/** Report whether each credential reference has a secret available — without revealing it. */
export function credentialStatus(
  refId: string,
  env: NodeJS.ProcessEnv = process.env
): CredentialStatus {
  const envVar = envVarForRef(refId);
  const val = env[envVar];
  return { refId, envVar, present: typeof val === "string" && val.length > 0 };
}

/**
 * Resolve the actual secret for a reference. Returns undefined when not set.
 * Callers must treat the result as sensitive and never log it.
 */
export function resolveSecret(
  refId: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const val = env[envVarForRef(refId)];
  return val && val.length > 0 ? val : undefined;
}
