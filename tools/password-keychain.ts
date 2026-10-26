// Login-keychain names, iCloud Passwords manifest, and signing checks for ArcMod.
// Pure decisions live here so tests can run on Linux. macOS I/O is in secret-storage.ts
// and icloud-passwords.ts. The native rewriter in mods/passwords/ follows the same rules.

export const OSCRYPT_MOCK_PASSWORD = "mock_password";
export const SECRET_STORAGE_DEFAULTS_KEY = "ArcModSecretStorage";
export const SECRET_STORAGE_MARKER = "ArcModSecretStorage";
export const PASSKEY_ENTITLEMENT = "com.apple.developer.web-browser.public-key-credential";
export const PASSWORD_MANAGER_HOST = "com.apple.passwordmanager";
// Apple's helper on macOS Sonoma and later. A parent-launch constraint (macOS 15.4+) only
// lets an allowlisted browser, or a browser with the passkey entitlement, spawn it.
export const PASSWORD_MANAGER_HELPER =
  "/System/Cryptexes/App/System/Library/CoreServices/PasswordManagerBrowserExtensionHelper.app/Contents/MacOS/PasswordManagerBrowserExtensionHelper";
// Chrome Web Store ids Apple's own native-messaging manifest allows.
export const ICLOUD_PASSWORDS_EXTENSIONS = ["pejdijmoenmkgeppbflobdenhhabjlaj", "mfbcdcnpokpoajjciilocoachedjkima"] as const;
export const ICLOUD_PASSWORDS_STORE_URL = `https://chromewebstore.google.com/detail/${ICLOUD_PASSWORDS_EXTENSIONS[0]}`;
// Stock Arc is on Apple's helper allowlist. ArcMod's bundle id and ad hoc signature are not.
export const ARC_ALLOWLISTED_BUNDLE = "company.thebrowser.Browser";
export const ARC_ALLOWLISTED_TEAM = "S6N382Y83G";

// Chromium looks these up for the OSCrypt key. ArcMod rewrites only an exact pair, onto its
// own item, so a login-keychain build never reads Arc's, Chrome's, or Chromium's secret.
export const BROWSER_SAFE_STORAGE_PAIRS = [
  ["Arc Safe Storage", "Arc"],
  ["Chrome Safe Storage", "Chrome"],
  ["Chromium Safe Storage", "Chromium"],
] as const;

export type SecretStorage = "login" | "mock";
export type BundleKind = "user" | "agent";

export interface SecretStorageInput {
  readonly preference: string | undefined;
  readonly marker: string | undefined;
  readonly profileExists: boolean;
  readonly kind: BundleKind;
}

export interface SecretStorageDecision {
  readonly mode: SecretStorage;
  readonly writePreference: boolean;
  readonly writeMarker: boolean;
}

const knownMode = (value: string | undefined): SecretStorage | undefined =>
  value === "login" || value === "mock" ? value : undefined;

// Agents stay on the mock key so a background browser never prompts for the login keychain.
// A profile marker wins over the preference: migration writes the marker in the same swap as
// the re-encrypted files, and a crash before `defaults write` must still open with that key.
export const resolveSecretStorage = (input: SecretStorageInput): SecretStorageDecision => {
  if (input.kind === "agent") return { mode: "mock", writePreference: false, writeMarker: false };
  const marker = knownMode(input.marker);
  const preference = knownMode(input.preference);
  const mode = marker ?? preference ?? (input.profileExists ? "mock" : "login");
  return {
    mode,
    writePreference: preference !== mode,
    writeMarker: input.profileExists && marker !== mode,
  };
};

// "<AppName> Safe Storage" / "<AppName>", matching Chromium's service/account shape.
// Never the stock Arc, Chrome, or Chromium names: those items belong to the other browsers.
export const ownSafeStorage = (appName: string): { readonly service: string; readonly account: string } => {
  if (appName === "Arc" || appName === "Chrome" || appName === "Chromium") {
    throw new Error(`refusing to use ${appName}'s safe-storage keychain item`);
  }
  if (!/^[\w .+-]+$/.test(appName)) throw new Error(`unsupported app name: ${appName}`);
  return { service: `${appName} Safe Storage`, account: appName };
};

