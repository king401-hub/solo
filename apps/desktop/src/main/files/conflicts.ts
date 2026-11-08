import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

/**
 * Conflicts and history for synced folders.
 *
 * Syncthing never overwrites a conflicting edit: the version that lost is kept next to the original as
 *   <name>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<device>.<ext>
 * and replaced/deleted files are archived under .stversions (versioning) as <name>~<YYYYMMDD>-<HHMMSS>.<ext>.
 * This module finds them and offers safe, recoverable resolutions (files go to the Recycle Bin, never straight to
 * oblivion).
 */
export interface Conflict { conflictRel: string; originalRel: string; date: string; device: string; size: number; originalExists: boolean }
export interface VersionEntry { versionRel: string; originalRel: string; timestamp: string; size: number }
export type ConflictAction = "keep-current" | "use-conflict" | "keep-both";

const CONFLICT = /^(.*)\.sync-conflict-(\d{8}-\d{6})-([A-Z0-9]{7})(\.[^.\\/]*)?$/;
const VERSION = /^(.*)~(\d{8}-\d{6})(\.[^.\\/]*)?$/;
const SKIP = new Set([".stversions", ".stfolder", "node_modules", ".git", ".stignore", ".venv", "__pycache__"]);

export function parseConflictName(file: string): { original: string; date: string; device: string } | null {
  const m = CONFLICT.exec(file);
  return m ? { original: `${m[1]}${m[4] ?? ""}`, date: m[2]!, device: m[3]! } : null;
}

/** Resolve a user/UI supplied relative path inside the folder root; refuses anything that escapes it. */
export function safeJoin(root: string, rel: string): string {
  const full = resolve(root, rel);
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) throw new Error("Path is outside the synchronised folder");
  return full;
}

function walk(root: string, onFile: (abs: string, rel: string) => void, dir = root, depth = 0) {
  if (depth > 40) return;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name) && e.isDirectory()) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(root, onFile, abs, depth + 1);
    else if (e.isFile()) onFile(abs, relative(root, abs).split(sep).join("/"));
  }
}

export function listConflicts(root: string): Conflict[] {
  const out: Conflict[] = [];
  walk(root, (abs, rel) => {
    const p = parseConflictName(basename(abs));
    if (!p) return;
    const dir = dirname(rel) === "." ? "" : dirname(rel) + "/";
    const originalRel = dir + p.original;
    out.push({ conflictRel: rel, originalRel, date: p.date, device: p.device, size: statSync(abs).size, originalExists: existsSync(join(root, originalRel)) });
  });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export type Trash = (absPath: string) => Promise<void> | void;

/**
 * "keep-current": discard the conflicting copy.
 * "use-conflict": the conflicting copy becomes the file (the current one goes to the Recycle Bin).
 * "keep-both":   the conflicting copy is renamed to "<name> (conflict <date>)<ext>" so both stay as ordinary files.
 */
export async function resolveConflict(root: string, conflictRel: string, action: ConflictAction, trash: Trash): Promise<void> {
  const conflictAbs = safeJoin(root, conflictRel);
  const p = parseConflictName(basename(conflictAbs));
  if (!p) throw new Error("Not a conflict file");
  const originalAbs = join(dirname(conflictAbs), p.original);
  if (action === "keep-current") { await trash(conflictAbs); return; }
  if (action === "use-conflict") {
    if (existsSync(originalAbs)) await trash(originalAbs);
    renameSync(conflictAbs, originalAbs);
    return;
  }
  const ext = extname(p.original), stem = basename(p.original, ext);
  let target = join(dirname(conflictAbs), `${stem} (conflict ${p.date})${ext}`);
  for (let i = 2; existsSync(target); i++) target = join(dirname(conflictAbs), `${stem} (conflict ${p.date} ${i})${ext}`);
  renameSync(conflictAbs, target);
}

/** Archived versions (Syncthing versioning writes them under .stversions, mirroring the folder layout). */
export function listVersions(root: string, onlyOriginalRel?: string, limit = 500): VersionEntry[] {
  const vroot = join(root, ".stversions");
  if (!existsSync(vroot)) return [];
  const out: VersionEntry[] = [];
  walk(vroot, (abs, rel) => {
    const m = VERSION.exec(basename(abs));
    if (!m) return;
    const dir = dirname(rel) === "." ? "" : dirname(rel) + "/";
    const originalRel = `${dir}${m[1]}${m[3] ?? ""}`;
    if (onlyOriginalRel && originalRel !== onlyOriginalRel) return;
    out.push({ versionRel: rel, originalRel, timestamp: m[2]!, size: statSync(abs).size });
  });
  // walk() skips ".stversions" by name only for children; the root itself was passed explicitly, so this is fine.
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

/** Put an archived version back as the live file. The file being replaced goes to the Recycle Bin first. */
export async function restoreVersion(root: string, versionRel: string, trash: Trash): Promise<string> {
  const vAbs = safeJoin(join(root, ".stversions"), versionRel);
  const m = VERSION.exec(basename(vAbs));
  if (!m) throw new Error("Not a version file");
  const dir = dirname(versionRel) === "." ? "" : dirname(versionRel) + "/";
  const originalRel = `${dir}${m[1]}${m[3] ?? ""}`;
  const originalAbs = safeJoin(root, originalRel);
  if (existsSync(originalAbs)) await trash(originalAbs);
  mkdirSync(dirname(originalAbs), { recursive: true });
  copyFileSync(vAbs, originalAbs); // copy, so the archived version stays available too
  return originalRel;
}
