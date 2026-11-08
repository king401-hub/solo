/**
 * Default exclusion rules for synced folders, in Syncthing .stignore syntax (patterns without a leading slash match at
 * any depth; (?d) lets Syncthing delete these when it needs to remove an otherwise-empty directory).
 *
 * Why exclusions rather than "sync everything":
 *  - dependency and build folders are huge, reproducible and different per machine (native binaries, absolute paths);
 *  - live databases (SQLite and friends) are corrupted by file-level sync while a program has them open;
 *  - .git is excluded by default: two machines writing the same repository at once can corrupt it. Each machine keeps
 *    its own history (push/pull as usual) while the working files stay identical. It can be turned on per folder.
 */
export interface IgnoreOptions {
  dependencies: boolean; // node_modules, virtualenvs, vendor caches
  buildOutput: boolean; // dist, build, out, target, .next ...
  caches: boolean; // caches, temp and lock/swap files
  databases: boolean; // *.sqlite, *.db, journals
  git: boolean; // skip .git (true = do NOT sync the repository metadata)
}

export const defaultIgnoreOptions: IgnoreOptions = { dependencies: true, buildOutput: true, caches: true, databases: true, git: true };

const DEPENDENCIES = ["node_modules", ".venv", "venv", "env/", "__pypackages__", "vendor/bundle", ".gradle", ".m2", "bower_components", ".pnpm-store"];
const BUILD = ["dist", "build", "out", "target", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", "bin/Debug", "bin/Release", "obj", "*.o", "*.obj", "*.class"];
const CACHES = ["(?d).DS_Store", "(?d)Thumbs.db", "(?d)desktop.ini", ".cache", "__pycache__", "*.pyc", "~$*", "*.tmp", "*.temp", "*.swp", "*.swo", ".#*", "*.crdownload", "*.part"];
const DATABASES = ["*.sqlite", "*.sqlite3", "*.sqlite-wal", "*.sqlite-shm", "*.db", "*.db-journal", "*.db-wal", "*.db-shm", "*.mdb", "*.ldb", "*.mdf", "*.ldf"];
const GIT = [".git"];
// Always ignored: transient git lock files even when the repository is synced.
const ALWAYS = [".git/index.lock", ".git/*.lock"];

/** Build the .stignore lines. Order matters in Syncthing (first match wins), so exceptions would come first. */
export function buildIgnoreList(o: IgnoreOptions = defaultIgnoreOptions, extra: string[] = []): string[] {
  const lines = ["// Managed by Solo. Edit freely; Solo will not overwrite your changes after the folder is created."];
  if (!o.git) lines.push(...ALWAYS);
  if (o.git) lines.push("// Git repository metadata (each machine keeps its own history)", ...GIT);
  if (o.dependencies) lines.push("// Dependency folders", ...DEPENDENCIES);
  if (o.buildOutput) lines.push("// Build output", ...BUILD);
  if (o.caches) lines.push("// Caches, temporary and editor files", ...CACHES);
  if (o.databases) lines.push("// Live databases (unsafe to sync while open)", ...DATABASES);
  if (extra.length) lines.push("// Your rules", ...extra);
  return lines;
}
