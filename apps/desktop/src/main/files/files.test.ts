import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIgnoreList, defaultIgnoreOptions } from "./ignore";
import { listConflicts, listVersions, parseConflictName, resolveConflict, restoreVersion, safeJoin } from "./conflicts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "solo-files-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const put = (root: string, rel: string, text: string) => { const p = join(root, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };
const trashSpy = () => { const trashed: string[] = []; return { trashed, trash: (p: string) => { trashed.push(p); rmSync(p); } }; };

describe("ignore rules", () => {
  it("excludes dependency folders, build output, caches, live databases and .git by default", () => {
    const rules = buildIgnoreList();
    for (const must of ["node_modules", ".venv", "dist", "build", ".next", "__pycache__", "*.sqlite", "*.db-wal", ".git", "~$*"]) expect(rules).toContain(must);
  });
  it("never excludes lock files that projects need (package-lock.json, yarn.lock, Cargo.lock)", () => {
    const rules = buildIgnoreList().join("\n");
    expect(rules).not.toMatch(/\*\.lock/);
    expect(rules).not.toContain("package-lock");
  });
  it("syncing .git keeps only transient git lock files out", () => {
    const rules = buildIgnoreList({ ...defaultIgnoreOptions, git: false });
    expect(rules).not.toContain(".git");
    expect(rules).toContain(".git/index.lock");
  });
  it("each category can be turned off and custom rules are appended", () => {
    const rules = buildIgnoreList({ dependencies: false, buildOutput: false, caches: false, databases: false, git: false }, ["*.log"]);
    expect(rules).not.toContain("node_modules");
    expect(rules).toContain("*.log");
  });
});

describe("conflict files", () => {
  it("parses Syncthing conflict names with and without extensions", () => {
    expect(parseConflictName("App.sync-conflict-20261108-101112-ABCDEFG.tsx")).toEqual({ original: "App.tsx", date: "20261108-101112", device: "ABCDEFG" });
    expect(parseConflictName("Makefile.sync-conflict-20261108-101112-ABCDEFG")).toEqual({ original: "Makefile", date: "20261108-101112", device: "ABCDEFG" });
    expect(parseConflictName("my.file.min.sync-conflict-20261108-101112-ABCDEFG.js")?.original).toBe("my.file.min.js");
    expect(parseConflictName("App.tsx")).toBeNull();
    expect(parseConflictName("notes about sync-conflict.txt")).toBeNull();
  });

  it("finds conflicts in subfolders, skipping node_modules, .git and .stversions", () => {
    const r = tmp();
    put(r, "src/App.tsx", "mine");
    put(r, "src/App.sync-conflict-20261108-101112-ABCDEFG.tsx", "theirs");
    put(r, "node_modules/x/a.sync-conflict-20261108-101112-ABCDEFG.js", "ignored");
    put(r, ".stversions/old.sync-conflict-20261108-101112-ABCDEFG.txt", "ignored");
    const c = listConflicts(r);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ conflictRel: "src/App.sync-conflict-20261108-101112-ABCDEFG.tsx", originalRel: "src/App.tsx", originalExists: true });
  });

  it("keep-current discards only the conflicting copy (to the Recycle Bin)", async () => {
    const r = tmp(); const t = trashSpy();
    put(r, "a.txt", "mine"); put(r, "a.sync-conflict-20261108-101112-ABCDEFG.txt", "theirs");
    await resolveConflict(r, "a.sync-conflict-20261108-101112-ABCDEFG.txt", "keep-current", t.trash);
    expect(readFileSync(join(r, "a.txt"), "utf8")).toBe("mine");
    expect(t.trashed).toEqual([join(r, "a.sync-conflict-20261108-101112-ABCDEFG.txt")]);
  });

  it("use-conflict swaps the versions and recycles the replaced file, so nothing is lost", async () => {
    const r = tmp(); const t = trashSpy();
    put(r, "a.txt", "mine"); put(r, "a.sync-conflict-20261108-101112-ABCDEFG.txt", "theirs");
    await resolveConflict(r, "a.sync-conflict-20261108-101112-ABCDEFG.txt", "use-conflict", t.trash);
    expect(readFileSync(join(r, "a.txt"), "utf8")).toBe("theirs");
    expect(t.trashed).toEqual([join(r, "a.txt")]);
    expect(existsSync(join(r, "a.sync-conflict-20261108-101112-ABCDEFG.txt"))).toBe(false);
  });

  it("keep-both turns the copy into an ordinary, clearly named file", async () => {
    const r = tmp(); const t = trashSpy();
    put(r, "a.txt", "mine"); put(r, "a.sync-conflict-20261108-101112-ABCDEFG.txt", "theirs");
    await resolveConflict(r, "a.sync-conflict-20261108-101112-ABCDEFG.txt", "keep-both", t.trash);
    expect(readFileSync(join(r, "a.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(r, "a (conflict 20261108-101112).txt"), "utf8")).toBe("theirs");
    expect(t.trashed).toEqual([]);
  });

  it("refuses paths that escape the synchronised folder", async () => {
    const r = tmp();
    expect(() => safeJoin(r, "../outside.txt")).toThrow();
    expect(() => safeJoin(r, "a/../../outside.txt")).toThrow();
    await expect(resolveConflict(r, "../x.sync-conflict-20261108-101112-ABCDEFG.txt", "keep-current", () => {})).rejects.toThrow();
    expect(safeJoin(r, "a/b.txt")).toBe(join(r, "a", "b.txt"));
  });
});

describe("version history", () => {
  it("lists archived versions newest first and restores one without losing the current file", async () => {
    const r = tmp(); const t = trashSpy();
    put(r, "src/App.tsx", "current");
    put(r, ".stversions/src/App~20261101-090000.tsx", "old one");
    put(r, ".stversions/src/App~20261105-090000.tsx", "newer one");
    put(r, ".stversions/other~20261105-090000.txt", "unrelated");
    const v = listVersions(r, "src/App.tsx");
    expect(v.map((x) => x.timestamp)).toEqual(["20261105-090000", "20261101-090000"]);
    expect(listVersions(r)).toHaveLength(3);
    const rel = await restoreVersion(r, v[1]!.versionRel, t.trash);
    expect(rel).toBe("src/App.tsx");
    expect(readFileSync(join(r, "src/App.tsx"), "utf8")).toBe("old one");
    expect(t.trashed).toEqual([join(r, "src/App.tsx")]); // the file it replaced is recoverable
    expect(existsSync(join(r, ".stversions/src/App~20261101-090000.tsx"))).toBe(true); // archive kept
  });
  it("restoring cannot be pointed outside the history folder", async () => {
    const r = tmp();
    await expect(restoreVersion(r, "../a~20261101-090000.txt", () => {})).rejects.toThrow();
  });
});
