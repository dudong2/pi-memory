import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
// Adapted from pi-hermes-memory; see THIRD_PARTY_NOTICES.
import { acquireCatalogLock } from "./catalog-lock.ts";

const SCOPE_MARKER_VERSION = 2 as const;
const DEFAULT_CATALOG_NAME = "scope-catalog.json";
export type CatalogLocation = string | { catalogPath: string };
export const DEFAULT_MARKER_NAME = ".pi-memory-scope.json";

export interface ProjectRecord {
  projectId: string;
  name: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
}

type RegisteredScopeKind = "directory" | "repository";

export interface ScopeMarker {
  version: typeof SCOPE_MARKER_VERSION;
  scopeId: string;
  projectId?: string;
  scopeName: string;
  kind: RegisteredScopeKind;
  createdAt: string;
  updatedAt: string;
}

export interface ScopeRecord {
  scopeId: string;
  name: string;
  aliases: string[];
  projectId?: string;
  kind: RegisteredScopeKind;
  memoryTag: string;
  markerPath: string;
  paths: string[];
  portableMarkerRoot: string;
  portablePaths: string[];
  repositoryId?: string;
  legacyHermesNames?: string[];
  marker: ScopeMarker;
  createdAt: string;
  updatedAt: string;
}

export interface ScopeCatalog {
  projects: Record<string, ProjectRecord>;
  scopes: Record<string, ScopeRecord>;
}

export interface CreateScopeInput {
  root: string;
  projectId?: string;
  name: string;
  aliases?: string[];
  repositoryId?: string;
  legacyHermesNames?: string[];
  kind?: RegisteredScopeKind;
  scopeId?: string;
  memoryTag?: string;
  createdAt?: string;
  markerName?: string;
  homeDir?: string;
}

function normalizedName(value: string, label: string): string {
  const name = value.trim();
  if (!name) throw new Error(`${label} is required`);
  if (name.includes("/")) throw new Error(`${label} cannot contain /`);
  return name;
}

function normalizedAliases(values: string[] = []): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

function nameKey(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US");
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

function portablePath(path: string): string {
  return path.split(sep).join("/").normalize("NFC");
}

function portableCatalogPath(path: string, home = homedir()): string {
  const absolute = resolve(path);
  const absoluteHome = resolve(home);
  const homeRelative = relative(absoluteHome, absolute);
  if (homeRelative === "") return "~";
  if (!homeRelative.startsWith("..") && !isAbsolute(homeRelative)) {
    return `~/${portablePath(homeRelative)}`;
  }
  return portablePath(absolute);
}

export function catalogPath(location: CatalogLocation): string {
  const path =
    typeof location === "string"
      ? join(location, DEFAULT_CATALOG_NAME)
      : location.catalogPath;
  if (!path || !isAbsolute(path))
    throw new Error("scope-catalog-path-must-be-absolute");
  return path;
}

const acquireLock = acquireCatalogLock;

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

function requiredMarkerText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value.trim();
}

function markerTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    throw new Error(`${name} must be ISO time`);
  return value;
}

export function parseScopeMarker(input: unknown): ScopeMarker {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("scope marker must be an object");
  }
  const raw = input as Partial<ScopeMarker>;
  if (raw.version !== SCOPE_MARKER_VERSION) {
    throw new Error(`unsupported scope marker version: ${String(raw.version)}`);
  }
  const scopeId = requiredMarkerText(raw.scopeId, "scopeId");
  const kind = raw.kind;
  if (kind !== "directory" && kind !== "repository") {
    throw new Error("kind must be directory or repository");
  }
  const projectId = requiredMarkerText(raw.projectId, "projectId");
  const scopeName = normalizedName(raw.scopeName ?? "", "scopeName");
  const createdAt = markerTimestamp(raw.createdAt, "createdAt");
  const updatedAt = markerTimestamp(raw.updatedAt, "updatedAt");
  return {
    version: SCOPE_MARKER_VERSION,
    scopeId,
    projectId,
    scopeName,
    kind,
    createdAt,
    updatedAt,
  };
}

