import { describe, expect, it } from "vitest";
import { approvalPath, isWellFormedToken, newApprovalToken, normalizePhone } from "./crypto";

describe("approval tokens", () => {
  it("are 32 random bytes as base64url: 43 URL-safe characters, never repeated", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const token = newApprovalToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(isWellFormedToken(token)).toBe(true);
      tokens.add(token);
    }
    expect(tokens.size).toBe(200);
  });

  it("anything else isn't a token", () => {
    for (const bad of ["", "abc", `${newApprovalToken()}x`, newApprovalToken().slice(1), `${"a".repeat(42)}=`, `${"a".repeat(42)}/`]) {
      expect(isWellFormedToken(bad)).toBe(false);
    }
  });

  it("go in the approval page's path", () => {
    const token = newApprovalToken();
    expect(approvalPath(token)).toBe(`/approve/${token}`);
  });
});

describe("phone numbers", () => {
  it.each([
    ["+14015550123", "+14015550123"],
    ["+1 (401) 555-0123", "+14015550123"],
    ["+1.401.555.0123", "+14015550123"],
    [" +44 20 7946 0958 ", "+442079460958"],
  ])("normalizes %j to E.164 %j", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["4015550123", "+04015550123", "+1234567", "+1234567890123456", "+1 401 555 012x", "", "++14015550123"])(
    "rejects %j",
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );
});