// Chromium stores 16 random bytes, standard base64 with padding, as the generic-password secret.
export const chromiumKeychainPassword = (bytes: Uint8Array): string => {
  if (bytes.byteLength !== 16) throw new Error("Chromium's macOS keychain secret is 16 random bytes");
  return Buffer.from(bytes).toString("base64");
};

export const migrationKeys = (
  from: SecretStorage,
  to: SecretStorage,
  loginPassword: string | undefined,
): { readonly source: string; readonly target: string } | "noop" | "need-login-key" => {
  if (from === to) return "noop";
  if (!loginPassword) return "need-login-key";
  if (to === "login") return { source: OSCRYPT_MOCK_PASSWORD, target: loginPassword };
  return { source: loginPassword, target: OSCRYPT_MOCK_PASSWORD };
};

const cString = (value: string): string => {
  if (!/^[\x20-\x7e]+$/.test(value) || value.includes("\\") || value.includes("\"")) throw new Error(`unsafe keychain name: ${value}`);
  return `"${value}"`;
};

export const keychainRewriteHeader = `// Generated from tools/password-keychain.ts. Do not edit.
#include <stddef.h>
typedef struct { const char *service; const char *account; } ArcModSafeStoragePair;
static const ArcModSafeStoragePair kArcModSafeStoragePairs[] = {
${BROWSER_SAFE_STORAGE_PAIRS.map(([service, account]) => `  {${cString(service)}, ${cString(account)}},`).join("\n")}
};
static const size_t kArcModSafeStoragePairCount = sizeof kArcModSafeStoragePairs / sizeof kArcModSafeStoragePairs[0];
`;

export const signingPlanError = (plan: { readonly signIdentity: string; readonly hardenedRuntime: boolean }): string | undefined => {
  if (plan.hardenedRuntime && plan.signIdentity === "-") {
    return "--hardened-runtime needs --sign-identity. An ad hoc signature has no team id, so the hardened runtime rejects ArcMod.dylib.";
  }
  return undefined;
};

export const passkeyEntitlementWarning = (signIdentity: string, entitlements: string): string | undefined => {
  if (!entitlements.includes(PASSKEY_ENTITLEMENT)) return undefined;
  const who = signIdentity === "-" ? "ad hoc" : signIdentity;
  return `This signature (${who}) embeds ${PASSKEY_ENTITLEMENT}. macOS honors that entitlement only for a Developer ID whose App ID Apple has approved, with the hardened runtime. On any other signature Chromium treats iCloud Keychain passkeys as available and the ceremony fails, including phone and security-key fallbacks. Use resources/ArcMod.passkeys.entitlements.plist only after Apple has approved the capability.`;
};

export interface NativeMessagingManifest {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: "stdio";
  readonly allowed_origins: readonly string[];
}

export const icloudPasswordsManifest = (): NativeMessagingManifest => ({
  name: PASSWORD_MANAGER_HOST,
  description: "PasswordManagerBrowserExtensionHelper",
  path: PASSWORD_MANAGER_HELPER,
  type: "stdio",
  allowed_origins: ICLOUD_PASSWORDS_EXTENSIONS.map((id) => `chrome-extension://${id}/`),
});

export const nativeMessagingManifestPaths = (supportRoot: string): readonly string[] => [
  `${supportRoot}/NativeMessagingHosts/${PASSWORD_MANAGER_HOST}.json`,
  `${supportRoot}/User Data/NativeMessagingHosts/${PASSWORD_MANAGER_HOST}.json`,
];

export const arcModSupportRoot = (home: string, appName: string): string => {
  if (appName === "Arc" || appName === "Arc.app") throw new Error("refusing to write into Arc's data folder");
  return `${home}/Library/Application Support/${appName}`;
};