export async function readScopeMarker(
  markerPath: string,
): Promise<ScopeMarker> {
  const info = await lstat(markerPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error("invalid-scope-marker-file");
  const content = await readFile(markerPath, "utf8");
  try {
    return parseScopeMarker(JSON.parse(content) as unknown);
  } catch (error) {
    throw new Error(`invalid scope marker ${markerPath}: ${String(error)}`, {
      cause: error,
    });
  }
}

function isRecordMap(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function loadScopeCatalog(
  dataDir: CatalogLocation,
): Promise<ScopeCatalog> {
  const path = catalogPath(dataDir);
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as ScopeCatalog | null;
    if (!raw || !isRecordMap(raw.projects) || !isRecordMap(raw.scopes)) {
      throw new Error(`invalid scope catalog: ${path}`);
    }
    return { projects: raw.projects, scopes: raw.scopes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { projects: {}, scopes: {} };
    }
    throw error;
  }
}

export function projectByName(
  catalog: ScopeCatalog,
  name: string,
): ProjectRecord | undefined {
  const wanted = nameKey(name);
  return Object.values(catalog.projects).find((project) =>
    [project.name, ...project.aliases].some(
      (candidate) => nameKey(candidate) === wanted,
    ),
  );
}

export function qualifiedScopeName(
  catalog: ScopeCatalog,
  scope: ScopeRecord,
): string {
  const project = scope.projectId
    ? catalog.projects[scope.projectId]
    : undefined;
  return project ? `${project.name}/${scope.name}` : scope.name;
}

export async function createProject(
  dataDir: CatalogLocation,
  name: string,
  aliases: string[] = [],
  projectId = `project_${randomUUID()}`,
): Promise<ProjectRecord> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const projectName = normalizedName(name, "project name");
    const projectAliases = normalizedAliases(aliases);
    const requestedKeys = new Set(
      [projectName, ...projectAliases].map(nameKey),
    );
    const existing = Object.values(catalog.projects).find((project) =>
      [project.name, ...project.aliases].some((candidate) =>
        requestedKeys.has(nameKey(candidate)),
      ),
    );
    if (existing) {
      if (
        nameKey(existing.name) === nameKey(projectName) &&
        [...requestedKeys].every((key) =>
          [existing.name, ...existing.aliases].some(
            (candidate) => nameKey(candidate) === key,
          ),
        )
      )
        return existing;
      throw new Error("project-name-or-alias-conflict");
    }
    if (catalog.projects[projectId])
      throw new Error(`projectId already registered: ${projectId}`);
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      projectId,
      name: projectName,
      aliases: projectAliases,
      createdAt: now,
      updatedAt: now,
    };
    catalog.projects[projectId] = project;
    await writeJsonAtomic(path, catalog);
    return project;
  } finally {
    await release();
  }
}

async function buildScopeRecord(
  input: CreateScopeInput,
  name: string,
  projectId: string,
  kind: RegisteredScopeKind,
): Promise<ScopeRecord> {
  const root = await realpath(resolve(input.root));
  if (!(await stat(root)).isDirectory())
    throw new Error("scope-root-not-directory");
  const home = await canonicalPath(input.homeDir ?? homedir());
  const markerName = input.markerName ?? DEFAULT_MARKER_NAME;
  if (markerName !== DEFAULT_MARKER_NAME)
    throw new Error("unsupported-scope-marker-name");
  const markerPath = join(root, markerName);
  const scopeId = input.scopeId ?? `scope_${randomUUID()}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const marker: ScopeMarker = {
    version: SCOPE_MARKER_VERSION,
    scopeId,
    projectId,
    scopeName: name,
    kind,
    createdAt,
    updatedAt: createdAt,
  };
  return {
    scopeId,
    name,
    aliases: normalizedAliases(input.aliases),
    projectId,
    kind,
    memoryTag: input.memoryTag ?? `scope:id:${scopeId}`,
    markerPath,
    paths: [root],
    portableMarkerRoot: portableCatalogPath(root, home),
    portablePaths: [portableCatalogPath(root, home)],
    ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
    ...(input.legacyHermesNames?.length
      ? { legacyHermesNames: normalizedAliases(input.legacyHermesNames) }
      : {}),
    marker,
    createdAt,
    updatedAt: createdAt,
  };
}

export async function createScope(
  dataDir: CatalogLocation,
  input: CreateScopeInput,
): Promise<ScopeRecord> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const kind =
      input.kind ?? (input.repositoryId ? "repository" : "directory");
    if (kind !== "directory" && kind !== "repository") {
      throw new Error("kind must be directory or repository");
    }
    const projectId = input.projectId;
    if (!projectId || !catalog.projects[projectId]) {
      throw new Error(`unknown projectId: ${String(projectId)}`);
    }
    const name = normalizedName(input.name, "scope name");
    const duplicate = Object.values(catalog.scopes).find(
      (scope) =>
        scope.projectId === projectId && nameKey(scope.name) === nameKey(name),
    );
    if (duplicate) {
      const root = await realpath(resolve(input.root));
      if (dirname(duplicate.markerPath) !== root)
        throw new Error("scope-name-location-conflict");
      const marker = await readScopeMarker(duplicate.markerPath);
      if (
        marker.scopeId !== duplicate.scopeId ||
        marker.projectId !== projectId
      )
        throw new Error("scope-marker-conflict");
      return duplicate;
    }
    if (input.scopeId && catalog.scopes[input.scopeId])
      throw new Error(`scopeId already registered: ${input.scopeId}`);
    const record = await buildScopeRecord(input, name, projectId, kind);
    try {
      await lstat(record.markerPath);
      throw new Error("scope-marker-already-exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const previousCatalog = structuredClone(catalog);
    catalog.scopes[record.scopeId] = record;
    await writeJsonAtomic(path, catalog);
    try {
      const handle = await open(record.markerPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record.marker, null, 2)}\n`);
      } catch (error) {
        await unlink(record.markerPath);
        throw error;
      } finally {
        await handle.close();
      }
    } catch (error) {
      await writeJsonAtomic(path, previousCatalog);
      throw error;
    }
    return record;
  } finally {
    await release();
  }
}

