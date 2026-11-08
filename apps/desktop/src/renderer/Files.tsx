import { useCallback, useEffect, useState } from "react";
import type { FileSyncState } from "../main/files/service";
import type { Conflict, VersionEntry } from "../main/files/conflicts";

type Folder = FileSyncState["folders"][number];
const field = { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", maxWidth: "100%" } as const;
const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const fmtStamp = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)}`;
const stateLabel = (f: Folder) =>
  f.paused ? "Paused" : f.state === "syncing" ? `Syncing ${f.percent}% (${fmtBytes(f.needBytes)} left)` : f.state === "scanning" ? "Scanning…"
  : f.state === "idle" ? (f.needFiles ? `Waiting for ${f.needFiles} file(s)` : f.deviceNames.length ? "Up to date" : "Not shared with any device yet")
  : f.state === "error" ? "Problem: see details" : f.state;

function useFiles() {
  const [st, setSt] = useState<FileSyncState>();
  const refresh = useCallback(async () => { try { setSt(await window.solo.files.state()); } catch { /* engine restarting */ } }, []);
  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 2000); return () => clearInterval(t); }, [refresh]);
  return { st, refresh };
}

function useAction(refresh: () => void) {
  const [err, setErr] = useState<string>();
  const run = async (f: () => Promise<unknown>) => { setErr(undefined); try { await f(); } catch (e) { setErr(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e)); } refresh(); };
  return { err, run, setErr };
}

function FolderCard({ f, st, refresh }: { f: Folder; st: FileSyncState; refresh: () => void }) {
  const { err, run } = useAction(refresh);
  const [panel, setPanel] = useState<"none" | "conflicts" | "history" | "ignore" | "problems">("none");
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [ignores, setIgnores] = useState("");
  const [problems, setProblems] = useState<{ path: string; error: string }[]>([]);
  const toggle = async (p: typeof panel) => {
    if (panel === p) return setPanel("none");
    setPanel(p);
    if (p === "conflicts") setConflicts(await window.solo.files.conflicts(f.id));
    if (p === "history") setVersions(await window.solo.files.versions(f.id));
    if (p === "ignore") setIgnores((await window.solo.files.getIgnores(f.id)).join("\n"));
    if (p === "problems") setProblems(await window.solo.files.errors(f.id));
  };
  const shareable = st.devices.filter((d) => d.syncthingId && !f.deviceNames.includes(d.name));
  return (
    <section className="card" aria-label={`Folder ${f.label}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <strong>{f.label}</strong>
          <div className="mono">{f.path}</div>
          <div className="sub" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {stateLabel(f)} · {f.globalFiles} files · {fmtBytes(f.globalBytes)}
            {f.deviceNames.length ? ` · shared with ${f.deviceNames.join(", ")}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
          <button className="btn" onClick={() => void window.solo.files.open(f.id)}>Open folder</button>
          <button className="btn" onClick={() => void run(() => window.solo.files.rescan(f.id))}>Scan now</button>
          <button className="btn" onClick={() => void run(() => window.solo.files.pause(f.id, !f.paused))}>{f.paused ? "Resume" : "Pause"}</button>
        </div>
      </div>
      {f.state === "syncing" && <div role="progressbar" aria-valuenow={f.percent} aria-valuemin={0} aria-valuemax={100} style={{ height: 6, borderRadius: 3, background: "var(--border)", marginTop: 10 }}><div style={{ width: `${f.percent}%`, height: 6, borderRadius: 3, background: "var(--accent)" }} /></div>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        <button className="btn" onClick={() => void toggle("conflicts")} aria-pressed={panel === "conflicts"}>Conflicts{f.conflicts ? ` (${f.conflicts})` : ""}</button>
        <button className="btn" onClick={() => void toggle("history")} aria-pressed={panel === "history"}>History &amp; recovery</button>
        <button className="btn" onClick={() => void toggle("ignore")} aria-pressed={panel === "ignore"}>Ignore rules</button>
        {f.errors > 0 && <button className="btn danger" onClick={() => void toggle("problems")}>{f.errors} problem(s)</button>}
        {shareable.map((d) => <button key={d.soloId} className="btn" onClick={() => void run(() => window.solo.files.share(f.id, d.soloId))}>Share with {d.name}</button>)}
        <button className="btn danger" onClick={() => { if (confirm(`Stop syncing "${f.label}" on this PC? Your files stay where they are.`)) void run(() => window.solo.files.remove(f.id)); }}>Stop syncing</button>
      </div>
      {err && <p role="alert" style={{ color: "var(--danger)", margin: "8px 0 0" }}>{err}</p>}

      {panel === "conflicts" && (
        <div style={{ marginTop: 12 }}>
          {conflicts.length === 0 && <p className="sub" style={{ margin: 0 }}>No conflicts. If two devices edit the same file while apart, both versions are kept and listed here.</p>}
          {conflicts.map((c) => (
            <div className="row" key={c.conflictRel}>
              <div><strong>{c.originalRel}</strong><div className="sub" style={{ margin: 0, fontSize: 12 }}>Other version saved {fmtStamp(c.date)} ({fmtBytes(c.size)}){c.originalExists ? "" : " · original missing"}</div></div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="btn" onClick={() => void window.solo.files.reveal(f.id, c.originalRel)}>Show current</button>
                <button className="btn" onClick={() => void window.solo.files.reveal(f.id, c.conflictRel)}>Show other</button>
                <button className="btn" onClick={() => void run(async () => { await window.solo.files.resolve(f.id, c.conflictRel, "keep-current"); setConflicts(await window.solo.files.conflicts(f.id)); })}>Keep current</button>
                <button className="btn" onClick={() => void run(async () => { await window.solo.files.resolve(f.id, c.conflictRel, "use-conflict"); setConflicts(await window.solo.files.conflicts(f.id)); })}>Use the other</button>
                <button className="btn" onClick={() => void run(async () => { await window.solo.files.resolve(f.id, c.conflictRel, "keep-both"); setConflicts(await window.solo.files.conflicts(f.id)); })}>Keep both</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {panel === "history" && (
        <div style={{ marginTop: 12 }}>
          {versions.length === 0 && <p className="sub" style={{ margin: 0 }}>Nothing archived yet. When a synced change replaces or deletes a file, the previous version is kept here.</p>}
          {versions.slice(0, 100).map((v) => (
            <div className="row" key={v.versionRel}>
              <div><strong>{v.originalRel}</strong><div className="sub" style={{ margin: 0, fontSize: 12 }}>Saved {fmtStamp(v.timestamp)} ({fmtBytes(v.size)})</div></div>
              <button className="btn" onClick={() => { if (confirm(`Restore "${v.originalRel}" from ${fmtStamp(v.timestamp)}? The current file goes to the Recycle Bin.`)) void run(() => window.solo.files.restore(f.id, v.versionRel)); }}>Restore</button>
            </div>
          ))}
        </div>
      )}

      {panel === "ignore" && (
        <div style={{ marginTop: 12 }}>
          <p className="sub" style={{ margin: "0 0 6px", fontSize: 12 }}>One pattern per line (Syncthing syntax). Matching files and folders are never synced. Lines starting with // are comments.</p>
          <textarea aria-label="Ignore rules" rows={10} style={{ ...field, width: "100%", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 }} value={ignores} onChange={(e) => setIgnores(e.target.value)} />
          <button className="btn primary" style={{ marginTop: 8 }} onClick={() => void run(() => window.solo.files.setIgnores(f.id, ignores.split("\n")))}>Save rules</button>
        </div>
      )}

      {panel === "problems" && (
        <div style={{ marginTop: 12 }}>
          {problems.map((p) => <div className="row" key={p.path}><span className="mono">{p.path}</span><span className="sub" style={{ margin: 0, fontSize: 12 }}>{p.error}</span></div>)}
          <p className="sub" style={{ margin: "6px 0 0", fontSize: 12 }}>Locked files (open in another program) are retried automatically.</p>
        </div>
      )}
    </section>
  );
}

function AddFolder({ st, refresh, onDone }: { st: FileSyncState; refresh: () => void; onDone: () => void }) {
  const { err, run } = useAction(refresh);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [devs, setDevs] = useState<string[]>([]);
  const [ig, setIg] = useState({ dependencies: true, buildOutput: true, caches: true, databases: true, git: true });
  const [keep, setKeep] = useState(90);
  const choose = async () => { const p = await window.solo.files.choose(); if (p) { setPath(p); if (!label) setLabel(p.split(/[\\/]/).filter(Boolean).pop() ?? p); } };
  const cb = (k: keyof typeof ig, text: string, hint: string) => (
    <label key={k} style={{ display: "flex", gap: 8, padding: "4px 0", cursor: "pointer" }}>
      <input type="checkbox" checked={ig[k]} onChange={(e) => setIg({ ...ig, [k]: e.target.checked })} />
      <span>{text}<span className="sub" style={{ display: "block", margin: 0, fontSize: 12 }}>{hint}</span></span>
    </label>
  );
  return (
    <section className="card" aria-label="Add a folder">
      <strong>Sync a folder</strong>
      <div className="row"><button className="btn" onClick={() => void choose()}>Choose folder…</button><span className="mono" style={{ flex: 1 }}>{path || "No folder chosen"}</span></div>
      <div className="row"><label htmlFor="flabel">Name</label><input id="flabel" style={field} value={label} onChange={(e) => setLabel(e.target.value)} /></div>
      <div style={{ padding: "8px 0" }}>
        <div className="sub" style={{ margin: "0 0 4px" }}>Share with</div>
        {st.devices.filter((d) => d.syncthingId).map((d) => (
          <label key={d.soloId} style={{ display: "flex", gap: 8, padding: "2px 0", cursor: "pointer" }}>
            <input type="checkbox" checked={devs.includes(d.soloId)} onChange={(e) => setDevs(e.target.checked ? [...devs, d.soloId] : devs.filter((x) => x !== d.soloId))} />
            {d.name} <span className="sub" style={{ margin: 0 }}>{d.connected ? "· connected" : "· offline (will sync when it is back)"}</span>
          </label>
        ))}
        {st.devices.every((d) => !d.syncthingId) && <p className="sub" style={{ margin: 0, fontSize: 13 }}>No device has shared its file-sync identity yet. Turn on File sync on your other device and keep both online once; you can also share later.</p>}
      </div>
      <details>
        <summary>What is skipped (recommended)</summary>
        {cb("dependencies", "Dependency folders", "node_modules, virtual environments, vendor caches: big, rebuildable and different per machine")}
        {cb("buildOutput", "Build output", "dist, build, out, target, .next ...")}
        {cb("caches", "Caches and temporary files", "editor swap files, ~$ files, .DS_Store ...")}
        {cb("databases", "Live databases", ".sqlite / .db and their journals: syncing a database while a program has it open can corrupt it")}
        {cb("git", "Git repository data (.git)", "Each machine keeps its own history; your working files still sync. Turn off only if you know you need it.")}
      </details>
      <div className="row"><label htmlFor="keep">Keep old versions for (days)</label><input id="keep" type="number" min={1} max={3650} style={{ ...field, width: 90 }} value={keep} onChange={(e) => setKeep(Number(e.target.value))} /></div>
      {err && <p role="alert" style={{ color: "var(--danger)" }}>{err}</p>}
      <button className="btn primary" disabled={!path} onClick={() => void run(async () => { await window.solo.files.addFolder({ path, label, deviceSoloIds: devs, ignore: ig, keepDays: keep }); onDone(); })}>Start syncing</button>{" "}
      <button className="btn" onClick={onDone}>Cancel</button>
    </section>
  );
}

export function Files() {
  const { st, refresh } = useFiles();
  const { err, run } = useAction(refresh);
  const [adding, setAdding] = useState(false);
  if (!st) return <p className="sub">Loading…</p>;
  return (
    <>
      <h1>Files</h1>
      <p className="sub">Keeps real folders identical on your devices, directly between them. Files stay in their normal places and open in any program. Nothing is stored on a Solo server.</p>

      <section className="card" aria-label="File sync">
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: st.available ? "pointer" : "default" }}>
          <input type="checkbox" disabled={!st.available} checked={st.enabled} onChange={(e) => void run(() => window.solo.files.setEnabled(e.target.checked))} />
          <span><strong>Turn on file sync</strong>
            <span className="sub" style={{ display: "block", margin: 0, fontSize: 13 }}>
              {!st.available ? "The sync engine is not installed. Run apps/desktop/tools/fetch-syncthing.ps1 once."
                : st.running ? `Running. This device's sync id: ${st.myId?.slice(0, 7) ?? "…"}…` : st.error ? `Not running: ${st.error}` : st.enabled ? "Starting…" : "Off. Windows may ask to allow network access the first time."}
            </span></span>
        </label>
        {err && <p role="alert" style={{ color: "var(--danger)", margin: "8px 0 0" }}>{err}</p>}
        <details style={{ marginTop: 10 }}>
          <summary>Connection and privacy</summary>
          <p className="sub" style={{ fontSize: 12 }}>Your files travel directly between your devices, encrypted. To find each other across different networks the engine can use Syncthing's public discovery servers and, when a direct connection is impossible, public relays that only carry encrypted data. They learn that your devices exist and when they connect, never your files. Turn these off to sync only on the same network.</p>
          {([["globalDiscovery", "Find devices on other networks (public discovery servers)"], ["relays", "Use public relays when a direct connection fails"], ["nat", "Let the router open a port (UPnP / NAT-PMP)"], ["localDiscovery", "Find devices on this network"]] as const).map(([k, text]) => (
            <label key={k} style={{ display: "flex", gap: 8, padding: "3px 0", cursor: "pointer" }}>
              <input type="checkbox" checked={st.privacy[k]} onChange={(e) => void run(() => window.solo.files.setPrivacy({ ...st.privacy, [k]: e.target.checked }))} />{text}
            </label>
          ))}
        </details>
      </section>

      {st.running && (
        <section className="card" aria-label="Devices">
          <strong>Devices</strong>
          {st.devices.length === 0 && <p className="sub" style={{ margin: "6px 0 0" }}>Pair another device in Devices first.</p>}
          {st.devices.map((d) => (
            <div className="row" key={d.soloId}>
              <span>{d.name}</span>
              <span className="sub" style={{ margin: 0, fontSize: 13 }}>{!d.syncthingId ? (d.online ? "Waiting for it to turn on file sync" : "Offline") : d.connected ? "Connected for file sync" : "Not connected (syncs when it comes online)"}</span>
            </div>
          ))}
        </section>
      )}

      {st.pending.map((p) => (
        <section className="card" key={p.folderId} role="alert" aria-label="Folder offer">
          <strong>{p.offeredBy.join(", ")}</strong> wants to share the folder <strong>{p.label}</strong> with you.
          <p className="sub" style={{ margin: "6px 0" }}>Choose where it should live on this PC. Files already there are merged, never deleted.</p>
          <button className="btn primary" onClick={() => void run(async () => { const path = await window.solo.files.choose(); if (path) await window.solo.files.accept(p.folderId, path); })}>Choose a folder and accept…</button>
        </section>
      ))}

      {st.running && st.folders.map((f) => <FolderCard key={f.id} f={f} st={st} refresh={refresh} />)}
      {st.running && (adding ? <AddFolder st={st} refresh={refresh} onDone={() => setAdding(false)} /> : <button className="btn primary" onClick={() => setAdding(true)}>Sync a folder…</button>)}
    </>
  );
}
