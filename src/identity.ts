import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Identity, MemoryError, nonempty, object } from "./contracts.ts";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// Read-only resolution: never create markers, register scopes, or infer a tag.
export async function resolveIdentity(
  cwd: string,
  catalogPath: string,
): Promise<Identity> {
  let root = await realpath(cwd);
  for (;;) {
    const markerPath = join(root, ".pi-memory-scope.json");
    let raw: string;
    try {
      raw = await readFile(markerPath, "utf8");
    } catch (error) {
      if (!missing(error)) throw new MemoryError("marker-unreadable");
      // A repository without a marker is not implicitly part of its parent Scope.
      // lstat also recognizes worktree .git files and broken symlinks as boundaries.
      try {
        await lstat(join(root, ".git"));
        throw new MemoryError("scope-unregistered");
      } catch (boundaryError) {
        if (!missing(boundaryError)) {
          if (boundaryError instanceof MemoryError) throw boundaryError;
          throw new MemoryError("repository-boundary-unreadable");
        }
      }
      const parent = dirname(root);
      if (parent === root) throw new MemoryError("scope-unregistered");
      root = parent;
      continue;
    }
    try {
      const marker = object(JSON.parse(raw));
      if (marker.version !== 2) throw new MemoryError("marker-version");
      const scopeId = nonempty(marker.scopeId);
      const projectId = nonempty(marker.projectId);
      const catalog = object(JSON.parse(await readFile(catalogPath, "utf8")));
      const scopes = object(catalog.scopes);
      const scope = object(scopes[scopeId]);
      const projects = object(catalog.projects);
      if (
        scope.scopeId !== scopeId ||
        scope.projectId !== projectId ||
        object(projects[projectId]).projectId !== projectId
      )
        throw new MemoryError("scope-binding-mismatch");
      // Marker copies and stale path bindings need an explicit existing registration.
      const registeredMarker = nonempty(scope.markerPath);
      try {
        if (
          (await realpath(dirname(registeredMarker))) !== root ||
          (await realpath(registeredMarker)) !== (await realpath(markerPath))
        ) {
          throw new MemoryError("scope-path-mismatch");
        }
      } catch (error) {
        if (missing(error)) throw new MemoryError("scope-path-mismatch");
        throw error;
      }
      return { scopeId, projectId, root, scopeTag: nonempty(scope.memoryTag) };
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError("identity-unavailable");
    }
  }
}
