// Import stock Arc's Chromium profile (logins, site storage, extensions, history,
// permissions) into the everyday ArcMod so sites stay signed in.
//   bun tools/import-arc-data.ts [--staging-only] [--quit-arcmod] [--relaunch [--app <ArcMod.app>]]
// --quit-arcmod asks ArcMod to quit after the checks pass and waits for you to quit Arc, instead of failing
// while either runs; --relaunch reopens ArcMod afterwards, even if the import failed. ArcMod's
// "Import from Arc…" menu item runs it with both in Terminal.
// Arc encrypts secrets with its "Arc Safe Storage" Keychain password. The everyday ArcMod uses its own
// item, "ArcMod Safe Storage", so the copy is re-encrypted. Arc's item is only read, and only long enough
// to decrypt the copy. Test builds keep their data under Chromium's fixed test key, so real sessions are
// never imported into them.
// The source profile is only read. The previous mod profile is kept as a backup.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionIdentity } from "./agent-session";
import { isSqlite, recryptDatabase, recryptJsonText, recrypter } from "./oscrypt";
import { ensureLoginKeychainPassword } from "./secret-storage";

// Transient caches, tab sessions, and Google sync/push identities that belong to stock Arc.
const excluded = new Set([
  "LOCK", "LOG", "LOG.old", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "Sessions", "Session Storage", "Sync Data", "trusted_vault.pb", "passkey_enclave_state", "GCM Store",
]);

const run = (command: string, args: readonly string[]): string => {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
};

const isRunning = (pattern: string): boolean => Bun.spawnSync(["pgrep", "-f", pattern]).exitCode === 0;

const waitUntilClosed = async (pattern: string, message: string): Promise<void> => {
  if (!isRunning(pattern)) return;
  console.log(message);
  while (isRunning(pattern)) await Bun.sleep(500);
};

// Rows that do not decrypt with Arc's key are left as they were. They were never readable under ArcMod's key.
const recryptCopy = (staging: string, sourcePassword: string, targetPassword: string): string[] => {
  const crypto = recrypter(sourcePassword, targetPassword);
  const failed: string[] = [];
  for (const entry of readdirSync(staging)) {
    if (excluded.has(entry)) continue;
    const path = join(staging, entry);
    if (!statSync(path).isFile()) continue;
    if (entry.endsWith("-journal") || entry.endsWith("-wal") || entry.endsWith("-shm")) continue;
    if (entry === "Preferences" || entry === "Secure Preferences") {
      const preferences = recryptJsonText(readFileSync(path, "utf8"), crypto);
      if (preferences.converted > 0) writeFileSync(path, preferences.text);
      console.log(`${entry}: converted=${preferences.converted}`);
      continue;
    }
    if (!isSqlite(path)) continue;
    for (const [column, tally] of recryptDatabase(path, crypto)) {
      const name = `${entry}: ${column}`;
      console.log(`${name} converted=${tally.converted}${tally.unchanged ? ` unchanged=${tally.unchanged}` : ""}`);
      if (tally.unchanged > 0) failed.push(name);
    }
  }
  return failed;
};

const main = async (args: readonly string[]): Promise<void> => {
  const flags = new Set(["--validation", "--staging-only", "--quit-arcmod", "--relaunch"]);
  const unknown = args.filter((arg, index) => !flags.has(arg) && !(arg === "--app" || args[index - 1] === "--app"));
  if (unknown.length > 0) throw new Error(`unrecognized argument: ${unknown.join(" ")}`);
  if (args.includes("--validation")) {
    throw new Error("test builds keep their data under Chromium's fixed test key; import only into the everyday ArcMod");
  }
  const session = sessionIdentity(false);
  const support = join(process.env.HOME ?? "", "Library/Application Support");
  const source = join(support, "Arc/User Data/Default");
  const targetRoot = join(support, session.appName, "User Data");
  const target = join(targetRoot, "Default");
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const staging = join(targetRoot, `Default.import-${stamp}`);

  if (!existsSync(source)) throw new Error(`missing Arc profile: ${source}`);
  if (!existsSync(targetRoot)) throw new Error(`launch ${session.appName} once before importing: ${targetRoot}`);
  const arc = "^/Applications/Arc[.]app/Contents/MacOS/Arc( |$)";
  const mod = `(^|/)${session.appName}[.]app/Contents/MacOS/Arc( |$)`;
  if (args.includes("--quit-arcmod")) {
    if (isRunning(mod)) Bun.spawnSync(["osascript", "-e", `tell application id "${session.bundleId}" to quit`]);
    await waitUntilClosed(mod, `Waiting for ${session.appName} to quit (confirm in ${session.appName} if it asks)…`);
    await waitUntilClosed(arc, "Quit Arc to continue: its profile has to be closed while it's copied.");
  }
  if (isRunning(arc)) throw new Error("quit Arc first so its profile is consistent");
  if (isRunning(mod)) throw new Error(`quit ${session.appName} first`);

  const app = args.includes("--app") ? args[args.indexOf("--app") + 1] : undefined;
  const trusted = app ? [join(app, "Contents/MacOS/Arc")] : [];
  // Arc's Keychain password is only held in memory. Choose "Allow", not "Always Allow". Do not create Arc's item.
  const arcPassword = run("security", ["find-generic-password", "-w", "-s", "Arc Safe Storage", "-a", "Arc"]).replace(/\n$/, "");
  const targetPassword = ensureLoginKeychainPassword(session.appName, trusted);
  console.log(`secret storage: ${session.appName} Safe Storage`);

  run("mkdir", ["-m", "700", staging]);
  const entries = readdirSync(source).filter((entry) => !excluded.has(entry));
  for (const entry of entries) run("cp", ["-cRp", join(source, entry), join(staging, entry)]);

  const failed = recryptCopy(staging, arcPassword, targetPassword);
  if (failed.length > 0) console.warn(`values that did not decrypt were left unchanged: ${failed.join(", ")}`);

  if (args.includes("--staging-only")) {
    console.log(`staged ${staging}`);
    return;
  }
  const backup = join(targetRoot, `Default.pre-import-${stamp}`);
  if (existsSync(target)) renameSync(target, backup);
  renameSync(staging, target);
  console.log(`imported Arc profile into ${target}${existsSync(backup) ? `\nprevious profile kept at ${backup}` : ""}`);
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    await main(args);
  } catch (error) {
    console.error(`\nImport stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    // From the ArcMod menu: reopen ArcMod whether or not the import worked.
    const session = sessionIdentity(false);
    if (args.includes("--relaunch") && !args.includes("--validation") && !isRunning(`(^|/)${session.appName}[.]app/Contents/MacOS/Arc( |$)`)) {
      const app = args.indexOf("--app") >= 0 ? args[args.indexOf("--app") + 1] : undefined;
      const launch = app ? ["--app", app] : [];
      Bun.spawnSync([join(import.meta.dir, "run-mod.sh"), ...launch], { stdout: "inherit", stderr: "inherit" });
    }
  }
}
