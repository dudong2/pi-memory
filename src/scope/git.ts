import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

export interface GitContext {
  worktreeRoot: string;
  commonDir: string;
  mainRoot: string;
  remote?: string;
  localRepositoryId: string;
  repositoryId: string;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return (
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export function canonicalizeGitRemote(remote: string): string | undefined {
  const value = remote.trim();
  if (!value) return undefined;

  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const [, host, remotePath] = scp;
    if (!host || !remotePath) return undefined;
    const path = remotePath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return path ? `${host.toLowerCase()}/${path.toLowerCase()}` : undefined;
  }

  try {
    const url = new URL(value);
    if (url.protocol === "file:") return undefined;
    const path = decodeURIComponent(url.pathname)
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "");
    return path
      ? `${url.hostname.toLowerCase()}/${path.toLowerCase()}`
      : undefined;
  } catch {
    return undefined;
  }
}

function localRepositoryId(commonDir: string): string {
  const digest = createHash("sha256")
    .update(resolve(commonDir))
    .digest("hex")
    .slice(0, 16);
  return `local/${digest}`;
}

export function resolveGitContext(cwd: string): GitContext | null {
  const worktreeRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!worktreeRoot) return null;

  const absoluteCommon = git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const fallbackCommon = git(cwd, ["rev-parse", "--git-common-dir"]);
  const commonDir = resolve(
    absoluteCommon ?? resolve(cwd, fallbackCommon ?? ".git"),
  );
  const mainRoot =
    basename(commonDir) === ".git" ? dirname(commonDir) : worktreeRoot;
  const remote = git(cwd, ["remote", "get-url", "origin"]);
  const localId = localRepositoryId(commonDir);
  const repositoryId = (remote && canonicalizeGitRemote(remote)) || localId;

  return {
    worktreeRoot: resolve(worktreeRoot),
    commonDir,
    mainRoot: resolve(mainRoot),
    ...(remote ? { remote } : {}),
    localRepositoryId: localId,
    repositoryId,
  };
}
