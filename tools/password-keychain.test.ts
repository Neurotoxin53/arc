import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applePasswordsReport, arcModSupportRoot, BROWSER_SAFE_STORAGE_PAIRS, chromiumKeychainPassword, classifyCodesign,
  ICLOUD_PASSWORDS_EXTENSIONS, icloudPasswordsManifest, keychainRewriteHeader, migrationKeys, OSCRYPT_MOCK_PASSWORD,
  ownSafeStorage, PASSKEY_ENTITLEMENT, passkeyEntitlementWarning, resolveSecretStorage, signingPlanError,
} from "./password-keychain";
import { installIcloudPasswordsManifest } from "./icloud-passwords";

const user = { preference: undefined, marker: undefined, profileExists: false, kind: "user" as const };

test("new profiles use the login keychain and existing ones stay on the mock key", () => {
  expect(resolveSecretStorage(user)).toEqual({ mode: "login", writePreference: true, writeMarker: false });
  expect(resolveSecretStorage({ ...user, profileExists: true })).toEqual({ mode: "mock", writePreference: true, writeMarker: true });
  expect(resolveSecretStorage({ ...user, preference: "mock", profileExists: false })).toMatchObject({ mode: "mock", writePreference: false });
  expect(resolveSecretStorage({ ...user, preference: "login", marker: "mock", profileExists: true })).toEqual({
    mode: "mock", writePreference: true, writeMarker: false,
  });
  expect(resolveSecretStorage({ ...user, marker: "login", preference: "login", profileExists: true })).toEqual({
    mode: "login", writePreference: false, writeMarker: false,
  });
});

test("agent sessions never touch the login keychain", () => {
  expect(resolveSecretStorage({ preference: "login", marker: "login", profileExists: false, kind: "agent" })).toEqual({
    mode: "mock", writePreference: false, writeMarker: false,
  });
});

test("safe-storage names are per app and never Arc's, Chrome's, or Chromium's", () => {
  expect(ownSafeStorage("ArcMod")).toEqual({ service: "ArcMod Safe Storage", account: "ArcMod" });
  expect(ownSafeStorage("ArcModValidation").service).toBe("ArcModValidation Safe Storage");
  expect(ownSafeStorage("ArcModAgent-scout").account).toBe("ArcModAgent-scout");
  for (const name of ["Arc", "Chrome", "Chromium", "../Arc", ""]) expect(() => ownSafeStorage(name)).toThrow();
  expect(BROWSER_SAFE_STORAGE_PAIRS.map(([service]) => service)).toEqual(["Arc Safe Storage", "Chrome Safe Storage", "Chromium Safe Storage"]);
});

test("Chromium's keychain secret is standard base64 of 16 bytes", () => {
  const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
  const password = chromiumKeychainPassword(bytes);
  expect(password).toBe(Buffer.from(bytes).toString("base64"));
  expect(Buffer.from(password, "base64")).toEqual(Buffer.from(bytes));
  expect(() => chromiumKeychainPassword(new Uint8Array(15))).toThrow();
  expect(OSCRYPT_MOCK_PASSWORD).toBe("mock_password");
});

test("migration names the source and target keys", () => {
  expect(migrationKeys("mock", "mock", "login-key")).toBe("noop");
  expect(migrationKeys("mock", "login", undefined)).toBe("need-login-key");
  expect(migrationKeys("mock", "login", "login-key")).toEqual({ source: "mock_password", target: "login-key" });
  expect(migrationKeys("login", "mock", "login-key")).toEqual({ source: "login-key", target: "mock_password" });
});

test("generated rewriter lists only the three browser pairs", () => {
  for (const [service, account] of BROWSER_SAFE_STORAGE_PAIRS) {
    expect(keychainRewriteHeader).toContain(`{"${service}", "${account}"}`);
  }
  expect(keychainRewriteHeader).not.toContain("ArcMod Safe Storage");
});

test("native rewriter is everyday-only and uses this app's safe-storage name", () => {
  const source = readFileSync(join(import.meta.dir, "../mods/passwords/KeychainIsolation.m"), "utf8");
  expect(source).toContain('@"company.thebrowser.Browser.mod"');
  expect(source).toContain('stringByAppendingString:@" Safe Storage"');
  expect(source).not.toContain("ArcModSecretStorage");
});

