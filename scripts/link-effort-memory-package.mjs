// Deliver the effort-memory sub-package into the installed package:
// node_modules/dsh-effort-memory -> <package root>/effort-memory
//
// WHY this script is the delivery mechanism, and not a dependency:
//   - the Loader row's name (`dsh-effort-memory`) has to resolve to a *package*.
//     `packageDirFromAnchor()` in @deepseek-ai/dsh-app-boot probes the require
//     resolution paths of the declaring package's own package.json for
//     `<searchPath>/<name>/package.json` — Node's ordinary ancestor
//     node_modules lookup, so the name has to be findable from THIS package's
//     directory;
//   - `"dsh-effort-memory": "file:./effort-memory"` in `dependencies` makes pnpm
//     resolve that relative path against the PROFILE directory, where no
//     effort-memory/ exists, and the whole install dies with
//     ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND;
//   - `bundledDependencies` only records metadata: pnpm keeps it in the lockfile
//     and excludes the entry from the dependency graph, so nothing installs it;
//   - a committed node_modules/ link cannot survive either — pnpm drops the
//     repository's node_modules/** when it packs a git-hosted package.
//
// So the link is created after extraction, inside the real installed package
// directory, where the anchor lookup can find it. The manifest keeps
// `"dsh-effort-memory": "file:./effort-memory"` in peerDependencies for a
// different reason — pnpm does not install a peer, but DSH's dependencyClosure
// walks `dependencies` + `peerDependencies` when it builds the runtime
// resolution, and without that declaration the link can be present and the row
// still fails to import.
//
// The link target is `<package root>/effort-memory` — the sub-package source
// directory published through `files`, not a `../effort-memory`-style relative
// path: the link keeps pointing inside the package even if pnpm relocates it.
//
// pnpm 11 blocks dependency build scripts by default, so the first
// `dsh plugin add` ends in a build-blocked failure until the scripts are
// approved (the DSH plugin panel's "allow these scripts and retry", or an
// `allowBuilds` entry); the link is created on the retry. This script NEVER
// fails: when the link cannot be created it warns and exits 0 — a missing
// sub-package must not take the whole plugin installation down with it.

import { lstat, mkdir, readlink, rm, symlink, cp, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This package's root directory (resolved from the script, not from the cwd). */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The sub-package name (= the Loader row's `name` in cordis.patch.yml). */
export const SUBPACKAGE_NAME = 'dsh-effort-memory';

/** The in-package directory that holds the sub-package. */
export const SUBPACKAGE_DIR = 'effort-memory';

/** The link that has to exist: <package root>/node_modules/<name> -> <root>/effort-memory. */
export function subpackageLink(root = packageRoot) {
  return { path: join(root, 'node_modules', SUBPACKAGE_NAME), target: join(root, SUBPACKAGE_DIR) };
}

/**
 * Restore the sub-package link, leaving a correct link untouched and rebuilding
 * anything else (a stale link, a copied directory). Windows junctions do not
 * accept a relative target, so the target is always absolute; the `dir` type
 * works on both platforms.
 * @param {{path:string, target:string}} link the link path and its absolute target
 * @param {string} [platform] the target platform (injected by tests)
 * @returns {Promise<'ok'|'linked'>} whether anything changed
 */
export async function ensureLink(link, platform = process.platform) {
  const current = await lstat(link.path).catch(() => null);
  if (current?.isSymbolicLink()) {
    const target = await readlink(link.path).catch(() => null);
    if (target === link.target || target === resolve(link.path, '..', target)) return 'ok';
  }
  await mkdir(dirname(link.path), { recursive: true });
  await rm(link.path, { recursive: true, force: true });
  await symlink(link.target, link.path, platform === 'win32' ? 'junction' : 'dir');
  return 'linked';
}

/**
 * Ensure the sub-package link exists. Falls back to a copy when the platform
 * refuses to create a link, and to a warning when even that fails — this never
 * throws.
 * @returns {Promise<'ok'|'linked'|'copied'|'skipped'>}
 */
export async function ensureSubpackageLink(root = packageRoot, platform = process.platform) {
  const link = subpackageLink(root);
  const source = await stat(link.target).catch(() => null);
  if (source?.isDirectory() !== true) {
    console.warn(`dsh-custom-reasoning-effort: ${link.target} is missing; the ${SUBPACKAGE_NAME} row will not activate`);
    return 'skipped';
  }
  try {
    return await ensureLink(link, platform);
  } catch (error) {
    // Some Windows environments forbid links (Developer Mode / policy): copying
    // is functionally equivalent, it only stops sharing the source directory.
    try {
      await rm(link.path, { recursive: true, force: true });
      await cp(link.target, link.path, { recursive: true });
      console.warn(`dsh-custom-reasoning-effort: could not link ${SUBPACKAGE_NAME} (${String(error)}); copied it instead`);
      return 'copied';
    } catch (copyError) {
      console.warn(`dsh-custom-reasoning-effort: could not deliver ${SUBPACKAGE_NAME} (${String(copyError)}); the row will not activate`);
      return 'skipped';
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await ensureSubpackageLink();
  if (result !== 'skipped') console.log(`dsh-custom-reasoning-effort: ${result} ${subpackageLink().path}`);
}
