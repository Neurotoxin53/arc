// Until 2026-10-25 the everyday ArcMod ran with --use-mock-keychain, so the cookies and passwords it saved
// are encrypted with Chromium's fixed test key, which anything that can read the data folder can undo. It now
// uses its own Keychain item, "ArcMod Safe Storage", and does not read or write Arc's. This moves a data folder's saved secrets over, once,
// with ArcMod closed. ArcMod.dylib won't start Chromium on a data folder without the marker this leaves (Chromium
// deletes saved passwords it can't decrypt) and opens Terminal with this command instead.
//   bun tools/keychain-profile.ts [--discard] [--relaunch [--app <ArcMod.app>]]
// --discard deletes the test-key cookies, passwords and cards instead of moving them (you sign in again).
// The data folder is cloned first and put back if anything fails; the clone is deleted afterwards, since it
// holds the test-key values.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync, writeSync, type Dirent } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { deleteTestKeyRows, isSqlite, recryptDatabase, recryptJsonText, toKeychain } from "./oscrypt";
import { ensureLoginKeychainPassword } from "./secret-storage";

export const MARKER = ".arcmod-keychain";
const BUNDLE_ID = "company.thebrowser.Browser.mod";

// The everyday ArcMod's data folder (named after the unlocalized CFBundleName, so renaming doesn't move it).
export const everydayDataFolder = (): string => join(homedir(), "Library/Application Support/ArcMod");

// ArcMod's own Keychain password. Never creates or reads Arc's "Arc Safe Storage" item.
export const arcModSafeStoragePassword = (): string => ensureLoginKeychainPassword("ArcMod", []);

// Caches and stores Chromium never encrypts with OSCrypt; skipped to keep the walk short.
const skipped = new Set(["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache",
  "Service Worker", "IndexedDB", "File System", "blob_storage", "Extensions", "Local Extension Settings", "Sessions"]);

const entries = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

// Databases that can hold OSCrypt values: a profile's own files, Network/ and nested storage partitions.
const databases = (dir: string, depth = 0): string[] =>
  entries(dir).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return depth < 5 && !skipped.has(entry.name) ? databases(path, depth + 1) : [];
    return entry.isFile() && !/-(journal|wal|shm)$/.test(entry.name) && isSqlite(path) ? [path] : [];
  });

// Every profile folder, including the backups the Arc import keeps next to Default.
const profiles = (userData: string): string[] =>
  entries(userData)
    .filter((entry) => entry.isDirectory() && existsSync(join(userData, entry.name, "Preferences")))
    .map((entry) => join(userData, entry.name));

const writeAtomically = (path: string, text: string): void => {
  const temporary = `${path}.arcmod-${process.pid}`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
};

// Moves (or with discard, deletes) the test-key values in every profile of `userData`.
export const moveProfilesToKeychain = (userData: string, keychainPassword: (() => string) | "discard"): void => {
  const folders = profiles(userData);
  if (keychainPassword === "discard") {
    for (const path of folders.flatMap((folder) => databases(folder))) {
      const deleted = deleteTestKeyRows(path);
      if (deleted > 0) console.log(`  ${path.slice(userData.length + 1)}: ${deleted} deleted`);
    }
    return;
  }
  const crypto = toKeychain(keychainPassword());
  for (const path of folders.flatMap((folder) => databases(folder))) {
    const counts = [...recryptDatabase(path, crypto).values()];
    const converted = counts.reduce((sum, tally) => sum + tally.converted, 0);
    const unchanged = counts.reduce((sum, tally) => sum + tally.unchanged, 0);
    if (converted + unchanged > 0) console.log(`  ${path.slice(userData.length + 1)}: ${converted} moved${unchanged ? `, ${unchanged} already on the Keychain or unreadable` : ""}`);
  }
  for (const path of folders.flatMap((folder) => ["Preferences", "Secure Preferences"].map((file) => join(folder, file)))) {
    if (!existsSync(path)) continue;
    const preferences = recryptJsonText(readFileSync(path, "utf8"), crypto);
    if (preferences.converted > 0) writeAtomically(path, preferences.text);
  }
};

const paths = (dataFolder: string) => {
  const userData = join(dataFolder, "User Data");
  return {
    userData,
    marker: join(userData, MARKER),
    backup: `${userData}.keychain-backup`, // a complete clone of User Data from before the move
    partial: `${userData}.keychain-backup.partial`, // a clone being made
    aside: `${userData}.keychain-aside`, // a half-moved User Data while the backup goes back
    lock: join(dataFolder, "keychain-move.lock"), // ArcMod.dylib waits while this names a live pid
  };
};

// Puts a data folder back into a known state after an interrupted run: a half-made clone is dropped; a backup
// next to a finished move (marker written) is deleted, since it holds the test-key values; a backup next to an
// unfinished move goes back in place.
export const recoverDataFolder = (dataFolder: string): void => {
  const { userData, marker, backup, partial, aside } = paths(dataFolder);
  rmSync(partial, { recursive: true, force: true });
  if (existsSync(backup)) {
    if (existsSync(marker)) rmSync(backup, { recursive: true, force: true });
    else {
      console.log("• putting back the data folder from an interrupted move");
      if (existsSync(userData)) renameSync(userData, aside);
      renameSync(backup, userData);
    }
  }
  if (existsSync(aside)) {
    if (existsSync(userData)) rmSync(aside, { recursive: true, force: true });
    else renameSync(aside, userData);
  }
};