export async function reassignScopeProject(
  dataDir: CatalogLocation,
  scopeId: string,
  targetProjectId: string,
  updatedAt = new Date().toISOString(),
  expectedProjectId?: string,
): Promise<ScopeRecord> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const scope = catalog.scopes[scopeId];
    if (!scope) throw new Error(`unknown scopeId: ${scopeId}`);
    const sourceProjectId = scope.projectId;
    if (expectedProjectId && sourceProjectId !== expectedProjectId)
      throw new Error("scope-membership-changed");
    if (!sourceProjectId || !catalog.projects[sourceProjectId]) {
      throw new Error(`Scope '${scope.name}' has no registered source Project`);
    }
    const targetProject = catalog.projects[targetProjectId];
    if (!targetProject)
      throw new Error(`unknown projectId: ${targetProjectId}`);
    if (sourceProjectId === targetProjectId) return scope;

    const duplicate = Object.values(catalog.scopes).find(
      (candidate) =>
        candidate.scopeId !== scopeId &&
        candidate.projectId === targetProjectId &&
        nameKey(candidate.name) === nameKey(scope.name),
    );
    if (duplicate) {
      throw new Error(
        `Project '${targetProject.name}' already has Scope '${scope.name}'`,
      );
    }

    const marker = await readScopeMarker(scope.markerPath);
    if (marker.scopeId !== scopeId || marker.projectId !== sourceProjectId) {
      throw new Error(
        `Scope marker does not match catalog membership: ${scope.markerPath}`,
      );
    }
    const nextMarker: ScopeMarker = {
      ...marker,
      projectId: targetProjectId,
      updatedAt,
    };
    const nextScope: ScopeRecord = {
      ...scope,
      projectId: targetProjectId,
      marker: nextMarker,
      updatedAt,
    };
    const previousCatalog = structuredClone(catalog);
    catalog.scopes[scopeId] = nextScope;
    // Membership is stored on the Scope; leave existing Project records intact.

    await writeJsonAtomic(path, catalog);
    try {
      // lazy: two filesystem renames cannot be one atomic commit. A durable
      // transaction journal would remove the brief catalog/marker skew window.
      await writeJsonAtomic(scope.markerPath, nextMarker);
    } catch (error) {
      try {
        await writeJsonAtomic(path, previousCatalog);
      } catch (rollbackError) {
        throw new Error(
          `Scope reassignment failed and catalog rollback also failed: ${String(rollbackError)}`,
          { cause: error },
        );
      }
      throw error;
    }
    return nextScope;
  } finally {
    await release();
  }
}

export async function rebindScopeRepositoryId(
  dataDir: CatalogLocation,
  scopeId: string,
  expectedRepositoryId: string,
  repositoryId: string,
): Promise<ScopeRecord | null> {
  if (!expectedRepositoryId || !repositoryId) return null;
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const current = catalog.scopes[scopeId];
    if (
      !current ||
      current.kind !== "repository" ||
      current.repositoryId !== expectedRepositoryId
    ) {
      return null;
    }
    if (expectedRepositoryId === repositoryId) return current;
    const conflict = Object.values(catalog.scopes).some(
      (scope) =>
        scope.scopeId !== scopeId && scope.repositoryId === repositoryId,
    );
    if (conflict) return null;
    const next: ScopeRecord = {
      ...current,
      repositoryId,
      updatedAt: new Date().toISOString(),
    };
    catalog.scopes[scopeId] = next;
    await writeJsonAtomic(path, catalog);
    return next;
  } finally {
    await release();
  }
}

export async function promoteScopeRepositoryId(
  dataDir: CatalogLocation,
  scopeId: string,
  expectedLocalRepositoryId: string,
  remoteRepositoryId: string,
): Promise<ScopeRecord | null> {
  if (
    !expectedLocalRepositoryId.startsWith("local/") ||
    remoteRepositoryId.startsWith("local/")
  ) {
    return null;
  }
  return rebindScopeRepositoryId(
    dataDir,
    scopeId,
    expectedLocalRepositoryId,
    remoteRepositoryId,
  );
}

