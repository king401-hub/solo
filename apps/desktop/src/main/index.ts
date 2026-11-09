import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from "electron";
import { mkdirSync } from "node:fs";
import { basename, isAbsolute, join, parse, resolve } from "node:path";
import { startLink } from "./link/service";
import { ASR_MODELS, createStt, type AsrPreset, type Stt } from "./voice/stt";
import { createSpeaker } from "./voice/speaker";
import { VoiceId } from "./voice/voiceId";
import { setupBackground } from "./background";

let win: BrowserWindow | undefined;
let bg: ReturnType<typeof setupBackground> | undefined;

// One Solo at a time: launching it again (shortcut, wake word helper) just shows the running one.
if (!app.requestSingleInstanceLock()) app.quit();

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1180, height: 760, minWidth: 860, minHeight: 600,
    backgroundColor: "#0b0d12", title: "Solo",
    show: !process.argv.includes("--hidden"), // started with Windows: stay in the tray
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, // keep the microphone pipeline running at full speed while the window is hidden
    },
  });
  win = w;
  w.on("close", (e) => { bg?.interceptClose(e, w); });
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  w.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("http://localhost")) e.preventDefault(); });
  if (process.env["ELECTRON_RENDERER_URL"]) w.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  else w.loadFile(join(__dirname, "../renderer/index.html"));
  return w;
}

