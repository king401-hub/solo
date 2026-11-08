import { useEffect, useState } from "react";
import { Orb, type OrbState } from "../Orb";
import { listVoices, speak } from "./tts";
import { thresholdFor } from "@solo/shared";
import { ENROLL_SENTENCES, useVoice, voice } from "./useVoice";

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

function MyVoiceCard() {
  const v = useVoice();
  const s = v.settings;
  const [step, setStep] = useState<number | null>(null); // enrolment in progress: index of the sentence to read
  const [listening, setListening] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [testing, setTesting] = useState(false);

  const begin = async () => { await window.solo.voiceId.start(); const w = await window.solo.voiceId.warmup(); if (!w.ok) return setMsg(`The voice model could not load: ${w.error}`); setMsg(undefined); setStep(0); };
  const record = async () => {
    setListening(true); setMsg(undefined);
    const r = await voice.recordEnrollmentClip();
    setListening(false);
    if (!r.ok) return setMsg(r.reason ?? "That did not work. Try again.");
    if (r.count >= ENROLL_SENTENCES.length) {
      const f = await voice.finishEnrollment();
      setStep(null);
      setMsg(f.ok ? "Done. Solo will now recognise your voice." : f.quality.reason ?? "The recordings were not consistent enough. Please try again.");
    } else setStep(r.count);
  };
  const test = async () => { setTesting(true); await voice.testMyVoice(); setTesting(false); };
  const t = v.lastTest;

  return (
    <section className="card" aria-label="My voice">
      <strong>My voice</strong>
      <p className="sub" style={{ margin: "6px 0 10px", fontSize: 13 }}>
        Teach Solo your voice so it answers you and ignores other people. Solo keeps a numeric voice print on this PC only (no recordings, never synced), encrypted with Windows.
        This is a convenience, not a lock like a fingerprint: a recording or a close imitation of your voice might fool it, and noise or a cold might make it miss you. Solo never uses it to approve anything sensitive.
      </p>
      {step === null && !v.voiceId.enrolled && <button className="btn primary" onClick={() => void begin()}>Teach Solo my voice</button>}
      {step !== null && (
        <div role="group" aria-label="Voice enrolment">
          <p><strong>Sentence {step + 1} of {ENROLL_SENTENCES.length}.</strong> Press Record, then read this aloud at your normal volume:</p>
          <p style={{ fontSize: 18, margin: "8px 0" }}>“{ENROLL_SENTENCES[step]}”</p>
          <button className="btn primary" disabled={listening} onClick={() => void record()}>{listening ? "Listening… read the sentence now" : "Record"}</button>{" "}
          <button className="btn" onClick={() => { void window.solo.voiceId.cancel(); voice.engine.cancelCapture(); setStep(null); setListening(false); }}>Cancel</button>
          <p className="sub" style={{ fontSize: 12 }}>Use a quiet room and the microphone you normally use. Only you should be speaking.</p>
        </div>
      )}
      {msg && <p role="status" style={{ margin: "8px 0" }}>{msg}</p>}
      {v.voiceId.enrolled && step === null && (
        <>
          <p className="sub" style={{ margin: "0 0 6px" }}>Voice print saved{v.voiceId.createdAt ? ` on ${new Date(v.voiceId.createdAt).toLocaleDateString()}` : ""}{v.voiceId.encrypted ? "" : " (not encrypted: Windows could not provide encryption)"}.</p>
          {([["onlyMyVoice", "Only respond to my voice", "Other people cannot wake or command Solo."], ["greetingsWake", "Answer my greetings without a wake word", "Say “hello”, “good morning” or “how far” and Solo answers, only if it is you."], ["allowInterrupt", "Let me interrupt Solo by talking", "Only your voice can stop Solo mid-sentence."]] as const).map(([k, title, hint]) => (
            <label key={k} style={{ display: "flex", gap: 10, padding: "6px 0", cursor: "pointer" }}>
              <input type="checkbox" checked={s[k]} onChange={(e) => voice.updateSettings({ [k]: e.target.checked })} />
              <span>{title}<span className="sub" style={{ display: "block", margin: 0, fontSize: 12 }}>{hint}</span></span>
            </label>
          ))}
          <div className="row"><label htmlFor="strict">Strictness: {s.strictness < 0.34 ? "lenient" : s.strictness > 0.66 ? "strict" : "balanced"} (match needed: {thresholdFor(s.strictness).toFixed(2)})</label>
            <input id="strict" type="range" min={0} max={1} step={0.05} value={s.strictness} onChange={(e) => voice.updateSettings({ strictness: Number(e.target.value) })} />
          </div>
          <p className="sub" style={{ fontSize: 12, margin: "0 0 8px" }}>Lenient: fewer misses, more chance another person is accepted. Strict: the opposite. Use the test below with your own voice to find the right setting.</p>
          <div className="row" style={{ borderTop: 0 }}>
            <button className="btn" disabled={testing} onClick={() => void test()}>{testing ? "Listening… say a sentence" : "Test my voice"}</button>
            {t && <span role="status" style={{ color: t.owner ? "var(--ok)" : t.score !== undefined ? "var(--danger)" : undefined }}>
              {t.score !== undefined ? `Match ${t.score.toFixed(2)} (needs ${t.threshold.toFixed(2)}): ${t.owner ? "recognised as you" : "not recognised"}` : t.note}
            </span>}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn" onClick={() => void begin()}>Record my voice again</button>
            <button className="btn danger" onClick={() => { if (confirm("Delete your voice print from this PC?")) void voice.resetVoiceId(); }}>Delete my voice print</button>
          </div>
        </>
      )}
    </section>
  );
}

