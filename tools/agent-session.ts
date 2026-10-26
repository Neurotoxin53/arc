// Session identity is deliberately independent of the selected Arc window or Space.
export const agentSlugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const validateAgentSlug = (slug: string): string => {
  if (slug.length > 32 || !agentSlugPattern.test(slug)) {
    throw new Error("agent slug must be 1-32 lowercase letters/digits with internal hyphens, starting with a letter");
  }
  return slug;
};

export interface SessionIdentity {
  readonly appName: string;
  readonly bundleId: string;
  readonly displayName: string;
  readonly agent: string | undefined;
}

// Settings → ArcMod → Agent browser tools (on unless turned off): whether tools/agent-mcp.ts may open sessions.
export const agentToolsEnabled = (): boolean =>
  Bun.spawnSync(["defaults", "read", "company.thebrowser.Browser.mod", "ArcModAgentToolsEnabled"]).stdout.toString().trim() !== "0";

export const sessionIdentity = (validation = false, agent?: string): SessionIdentity => {
  if (validation && agent !== undefined) throw new Error("--validation and --agent cannot be combined");
  if (agent !== undefined) {
    validateAgentSlug(agent);
    return {
      appName: `ArcModAgent-${agent}`,
      bundleId: `company.thebrowser.Browser.mod.agent.${agent}`,
      displayName: `Arc Mod · ${agent}`,
      agent,
    };
  }
  return {
    appName: validation ? "ArcModValidation" : "ArcMod",
    bundleId: validation ? "company.thebrowser.Browser.mod.validation" : "company.thebrowser.Browser.mod",
    // macOS shows a localized name (ArcMod menu → Rename App…) only when this matches the bundle's folder name.
    displayName: validation ? "Arc Mod Test" : "ArcMod",
    agent: undefined,
  };
};

export interface BuildOptions {
  readonly source: string;
  readonly session: SessionIdentity;
  // An ArcCore.framework to use instead of the source app's own engine (e.g. one built from Chromium).
  readonly engine?: string;
  // Leave the build staged (tools/build-paths.ts) instead of replacing the app; tools/update.ts swaps it later.
  readonly stageOnly?: true;
  // Keep the everyday ArcMod in build/ (launched with tools/run-mod.sh --debug) instead of installing it.
  readonly debug?: true;
  // codesign identity. Omit for the usual ad hoc signature ("-").
  readonly signIdentity?: string;
  readonly entitlements?: string;
  readonly hardenedRuntime?: true;
  readonly timestamp?: true;
}

export const parseBuildOptions = (args: readonly string[]): BuildOptions => {
  let source = "/Applications/Arc.app";
  let validation = false;
  let agent: string | undefined;
  let engine: string | undefined;
  let stageOnly = false;
  let debug = false;
  let signIdentity: string | undefined;
  let entitlements: string | undefined;
  let hardenedRuntime = false;
  let timestamp = false;
  const seen = new Set<string>();
  const booleanFlags = new Set(["--validation", "--stage-only", "--debug", "--hardened-runtime", "--timestamp"]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (!["--source", "--validation", "--agent", "--engine", "--stage-only", "--debug", "--sign-identity", "--entitlements", "--hardened-runtime", "--timestamp"].includes(flag)) {
      throw new Error(`unrecognized build argument: ${flag}`);
    }
    if (seen.has(flag)) throw new Error(`duplicate build argument: ${flag}`);
    seen.add(flag);
    if (booleanFlags.has(flag)) {
      if (flag === "--validation") validation = true;
      else if (flag === "--stage-only") stageOnly = true;
      else if (flag === "--debug") debug = true;
      else if (flag === "--hardened-runtime") hardenedRuntime = true;
      else timestamp = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (flag === "--source") source = value;
    else if (flag === "--engine") engine = value;
    else if (flag === "--sign-identity") signIdentity = value;
    else if (flag === "--entitlements") entitlements = value;
    else agent = validateAgentSlug(value);
  }
  const session = sessionIdentity(validation, agent);
  return { source, session, ...(engine === undefined ? {} : { engine }), ...(stageOnly ? { stageOnly: true as const } : {}),
    ...(debug ? { debug: true as const } : {}), ...(signIdentity === undefined ? {} : { signIdentity }),
    ...(entitlements === undefined ? {} : { entitlements }), ...(hardenedRuntime ? { hardenedRuntime: true as const } : {}),
    ...(timestamp ? { timestamp: true as const } : {}) };
};
