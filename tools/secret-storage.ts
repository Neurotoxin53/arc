// macOS Keychain I/O for ArcMod's own OSCrypt secret. The password is never logged.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chromiumKeychainPassword, ownSafeStorage } from "./password-keychain";

export type KeychainLookup =
  | { readonly status: "found"; readonly password: string }
  | { readonly status: "missing" }
  | { readonly status: "denied"; readonly message: string };

// The secret stays in the returned value. Callers must not log it. `security` prints it on stdout
// only when the lookup succeeds; failures are reported from stderr.
export const lookupKeychainPassword = (service: string, account: string): KeychainLookup => {
  const result = Bun.spawnSync(["security", "find-generic-password", "-w", "-s", service, "-a", account], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode === 0) {
    const password = result.stdout.toString().replace(/\n$/, "");
    return password ? { status: "found", password } : { status: "denied", message: "Keychain returned an empty secret" };
  }
  const message = result.stderr.toString().trim();
  if (result.exitCode === 44 || /could not be found/i.test(message)) return { status: "missing" };
  return { status: "denied", message: message || `security exited ${result.exitCode}` };
};

// Creates this app's own safe-storage item when it is missing. Never writes Arc's item.
export const ensureLoginKeychainPassword = (appName: string, trustedExecutables: readonly string[]): string => {
  const names = ownSafeStorage(appName);
  const existing = lookupKeychainPassword(names.service, names.account);
  if (existing.status === "found") return existing.password;
  if (existing.status === "denied") {
    throw new Error(`Couldn't read "${names.service}" (${existing.message}). Choose Allow for that item. If macOS asks for "Arc Safe Storage", choose Deny and stop.`);
  }
  const password = chromiumKeychainPassword(new Uint8Array(randomBytes(16)));
  const args = ["add-generic-password", "-s", names.service, "-a", names.account, "-w", password, "-T", "/usr/bin/security"];
  for (const executable of trustedExecutables) if (existsSync(executable)) args.push("-T", executable);
  const added = Bun.spawnSync(["security", ...args], { stdout: "pipe", stderr: "pipe" });
  if (added.exitCode !== 0) throw new Error(`Couldn't store "${names.service}": ${added.stderr.toString().trim()}`);
  return password;
};