test("hardened runtime cannot be ad hoc, and the passkey entitlement warns on every signature", () => {
  expect(signingPlanError({ signIdentity: "-", hardenedRuntime: true })).toContain("--sign-identity");
  expect(signingPlanError({ signIdentity: "ArcMod Local", hardenedRuntime: true })).toBeUndefined();
  expect(passkeyEntitlementWarning("-", "com.apple.security.cs.disable-library-validation")).toBeUndefined();
  expect(passkeyEntitlementWarning("-", PASSKEY_ENTITLEMENT)).toContain("ad hoc");
  expect(passkeyEntitlementWarning("Developer ID Application: Example", PASSKEY_ENTITLEMENT)).toContain("approved");
  const hardened = readFileSync(join(import.meta.dir, "../resources/ArcMod.hardened.entitlements.plist"), "utf8");
  const passkeys = readFileSync(join(import.meta.dir, "../resources/ArcMod.passkeys.entitlements.plist"), "utf8");
  expect(hardened).not.toContain(PASSKEY_ENTITLEMENT);
  expect(passkeys).toContain(PASSKEY_ENTITLEMENT);
  expect(passkeys).toContain("com.apple.security.cs.disable-library-validation");
});

test("iCloud Passwords manifest points at Apple's helper and only ArcMod's folder", () => {
  const manifest = icloudPasswordsManifest();
  expect(manifest.path).toContain("PasswordManagerBrowserExtensionHelper");
  expect(manifest.allowed_origins).toEqual(ICLOUD_PASSWORDS_EXTENSIONS.map((id) => `chrome-extension://${id}/`));
  expect(() => arcModSupportRoot("/Users/samuel", "Arc")).toThrow(/Arc's data folder/);
  const root = mkdtempSync(join(tmpdir(), "arcmod-passwords-"));
  try {
    const support = arcModSupportRoot(root, "ArcMod");
    const written = installIcloudPasswordsManifest(support);
    expect(written).toHaveLength(2);
    expect(written.every((path) => path.includes("/ArcMod/") && !path.includes("/Arc/"))).toBe(true);
    expect(JSON.parse(readFileSync(written[0] ?? "", "utf8"))).toEqual(manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a self-signed build is blocked from iCloud Keychain; a hardened Developer ID is only ready to confirm", () => {
  const adhoc = classifyCodesign("Signature=adhoc\nTeamIdentifier=not set\n", "");
  expect(adhoc).toEqual({ signature: "adhoc", teamId: undefined, passkeyEntitlement: false, hardenedRuntime: false });
  const developer = classifyCodesign(
    "Authority=Developer ID Application: Example (TEAM123456)\nTeamIdentifier=TEAM123456\nflags=0x10000(runtime)\n",
    PASSKEY_ENTITLEMENT,
  );
  expect(developer.signature).toBe("developer-id");
  expect(developer.hardenedRuntime).toBe(true);
  const blocked = applePasswordsReport({
    ...adhoc, helperInstalled: true, manifestPaths: [{ path: "/tmp/com.apple.passwordmanager.json", installed: true }],
  });
  expect(blocked.status).toBe("blocked");
  expect(blocked.lines.join("\n")).toContain("company.thebrowser.Browser");
  expect(blocked.lines.join("\n")).toContain("login keychain");
  const confirm = applePasswordsReport({
    ...developer, helperInstalled: true, manifestPaths: [{ path: "/tmp/com.apple.passwordmanager.json", installed: true }],
  });
  expect(confirm.status).toBe("confirm");
  expect(confirm.lines.join("\n")).toContain("cannot see whether Apple approved");
  const embedded = applePasswordsReport({
    signature: "adhoc", teamId: undefined, passkeyEntitlement: true, hardenedRuntime: false, helperInstalled: true,
    manifestPaths: [],
  });
  expect(embedded.status).toBe("blocked");
  expect(embedded.lines.join("\n")).toContain("Remove it");
});