export async function updateScopeLocation(
  dataDir: CatalogLocation,
  scopeId: string,
  markerPath: string,
  observedPath: string,
  homeDir = homedir(),
): Promise<ScopeRecord> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const current = catalog.scopes[scopeId];
    if (!current) throw new Error(`scope is not registered: ${scopeId}`);
    const root = await realpath(dirname(markerPath));
    const observed = await realpath(observedPath);
    const onDisk = await readScopeMarker(markerPath);
    if (onDisk.scopeId !== scopeId || onDisk.projectId !== current.projectId)
      throw new Error("scope-marker-location-mismatch");
    if (resolve(current.markerPath) !== resolve(markerPath)) {
      try {
        await lstat(current.markerPath);
        throw new Error("scope-original-location-still-exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const paths = [...new Set([...current.paths, observed, root])].sort(
      (a, b) => a.localeCompare(b),
    );
    const portableMarkerRoot = portableCatalogPath(root, homeDir);
    const unchanged =
      resolve(current.markerPath) === resolve(markerPath) &&
      current.portableMarkerRoot === portableMarkerRoot &&
      paths.length === current.paths.length &&
      paths.every((item, index) => item === current.paths[index]);
    if (unchanged) return current;
    const now = new Date().toISOString();
    const marker = { ...current.marker, updatedAt: now };
    const next: ScopeRecord = {
      ...current,
      markerPath,
      paths,
      portableMarkerRoot,
      portablePaths: paths.map((item) => portableCatalogPath(item, homeDir)),
      marker,
      updatedAt: now,
    };
    const previousCatalog = structuredClone(catalog);
    catalog.scopes[scopeId] = next;
    await writeJsonAtomic(path, catalog);
    try {
      if (marker.updatedAt !== current.marker.updatedAt)
        await writeJsonAtomic(markerPath, marker);
    } catch (error) {
      await writeJsonAtomic(path, previousCatalog);
      throw error;
    }
    return next;
  } finally {
    await release();
  }
}

export async function restoreScopeMarker(
  dataDir: CatalogLocation,
  root: string,
  repositoryId?: string,
  homeDir = homedir(),
  markerName = DEFAULT_MARKER_NAME,
): Promise<string | null> {
  const catalog = await loadScopeCatalog(dataDir);
  const canonicalRoot = await canonicalPath(root);
  const portableRoot = portableCatalogPath(canonicalRoot, homeDir);
  const candidates = Object.values(catalog.scopes).filter(
    (scope) =>
      scope.portableMarkerRoot === portableRoot ||
      scope.paths.includes(canonicalRoot) ||
      (repositoryId !== undefined && scope.repositoryId === repositoryId),
  );
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  if (!candidate) return null;
  const target = join(canonicalRoot, markerName);
  try {
    if ((await stat(target)).isFile()) return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJsonAtomic(target, candidate.marker);
  return target;
}

export async function removeScope(
  dataDir: CatalogLocation,
  scopeId: string,
): Promise<ScopeRecord | null> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const scope = catalog.scopes[scopeId];
    if (!scope) return null;
    delete catalog.scopes[scopeId];
    await writeJsonAtomic(path, catalog);
    return scope;
  } finally {
    await release();
  }
}

export async function removeProjectIfEmpty(
  dataDir: CatalogLocation,
  projectId: string,
): Promise<ProjectRecord | null> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const project = catalog.projects[projectId];
    if (!project) return null;
    const hasScopes = Object.values(catalog.scopes).some(
      (scope) => scope.projectId === projectId,
    );
    if (hasScopes) return null;
    delete catalog.projects[projectId];
    await writeJsonAtomic(path, catalog);
    return project;
  } finally {
    await release();
  }
}

export async function resolveCatalogRecord(
  dataDir: CatalogLocation,
  marker: ScopeMarker,
): Promise<{
  catalog: ScopeCatalog;
  scope: ScopeRecord;
  project?: ProjectRecord;
}> {
  const catalog = await loadScopeCatalog(dataDir);
  const scope = catalog.scopes[marker.scopeId];
  if (!scope)
    throw new Error(
      `scope marker is not registered in the catalog: ${marker.scopeId}`,
    );
  if (scope.projectId !== marker.projectId || scope.kind !== marker.kind) {
    throw new Error(`scope marker does not match catalog: ${marker.scopeId}`);
  }
  const project = scope.projectId
    ? catalog.projects[scope.projectId]
    : undefined;
  if (!project) throw new Error(`scope project is missing: ${scope.projectId}`);
  return { catalog, scope, ...(project ? { project } : {}) };
}