// Moves `dataFolder`'s User Data once, with a clone to fall back on. Call with the lock held.
export const moveDataFolderToKeychain = (dataFolder: string, keychainPassword: (() => string) | "discard"): void => {
  const { userData, marker, backup, partial, aside } = paths(dataFolder);
  recoverDataFolder(dataFolder);
  if (existsSync(marker)) return;
  if (!existsSync(userData)) {
    // Nothing to move: a new data folder starts on the Keychain.
    mkdirSync(userData, { recursive: true, mode: 0o700 });
    writeFileSync(marker, "new data folder\n", { mode: 0o600 });
    return;
  }
  // -c is APFS clonefile (macOS). Fall back to a normal copy where that flag does not exist.
  let clone = Bun.spawnSync(["cp", "-cRp", userData, partial], { stderr: "pipe" });
  if (clone.exitCode !== 0) {
    rmSync(partial, { recursive: true, force: true });
    clone = Bun.spawnSync(["cp", "-Rp", userData, partial], { stderr: "pipe" });
  }
  if (clone.exitCode !== 0) {
    rmSync(partial, { recursive: true, force: true });
    throw new Error(`couldn't back up ${userData}: ${clone.stderr.toString().trim()}`);
  }
  renameSync(partial, backup);
  try {
    moveProfilesToKeychain(userData, keychainPassword);
    writeFileSync(marker, `${new Date().toISOString()}${keychainPassword === "discard" ? " (discarded)" : ""}\n`, { mode: 0o600 });
  } catch (error) {
    renameSync(userData, aside);
    renameSync(backup, userData);
    rmSync(aside, { recursive: true, force: true });
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
};

// One run at a time: the lock file holds this process's pid; a lock whose pid is gone is taken over.
const takeLock = (lock: string): (() => void) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(readFileSync(lock, "utf8").trim());
      const command = alive(holder) ? Bun.spawnSync(["ps", "-o", "comm=", "-p", String(holder)], { stdout: "pipe" }).stdout.toString().trim() : "";
      if (/(^|\/)bun$/.test(command)) throw new Error(`another move is running (pid ${holder})`);
      rmSync(lock, { force: true });
    }
  }
  throw new Error(`couldn't take ${lock}`);
};

const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Chromium's own lock: User Data/SingletonLock links to "<host>-<pid>" while a browser has the folder open.
// Only an ArcMod on this Mac counts; a stale link's pid may belong to anything by now.
const lockHolder = (userData: string): number | undefined => {
  try {
    const target = readlinkSync(join(userData, "SingletonLock"));
    const separator = target.lastIndexOf("-");
    const pid = Number(target.slice(separator + 1));
    if (target.slice(0, separator) !== hostname() || !alive(pid)) return undefined;
    const command = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();
    return command.endsWith("/Contents/MacOS/Arc") ? pid : undefined;
  } catch {
    return undefined;
  }
};

const appRunning = (): boolean => {
  const check = Bun.spawnSync(["osascript", "-e", `application id "${BUNDLE_ID}" is running`], { stdout: "pipe" });
  return !(check.exitCode === 0 && check.stdout.toString().trim() === "false");
};

// Everyday ArcMod copies built before the switch still add --use-mock-keychain and would write test-key values
// into the moved folder.
const olderCopies = (): string[] =>
  [join("/Applications", "ArcMod.app"), join(homedir(), "Applications", "ArcMod.app"), join(import.meta.dir, "..", "build", "ArcMod.app")]
    .filter((app) => existsSync(join(app, "Contents/Info.plist")))
    .filter((app) => Bun.spawnSync(["/usr/libexec/PlistBuddy", "-c", "Print :ArcModKeychain", join(app, "Contents/Info.plist")], { stdout: "pipe", stderr: "pipe" })
      .stdout.toString().trim() !== "true");

const main = async (args: readonly string[]): Promise<void> => {
  const dataFolder = everydayDataFolder();
  const userData = join(dataFolder, "User Data");
  for (let tries = 0; tries < 40 && (appRunning() || lockHolder(userData) !== undefined); tries++) await Bun.sleep(250);
  if (appRunning() || lockHolder(userData) !== undefined) throw new Error("quit ArcMod first");
  const older = olderCopies();
  if (older.length > 0) {
    throw new Error(`delete or rebuild the older ArcMod first; it still uses the test key: ${older.join(", ")}`);
  }
  const release = takeLock(paths(dataFolder).lock);
  try {
    if (existsSync(join(userData, MARKER))) {
      recoverDataFolder(dataFolder);
      console.log("ArcMod's data folder already uses the Keychain.");
      return;
    }
    const discard = args.includes("--discard");
    console.log(discard
      ? "• deleting ArcMod's saved cookies, passwords and cards that use Chromium's test key"
      : "• moving ArcMod's saved cookies and passwords from Chromium's test key to ArcMod's own Keychain item\n  macOS asks to let `security` use \"ArcMod Safe Storage\": choose Allow. If it asks for \"Arc Safe Storage\", choose Deny");
    moveDataFolderToKeychain(dataFolder, discard ? "discard" : arcModSafeStoragePassword);
    console.log("Done: ArcMod now keeps them in \"ArcMod Safe Storage\". When ArcMod opens, allow that item (Always Allow). If macOS asks for \"Arc Safe Storage\", choose Deny.");
  } finally {
    release();
  }
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    await main(args);
    if (args.includes("--relaunch")) {
      const app = args.indexOf("--app") >= 0 ? args[args.indexOf("--app") + 1] : undefined;
      Bun.spawnSync([join(import.meta.dir, "run-mod.sh"), ...(app ? ["--app", app] : [])], { stdout: "inherit", stderr: "inherit" });
    }
  } catch (error) {
    console.error(`\nNot moved: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Your data folder is unchanged. Run `bun tools/keychain-profile.ts` again, or with --discard to sign in again instead.");
    process.exitCode = 1;
  }
}
