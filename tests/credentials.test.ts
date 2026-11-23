import { describe, expect, it } from "vitest";
import { credentialStatus, envVarForRef, resolveSecret } from "../src/credentials.js";

describe("credential references", () => {
  it("maps a reference ID to an environment variable name", () => {
    expect(envVarForRef("CRED-LI-001")).toBe("QA_CRED_LI_001");
    expect(envVarForRef(" vault/x brand.token ")).toBe("QA_CRED_VAULT_X_BRAND_TOKEN");
  });

  it("resolves the secret from the environment only", () => {
    const env = { QA_CRED_LI_001: "s3cret" };
    expect(resolveSecret("CRED-LI-001", env)).toBe("s3cret");
    expect(resolveSecret("CRED-LI-002", env)).toBeUndefined();
  });

  it("reports presence without exposing the value", () => {
    const status = credentialStatus("CRED-LI-001", { QA_CRED_LI_001: "s3cret" });
    expect(status).toEqual({ refId: "CRED-LI-001", envVar: "QA_CRED_LI_001", present: true });
    expect(JSON.stringify(status)).not.toContain("s3cret");
    expect(credentialStatus("CRED-LI-001", { QA_CRED_LI_001: "" }).present).toBe(false);
  });
});
