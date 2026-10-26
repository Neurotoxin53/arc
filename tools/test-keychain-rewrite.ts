#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keychainRewriteHeader } from "./password-keychain";

const root = join(import.meta.dir, "..");
const build = join(root, "build");
mkdirSync(build, { recursive: true });
writeFileSync(join(build, "ArcModKeychainRewrite.h"), keychainRewriteHeader);
const out = join(build, "keychain-rewrite-test");
const compile = Bun.spawnSync([
  "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", build, "-o", out,
  join(root, "mods/passwords/keychain_rewrite.c"), join(root, "mods/passwords/keychain_rewrite_test.c"),
], { stdout: "pipe", stderr: "pipe" });
if (!compile.success) throw new Error(`keychain rewrite compile failed\n${compile.stderr.toString()}`);
const result = Bun.spawnSync([out], { stdout: "pipe", stderr: "pipe" });
if (!result.success) throw new Error(result.stderr.toString() || result.stdout.toString() || `keychain rewrite checks failed (${result.exitCode})`);
console.log("keychain rewrite: ok");