app.whenReady().then(async () => {
  // Deny every permission request (mic etc.) until the voice phase wires explicit, user-controlled grants.
  // Microphone: granted only while the user has the mic switched on in Solo (flag set over IPC), and only to our own UI.
  let micAllowed = false;
  const ours = (url: string) => url.startsWith("file://") || url.startsWith("http://localhost");
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) =>
    cb(perm === "media" && micAllowed && ours(details.requestingUrl) && (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === "audio") !== false));
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin) => perm === "media" && micAllowed && ours(origin));
  ipcMain.handle("voice:setMicAllowed", (_e, on: unknown) => { micAllowed = on === true; });
  const cacheDir = join(app.getPath("userData"), "models");
  let sttPreset: AsrPreset = "fast";
  let stt: Stt = createStt({ cacheDir, model: ASR_MODELS[sttPreset] });
  const isPreset = (v: unknown): v is AsrPreset => typeof v === "string" && v in ASR_MODELS;
  ipcMain.handle("voice:warmup", async (e, preset: unknown) => {
    try {
      if (isPreset(preset) && preset !== sttPreset) { sttPreset = preset; stt = createStt({ cacheDir, model: ASR_MODELS[preset] }); }
      await stt.warmup((p) => e.sender.send("voice:modelProgress", p));
      return { ok: true as const };
    } catch (err) { return { ok: false as const, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("voice:transcribe", async (_e, pcm: unknown) => {
    if (!(pcm instanceof Float32Array) || pcm.length === 0 || pcm.length > 16000 * 30) return "";
    return stt.transcribe(pcm);
  });

  // The owner's voice print: local only, encrypted with the OS keystore, never synced.
  const speaker = createSpeaker({ cacheDir });
  const SPEAKER_MODEL = "Xenova/wavlm-base-plus-sv";
  const voiceId = new VoiceId({
    file: join(app.getPath("userData"), "voiceprint.bin"), speaker, model: SPEAKER_MODEL,
    encrypt: (t) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(t) : null),
    decrypt: (b) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : null),
  });
  const audio = (v: unknown, maxSeconds: number) => (v instanceof Float32Array && v.length > 0 && v.length <= 16000 * maxSeconds ? v : undefined);
  ipcMain.handle("voiceId:status", () => voiceId.status());
  ipcMain.handle("voiceId:warmup", async (e) => {
    try { await speaker.warmup((p) => e.sender.send("voice:modelProgress", p)); return { ok: true as const }; }
    catch (err) { return { ok: false as const, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("voiceId:start", () => voiceId.startEnrollment());
  ipcMain.handle("voiceId:cancel", () => voiceId.cancelEnrollment());
  ipcMain.handle("voiceId:addClip", async (_e, pcm: unknown) => { const a = audio(pcm, 30); return a ? voiceId.addClip(a) : { ok: false, count: voiceId.status().pending, reason: "Invalid recording" }; });
  ipcMain.handle("voiceId:finish", () => voiceId.finishEnrollment());
  ipcMain.handle("voiceId:verify", async (_e, pcm: unknown, strictness: unknown) => {
    const a = audio(pcm, 30);
    if (!a) return voiceId.status().enrolled ? { enrolled: true, tooShort: true } : { enrolled: false };
    return voiceId.verify(a, typeof strictness === "number" ? strictness : 0.5);
  });
  ipcMain.handle("voiceId:reset", () => voiceId.reset());
  ipcMain.handle("solo:version", () => app.getVersion());

  const link = await startLink(
    () => win?.webContents.send("link:changed", link.snapshot()),
    (d) => win?.webContents.send("sync:changed", { table: d.table, rowId: d.rowId, data: d.deleted ? undefined : d.data }),
  );
  const TABLES = ["settings", "memories", "tasks", "conversations"] as const;
  type Table = (typeof TABLES)[number];
  const table = (v: unknown): Table | undefined => TABLES.find((t) => t === v);
  ipcMain.handle("sync:get", (_e, t: unknown, id: unknown) => { const tb = table(t); return tb && typeof id === "string" ? link.sync.get(tb, id) : undefined; });
  ipcMain.handle("sync:set", (_e, t: unknown, id: unknown, data: unknown) => {
    const tb = table(t);
    if (tb && typeof id === "string" && data && typeof data === "object" && !Array.isArray(data)) link.sync.set(tb, id, data as Record<string, unknown>);
  });
  ipcMain.handle("link:snapshot", () => link.snapshot());
  ipcMain.handle("link:startPairing", () => link.startPairing());
  ipcMain.handle("link:cancelPairing", () => link.cancelPairing());
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  ipcMain.handle("link:approve", (_e, id: unknown) => link.approve(str(id)));
  ipcMain.handle("link:deny", (_e, id: unknown) => link.deny(str(id)));
  ipcMain.handle("link:setAutoApprove", (_e, on: unknown) => link.setAutoApprove(on === true));
  ipcMain.handle("link:renameDevice", (_e, id: unknown, name: unknown) => link.renameDevice(str(id), str(name)));
  ipcMain.handle("link:renameSelf", (_e, name: unknown) => link.renameSelf(str(name)));
  ipcMain.handle("link:setRelayUrl", (_e, url: unknown) => link.setRelayUrl(str(url)));
  ipcMain.handle("link:relayHost", () => link.relayHostPairing());
  ipcMain.handle("link:relayCancel", () => link.relayCancelPairing());
  ipcMain.handle("link:relayJoin", (_e, code: unknown) => link.relayJoin(str(code)));
  // ---- File sync (every argument is validated here; the renderer is not trusted with raw paths or ids) ----
  const files = link.files;
  const userData = resolve(app.getPath("userData"));
  const goodFolder = (p: unknown): string | undefined => {
    if (typeof p !== "string" || !isAbsolute(p)) return undefined;
    const r = resolve(p);
    if (parse(r).root === r) return undefined; // not a whole drive
    if (r === userData || userData.startsWith(r + "\\") || r.startsWith(userData)) return undefined; // never Solo's own data (it holds the engine's database)
    return r;
  };
  const sid = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(v) ? v : "");
  ipcMain.handle("files:state", () => files.state());
  ipcMain.handle("files:setEnabled", (_e, on: unknown) => files.setEnabled(on === true));
  ipcMain.handle("files:setPrivacy", (_e, p: unknown) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return files.setPrivacy({ globalDiscovery: o["globalDiscovery"] === true, relays: o["relays"] === true, nat: o["nat"] === true, localDiscovery: o["localDiscovery"] === true });
  });
  ipcMain.handle("files:choose", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? undefined : r.filePaths[0];
  });
  ipcMain.handle("files:addFolder", (_e, i: unknown) => {
    const o = (i ?? {}) as Record<string, unknown>;
    const path = goodFolder(o["path"]);
    if (!path) throw new Error("Choose a normal folder (not a whole drive, and not Solo's own data folder)");
    const ids = Array.isArray(o["deviceSoloIds"]) ? (o["deviceSoloIds"] as unknown[]).map(sid).filter(Boolean) : [];
    const ig = (o["ignore"] ?? {}) as Record<string, unknown>;
    const flag = (k: string) => (typeof ig[k] === "boolean" ? (ig[k] as boolean) : undefined);
    return files.addFolder({
      path, label: typeof o["label"] === "string" ? (o["label"] as string).slice(0, 80) : path, deviceSoloIds: ids,
      ignore: { dependencies: flag("dependencies"), buildOutput: flag("buildOutput"), caches: flag("caches"), databases: flag("databases"), git: flag("git") } as never,
      keepDays: typeof o["keepDays"] === "number" ? Math.min(3650, Math.max(1, Math.round(o["keepDays"] as number))) : 90,
    });
  });
  ipcMain.handle("files:accept", (_e, folderId: unknown, path: unknown) => {
    const p = goodFolder(path);
    if (!p) throw new Error("Choose a normal folder (not a whole drive, and not Solo's own data folder)");
    return files.acceptPending(sid(folderId), p);
  });
  ipcMain.handle("files:share", (_e, folderId: unknown, soloId: unknown) => files.share(sid(folderId), sid(soloId)));
  ipcMain.handle("files:remove", (_e, folderId: unknown) => files.removeFolder(sid(folderId)));
  ipcMain.handle("files:pause", (_e, folderId: unknown, paused: unknown) => files.setPaused(sid(folderId), paused === true));
  ipcMain.handle("files:rescan", (_e, folderId: unknown) => files.rescan(sid(folderId)));
  ipcMain.handle("files:getIgnores", (_e, folderId: unknown) => files.getIgnores(sid(folderId)));
  ipcMain.handle("files:setIgnores", (_e, folderId: unknown, lines: unknown) => files.setIgnores(sid(folderId), Array.isArray(lines) ? (lines as unknown[]).filter((l): l is string => typeof l === "string").map((l) => l.slice(0, 300)) : []));
  ipcMain.handle("files:errors", (_e, folderId: unknown) => files.errors(sid(folderId)));
  ipcMain.handle("files:conflicts", (_e, folderId: unknown) => files.conflicts(sid(folderId)));
  ipcMain.handle("files:resolve", (_e, folderId: unknown, rel: unknown, action: unknown) => {
    if (typeof rel !== "string" || !["keep-current", "use-conflict", "keep-both"].includes(String(action))) throw new Error("Invalid request");
    return files.resolve(sid(folderId), rel, action as "keep-current" | "use-conflict" | "keep-both");
  });
  ipcMain.handle("files:versions", (_e, folderId: unknown, rel: unknown) => files.versions(sid(folderId), typeof rel === "string" ? rel : undefined));
  ipcMain.handle("files:restore", (_e, folderId: unknown, versionRel: unknown) => files.restore(sid(folderId), String(versionRel)));
  ipcMain.handle("files:open", async (_e, folderId: unknown) => { await shell.openPath(await files.folderRoot(sid(folderId))); });
  ipcMain.handle("files:reveal", async (_e, folderId: unknown, rel: unknown) => { shell.showItemInFolder(await files.absPath(sid(folderId), String(rel))); });
  // ---- Files received from other devices ----
  const inbox = link.inbox;
  ipcMain.handle("inbox:state", () => ({ folder: inbox.folder, received: inbox.received(), receiving: inbox.receiving() }));
  ipcMain.handle("inbox:openFolder", async () => { mkdirSync(inbox.folder, { recursive: true }); await shell.openPath(inbox.folder); });
  ipcMain.handle("inbox:reveal", (_e, id: unknown) => { const f = inbox.received().find((x) => x.id === id); if (f) shell.showItemInFolder(f.path); });
  ipcMain.handle("inbox:open", async (_e, id: unknown) => { const f = inbox.received().find((x) => x.id === id); if (f) await shell.openPath(f.path); });
  ipcMain.handle("inbox:forget", (_e, id: unknown) => { if (typeof id === "string") inbox.forget(id); });
  // ---- Sending files to a paired phone ----
  const outbox = link.outbox;
  const pairedPhone = (id: unknown) => { const d = link.snapshot().devices.find((x) => x.deviceId === id); return d && !d.revoked && d.kind === "android" ? d : undefined; };
  ipcMain.handle("send:state", () => ({
    devices: link.snapshot().devices.filter((d) => d.kind === "android" && !d.revoked).map((d) => ({ deviceId: d.deviceId, name: d.name, online: d.online, via: d.via })),
    transfers: outbox.transfers,
  }));
  const sendPaths = async (to: string, paths: string[]) => {
    const errors: string[] = [];
    for (const p of paths.slice(0, 50)) { const e = await outbox.sendFile(to, p); if (e) errors.push(`${basename(p)}: ${e}`); }
    return errors;
  };
  ipcMain.handle("send:choose", async (_e, id: unknown) => {
    const d = pairedPhone(id);
    if (!d) return ["Choose a paired phone first."];
    const r = await dialog.showOpenDialog(win!, { title: `Send to ${d.name}`, properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : sendPaths(d.deviceId, r.filePaths);
  });
  ipcMain.handle("send:paths", async (_e, id: unknown, paths: unknown) => {
    const d = pairedPhone(id);
    if (!d) return ["Choose a paired phone first."];
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string" && isAbsolute(p)) : [];
    return list.length ? sendPaths(d.deviceId, list) : ["Nothing to send. Drop files, not folders or text."];
  });
  ipcMain.handle("send:cancel", (_e, id: unknown) => { if (typeof id === "string") outbox.cancel(id); });
  ipcMain.handle("send:clear", () => outbox.clearFinished());
  ipcMain.handle("link:revoke", (_e, id: unknown) => { if (typeof id === "string") link.revoke(id); });
  ipcMain.handle("link:remove", (_e, id: unknown) => { if (typeof id === "string") link.remove(id); });
  app.on("before-quit", () => { void link.stop(); });

  bg = setupBackground({ file: join(app.getPath("userData"), "background.json"), createWindow, getWindow: () => win });
  ipcMain.handle("app:getBackground", () => ({ ...bg!.settings, visible: bg!.isVisible() }));
  ipcMain.handle("app:setBackground", (_e, patch: unknown) => (patch && typeof patch === "object" ? bg!.set(patch as object) : bg!.settings));
  ipcMain.handle("app:reveal", () => bg!.reveal());
  ipcMain.handle("app:quit", () => bg!.quit());

  createWindow();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
