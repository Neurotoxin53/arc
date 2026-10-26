// Installs Apple's iCloud Passwords native-messaging manifest into ArcMod's data folder
// and reports whether this signature can actually talk to it.
//   bun tools/icloud-passwords.ts [--install] [--doctor] [--open-store] [--validation] [--app <ArcMod.app>]
// A self-signed ArcMod is expected to be "blocked". The manifest alone does not change that.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sessionIdentity } from "./agent-session";
import {
  applePasswordsReport, arcModSupportRoot, classifyCodesign, ICLOUD_PASSWORDS_STORE_URL, icloudPasswordsManifest,
  nativeMessagingManifestPaths, PASSWORD_MANAGER_HELPER, type ApplePasswordsFacts,
} from "./password-keychain";

export const installIcloudPasswordsManifest = (supportRoot: string): readonly string[] => {
  const body = `${JSON.stringify(icloudPasswordsManifest(), null, 2)}\n`;
  return nativeMessagingManifestPaths(supportRoot).map((path) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { mode: 0o644 });
    return path;
  });
};

const codesignFacts = (app: string | undefined): Pick<ApplePasswordsFacts, "signature" | "teamId" | "passkeyEntitlement" | "hardenedRuntime"> => {
  if (!app || !existsSync(app)) return { signature: "other", teamId: undefined, passkeyEntitlement: false, hardenedRuntime: false };
  const verbose = Bun.spawnSync(["codesign", "-dv", "--verbose=4", app], { stdout: "pipe", stderr: "pipe" });
  const entitlements = Bun.spawnSync(["codesign", "-d", "--entitlements", ":-", app], { stdout: "pipe", stderr: "pipe" });
  return classifyCodesign(`${verbose.stdout.toString()}\n${verbose.stderr.toString()}`, `${entitlements.stdout.toString()}\n${entitlements.stderr.toString()}`);
};

const main = (args: readonly string[]): void => {
  const flags = new Set(["--install", "--doctor", "--open-store", "--validation"]);
  const unknown = args.filter((arg, index) => !flags.has(arg) && !(arg === "--app" || args[index - 1] === "--app"));
  if (unknown.length > 0) throw new Error(`unrecognized argument: ${unknown.join(" ")}`);
  const install = args.includes("--install") || (!args.includes("--doctor") && !args.includes("--open-store"));
  const doctor = args.includes("--doctor") || args.includes("--install") || !args.includes("--open-store");
  const session = sessionIdentity(args.includes("--validation"));
  const support = arcModSupportRoot(process.env.HOME || homedir(), session.appName);
  if (install) {
    for (const path of installIcloudPasswordsManifest(support)) console.log(`wrote ${path}`);
  }
  if (doctor) {
    const explicit = args.includes("--app") ? args[args.indexOf("--app") + 1] : undefined;
    const installed = `/Applications/${session.appName}.app`;
    const built = join(import.meta.dir, "..", "build", `${session.appName}.app`);
    const app = explicit ?? (existsSync(installed) ? installed : existsSync(built) ? built : undefined);
    const facts: ApplePasswordsFacts = {
      ...codesignFacts(app),
      helperInstalled: existsSync(PASSWORD_MANAGER_HELPER),
      manifestPaths: nativeMessagingManifestPaths(support).map((path) => ({ path, installed: existsSync(path) })),
    };
    const report = applePasswordsReport(facts);
    console.log(report.lines.join("\n"));
    if (!app) console.log(`No ${session.appName}.app found to inspect. Pass --app after you build.`);
  }
  if (args.includes("--open-store")) {
    if (process.platform === "darwin") Bun.spawnSync(["open", ICLOUD_PASSWORDS_STORE_URL], { stdout: "inherit", stderr: "inherit" });
    else console.log(ICLOUD_PASSWORDS_STORE_URL);
  }
};

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
