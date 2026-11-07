import { useEffect, useState } from "react";
import { Orb, type OrbState } from "../Orb";
import { listVoices, speak } from "./tts";
import { useVoice, voice } from "./useVoice";

export function orbFor(phase: string): OrbState {
  return phase === "off" ? "muted" : phase === "listening" ? "listening" : phase === "thinking" ? "thinking" : phase === "speaking" ? "speaking" : "idle";
}

const field = { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", maxWidth: "100%" } as const;

type Bg = { runInBackground: boolean; startWithWindows: boolean; autoListen: boolean };

function BackgroundCard({ micOn }: { micOn: boolean }) {
  const [bg, setBg] = useState<Bg>();
  useEffect(() => { void window.solo.app.getBackground().then(setBg); }, []);
  if (!bg) return null;
  const toggle = (k: keyof Bg) => (e: React.ChangeEvent<HTMLInputElement>) => void window.solo.app.setBackground({ [k]: e.target.checked }).then(setBg);
  const Row = ({ k, title, hint }: { k: keyof Bg; title: string; hint: string }) => (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 0", cursor: "pointer" }}>
      <input type="checkbox" checked={bg[k]} onChange={toggle(k)} />
      <span><strong>{title}</strong><span className="sub" style={{ display: "block", margin: 0, fontSize: 13 }}>{hint}</span></span>
    </label>
  );
  return (
    <section className="card" aria-label="Background and startup">
      <strong>Background &amp; startup</strong>
      <Row k="runInBackground" title="Keep Solo running in the tray when I close the window"
        hint="Solo keeps listening and shows itself when you say “Hey Solo”, “Hi Solo”, “Solo” or “Solomon”." />
      <Row k="startWithWindows" title="Start Solo with Windows (hidden in the tray)" hint="So it is already there after a restart." />
      <Row k="autoListen" title="Turn the microphone on automatically when Solo starts"
        hint="Needed for wake words after a restart. Windows still shows its microphone indicator while Solo listens." />
      <p className="sub" style={{ margin: "8px 0 0", fontSize: 12 }}>
        {micOn && bg.runInBackground ? "Listening continues in the tray after you close this window. " : ""}
        If you choose “Quit Solo” from the tray icon, Solo is not running and cannot hear anything until it is started again.
      </p>
      <button className="btn danger" style={{ marginTop: 8 }} onClick={() => void window.solo.app.quit()}>Quit Solo completely</button>
    </section>
  );
}

export function Voice() {
  const v = useVoice();
  const { settings: s } = v;
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const on = v.phase !== "off";

  useEffect(() => { void listVoices().then(setVoices); }, []);
  useEffect(() => {
    const load = () => navigator.mediaDevices.enumerateDevices().then((d) => setMics(d.filter((x) => x.kind === "audioinput")));
    void load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener("devicechange", load);
  }, [on]);

  return (
    <>
      <h1>Voice</h1>
      <p className="sub">Say “Hey Solo”, “Hi Solo”, “Solo” or “Solomon”. Everything is recognised on this PC; nothing is uploaded.</p>

      <section className="card" style={{ padding: 32 }} aria-label="Voice status">
        <Orb state={orbFor(v.phase)} />
        <div style={{ textAlign: "center", marginTop: 20 }}>
          <button className={`btn ${on ? "" : "primary"}`} onClick={() => void voice.setMic(!on)} disabled={v.model === "loading"} aria-pressed={on}>
            {v.model === "loading" ? `Loading speech model… ${v.modelPct}%` : on ? "Turn microphone off" : "Turn microphone on"}
          </button>
          <p className="sub" style={{ margin: "10px 0 0", fontSize: 12 }}>
            {on ? "Microphone is ON (Windows shows its mic indicator while this is active)." : "Microphone is off. Solo hears nothing."}
            {v.model === "idle" && !on ? " First use downloads a small speech model (about 40 MB)." : ""}
          </p>
          {v.error && <p role="alert" style={{ color: "var(--danger)" }}>{v.error}</p>}
        </div>
      </section>

      <section className="card" aria-label="Heard">
        <strong>Recently heard</strong>
        {v.heard.length === 0 && <p className="sub" style={{ margin: "8px 0 0" }}>Nothing yet.</p>}
        {v.heard.map((h) => (
          <div className="row" key={h.id}>
            <span>{h.text}</span>
            <span className="tag" style={h.accepted ? { background: "color-mix(in srgb, var(--ok) 18%, transparent)", color: "var(--ok)" } : undefined}>
              {h.accepted ? "for Solo" : "ignored (no wake word)"}
            </span>
          </div>
        ))}
      </section>

      <BackgroundCard micOn={on} />

      <section className="card" aria-label="Voice settings">
        <div className="row"><label htmlFor="mic">Microphone</label>
          <select id="mic" style={field} value={s.inputDeviceId ?? ""} onChange={(e) => voice.updateSettings({ inputDeviceId: e.target.value || undefined })}>
            <option value="">System default</option>
            {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label || "Microphone"}</option>)}
          </select>
        </div>
        <div className="row"><label htmlFor="vg">Solo&apos;s voice</label>
          <select id="vg" style={field} value={s.voiceGender} onChange={(e) => voice.updateSettings({ voiceGender: e.target.value as "female" | "male" | "any" })}>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="any">System default</option>
          </select>
        </div>
        <div className="row"><label htmlFor="vo">Specific voice (this PC only)</label>
          <select id="vo" style={field} value={s.voiceURI ?? ""} onChange={(e) => voice.updateSettings({ voiceURI: e.target.value || undefined })}>
            <option value="">Automatic (from Solo&apos;s voice)</option>
            {voices.map((x) => <option key={x.voiceURI} value={x.voiceURI}>{x.name}</option>)}
          </select>
        </div>
        <div className="row"><label htmlFor="rate">Speech speed ({s.speechRate.toFixed(1)}×)</label>
          <input id="rate" type="range" min={0.5} max={2} step={0.1} value={s.speechRate} onChange={(e) => voice.updateSettings({ speechRate: Number(e.target.value) })} />
        </div>
        <div className="row"><label htmlFor="fu">Keep listening after a reply ({s.followUpSeconds}s)</label>
          <input id="fu" type="range" min={0} max={60} step={2} value={s.followUpSeconds} onChange={(e) => voice.updateSettings({ followUpSeconds: Number(e.target.value) })} />
        </div>
        <div className="row"><label htmlFor="qw">Also wake on just “Solo” or “Solomon” (without “Hey”)</label>
          <input id="qw" type="checkbox" checked={s.quickWord} onChange={(e) => voice.updateSettings({ quickWord: e.target.checked })} />
        </div>
        <div className="row"><span className="sub" style={{ margin: 0 }}>Hear the current voice</span>
          <button className="btn" onClick={() => void speak("Hello, I'm Solo.", { voiceURI: s.voiceURI, rate: s.speechRate, gender: s.voiceGender })}>Test</button>
        </div>
        <p className="sub" style={{ margin: "12px 0 0", fontSize: 12 }}>Speaker selection follows the Windows default output for now.</p>
      </section>
    </>
  );
}