export interface ApplePasswordsFacts {
  readonly helperInstalled: boolean;
  readonly signature: "adhoc" | "developer-id" | "other";
  readonly teamId: string | undefined;
  readonly passkeyEntitlement: boolean;
  readonly hardenedRuntime: boolean;
  readonly manifestPaths: readonly { readonly path: string; readonly installed: boolean }[];
}

export const classifyCodesign = (
  verbose: string,
  entitlements: string,
): Pick<ApplePasswordsFacts, "signature" | "teamId" | "passkeyEntitlement" | "hardenedRuntime"> => {
  const teamRaw = /TeamIdentifier=(\S+)/.exec(verbose)?.[1];
  const teamId = teamRaw && teamRaw !== "not" ? teamRaw : undefined;
  const signature = /Signature=adhoc/.test(verbose) ? "adhoc"
    : /Authority=Developer ID Application:/.test(verbose) ? "developer-id"
    : "other";
  return {
    signature,
    teamId,
    passkeyEntitlement: entitlements.includes(PASSKEY_ENTITLEMENT),
    hardenedRuntime: /flags=[^(]*\([^)]*runtime/.test(verbose),
  };
};

// "confirm" means the signature has the shape Apple can authorize. It does not mean Apple
// has approved this team. "blocked" is the expected result for a self-signed ArcMod.
export const applePasswordsReport = (facts: ApplePasswordsFacts): { readonly status: "blocked" | "confirm"; readonly lines: readonly string[] } => {
  const lines = [
    "iCloud Passwords and iCloud Keychain passkeys use Apple's PasswordManagerBrowserExtensionHelper and AuthenticationServices.",
    `Apple's helper allowlist includes ${ARC_ALLOWLISTED_BUNDLE} (${ARC_ALLOWLISTED_TEAM}). ArcMod's bundle id is different, and a self-signed or ad hoc build has no team id, so the helper is killed on macOS 15.4 and later.`,
    `The other way in is ${PASSKEY_ENTITLEMENT} on a hardened Developer ID signature after Apple has approved that App ID. Copying the key into an ad hoc signature does not enable it.`,
    "The everyday ArcMod stores its own cookies and saved passwords in the login keychain without that entitlement, under \"ArcMod Safe Storage\". That item is not Arc's.",
    "Security keys, a phone QR code, and password-manager extensions keep working without the entitlement.",
  ];
  if (!facts.helperInstalled) lines.push(`Helper missing: ${PASSWORD_MANAGER_HELPER}`);
  lines.push(`Signature: ${facts.signature}${facts.teamId ? ` team ${facts.teamId}` : " (no team id)"}; hardened runtime: ${facts.hardenedRuntime ? "yes" : "no"}; passkey entitlement embedded: ${facts.passkeyEntitlement ? "yes" : "no"}.`);
  if (facts.passkeyEntitlement && (facts.signature !== "developer-id" || !facts.hardenedRuntime)) {
    lines.push("The passkey entitlement is embedded on a signature macOS will not honor. Remove it so Chromium keeps the phone and security-key paths.");
  }
  for (const item of facts.manifestPaths) lines.push(`${item.installed ? "manifest" : "missing manifest"}: ${item.path}`);
  if (facts.manifestPaths.some((item) => !item.installed)) lines.push("Install the manifest with: bun tools/icloud-passwords.ts --install");
  lines.push(`Extension: ${ICLOUD_PASSWORDS_STORE_URL}`);
  const ready = facts.helperInstalled && facts.signature === "developer-id" && facts.teamId !== undefined && facts.passkeyEntitlement && facts.hardenedRuntime;
  lines.push(ready
    ? "Status: confirm. The signature has the shape Apple can authorize. Try a saved iCloud password and a passkey on a real site; this report cannot see whether Apple approved the capability."
    : "Status: blocked. This build cannot fill or save iCloud Keychain passwords, and cannot use iCloud Keychain passkeys.");
  return { status: ready ? "confirm" : "blocked", lines };
};