function AccuracyCard() {
  const v = useVoice();
  const s = v.settings;
  const [heard, setHeard] = useState("");
  const [meant, setMeant] = useState("");
  return (
    <section className="card" aria-label="Recognition accuracy">
      <strong>Recognition accuracy (accents, Nigerian English)</strong>
      <p className="sub" style={{ margin: "6px 0 10px", fontSize: 13 }}>
        A bigger model should understand accents better but is slower and downloads once. Only the Fast model has been tested end to end; if a bigger one cannot download, Solo falls back to Fast. Pidgin and local expressions are only partly understood; teach Solo the words it gets wrong below.
        Solo&apos;s understanding of what you mean (Nigerian English and Pidgin included) improves further once the AI conversation arrives.
      </p>
      <div className="row"><label htmlFor="asr">Speech recognition model</label>
        <select id="asr" style={field} value={s.asrModel} onChange={(e) => voice.updateSettings({ asrModel: e.target.value as "fast" | "better" | "best" })}>
          <option value="fast">Fast (default, small)</option>
          <option value="better">Better for accents (about 75 MB download)</option>
          <option value="best">Best (about 270 MB, slowest)</option>
        </select>
      </div>
      <p className="sub" style={{ fontSize: 12 }}>Changes apply the next time you turn the microphone on.</p>
      <strong style={{ fontSize: 14 }}>Words Solo should fix</strong>
      <p className="sub" style={{ margin: "4px 0 8px", fontSize: 12 }}>If Solo hears “sorry low” when you say “Solo”, add it here. Applied before Solo decides what you said.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input aria-label="What Solo heard" placeholder="Solo heard…" style={{ ...field, flex: 1 }} value={heard} onChange={(e) => setHeard(e.target.value)} />
        <input aria-label="What I said" placeholder="I said…" style={{ ...field, flex: 1 }} value={meant} onChange={(e) => setMeant(e.target.value)} />
        <button className="btn" onClick={() => { voice.addCorrection(heard, meant); setHeard(""); setMeant(""); }}>Add</button>
      </div>
      {s.corrections.map((c) => (
        <div className="row" key={c.heard}><span>“{c.heard}” → “{c.meant}”</span><button className="btn" onClick={() => voice.removeCorrection(c.heard)}>Remove</button></div>
      ))}
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
      <p className="sub">Say “Hey Solo”, “Hi Solo”, “Solo” or “Solomon”, or teach Solo your voice below and just say hello. Everything is recognised on this PC; nothing is uploaded.</p>

      <section className="card" style={{ padding: 32 }} aria-label="Voice status">
        <Orb state={orbFor(v.phase)} />
        <div style={{ textAlign: "center", marginTop: 20 }}>
          <button className={`btn ${on ? "" : "primary"}`} onClick={() => void voice.setMic(!on)} disabled={v.model === "loading"} aria-pressed={on}>
            {v.model === "loading" ? `Loading speech model… ${v.modelPct}%` : on ? "Turn microphone off" : "Turn microphone on"}
          </button>
          <p className="sub" style={{ margin: "10px 0 0", fontSize: 12 }}>
            {on ? "Microphone is ON (Windows shows its mic indicator while this is active)." : "Microphone is off. Solo hears nothing."}
            {v.model === "idle" && !on ? " First use downloads the speech model." : ""}
          </p>
          {v.error && <p role="alert" style={{ color: "var(--danger)" }}>{v.error}</p>}
        </div>
      </section>

      <section className="card" aria-label="Heard">
        <strong>Recently heard</strong>
        {v.heard.length === 0 && <p className="sub" style={{ margin: "8px 0 0" }}>Nothing yet.</p>}
        {v.heard.map((h) => (
          <div className="row" key={h.id}>
            <span>{h.text}<span className="sub" style={{ display: "block", margin: 0, fontSize: 11 }}>{h.score !== undefined ? `${h.owner ? "your voice" : "another voice"} (match ${h.score.toFixed(2)})` : ""}</span></span>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button className="btn" aria-label={`Fix what Solo heard: ${h.text}`} onClick={() => { const m = prompt(`Solo heard:\n“${h.text}”\n\nType what you actually said (or just the part it got wrong):`); if (m) { const heard = prompt("Which words did Solo mishear? (type them as shown above)", h.text); if (heard) voice.addCorrection(heard, m); } }}>Fix</button>
              <span className="tag" style={h.accepted ? { background: "color-mix(in srgb, var(--ok) 18%, transparent)", color: "var(--ok)" } : undefined}>
                {h.accepted ? "for Solo" : h.owner === false ? "ignored (not your voice)" : "ignored (no wake word)"}
              </span>
            </span>
          </div>
        ))}
      </section>

      <MyVoiceCard />

      <AccuracyCard />

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
