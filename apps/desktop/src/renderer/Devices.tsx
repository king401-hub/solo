import { useEffect, useState } from "react";
import type { LinkSnapshot } from "../main/link/service";

export function useLink() {
  const [snap, setSnap] = useState<LinkSnapshot>();
  useEffect(() => {
    void window.solo.link.snapshot().then(setSnap);
    return window.solo.link.onChanged(setSnap);
  }, []);
  return snap;
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((until - now) / 1000));
  return <span className="sub">expires in {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

function EditableName({ value, onSave, label }: { value: string; onSave: (n: string) => void; label: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  if (!editing) return (
    <>
      <strong>{value}</strong>{" "}
      <button className="btn" aria-label={`Rename ${label}`} onClick={() => { setText(value); setEditing(true); }}>Rename</button>
    </>
  );
  const done = () => { if (text.trim() && text.trim() !== value) onSave(text.trim()); setEditing(false); };
  return (
    <>
      <input autoFocus value={text} maxLength={80} aria-label={`New name for ${label}`} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") done(); if (e.key === "Escape") setEditing(false); }}
        style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }} />{" "}
      <button className="btn primary" onClick={done}>Save</button>
    </>
  );
}

export function Devices() {
  const snap = useLink();
  if (!snap) return <p className="sub">Starting link…</p>;
  return (
    <>
      <h1>Connected devices</h1>
      <p className="sub">Pair your phone once; it reconnects automatically on your Wi-Fi.</p>

      <section className="card" aria-label="This computer">
        <div className="sub" style={{ margin: "0 0 6px", fontSize: 12 }}>This computer (shown on your phone as)</div>
        <EditableName value={snap.selfName} label="this computer" onSave={(n) => window.solo.link.renameSelf(n)} />
      </section>

      {snap.requests.map((r) => (
        <section className="card" key={r.id} role="alert" aria-label="Pairing request">
          <strong>{r.name}</strong> <span className="sub">({r.kind}) wants to pair</span>
          <p>Confirmation code: <span className="code" style={{ fontSize: 28, letterSpacing: 6 }}>{r.sas}</span></p>
          <p className="sub">Approve only if your phone shows the same code.</p>
          <button className="btn primary" onClick={() => window.solo.link.approve(r.id)}>Approve</button>{" "}
          <button className="btn danger" onClick={() => window.solo.link.deny(r.id)}>Deny</button>
        </section>
      ))}

      <section className="card" aria-label="Automatic pairing">
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
          <input type="checkbox" checked={snap.autoApprove} onChange={(e) => window.solo.link.setAutoApprove(e.target.checked)} />
          <span>
            <strong>Pair devices on this network automatically</strong>
            <span className="sub" style={{ display: "block", margin: 0, fontSize: 13 }}>
              Skips the approval step for any device on your local network. Leave off on shared or public Wi-Fi.
            </span>
          </span>
        </label>
      </section>

      <section className="card" aria-label="Pair a new device">
        {snap.pairing ? (
          <>
            <div className="code" role="status" aria-label={`Pairing code ${snap.pairing.code.split("").join(" ")}`}>{snap.pairing.code}</div>
            <Countdown until={snap.pairing.expiresAt} />
            <p>On your phone, open Solo, tap Pair, then enter this code and one of these addresses:</p>
            <p className="mono">{snap.addresses.map((a) => `${a}:${snap.port}`).join("   ")}</p>
            <button className="btn" onClick={() => window.solo.link.cancelPairing()}>Cancel</button>
          </>
        ) : (
          <button className="btn primary" onClick={() => window.solo.link.startPairing()}>Pair a new device</button>
        )}
        <p className="mono" style={{ marginTop: 16 }}>Link fingerprint (SHA-256): {snap.certSha256}</p>
      </section>

      <section className="card" aria-label="Paired devices">
        {snap.devices.length === 0 && <p className="sub" style={{ margin: 0 }}>No devices paired yet.</p>}
        {snap.devices.map((d) => (
          <div className="row" key={d.deviceId}>
            <div>
              <EditableName value={d.name} label={d.name} onSave={(n) => window.solo.link.renameDevice(d.deviceId, n)} /> <span className="sub">· {d.kind}</span>
              <div className="sub" style={{ margin: 0, fontSize: 12 }}>
                {d.revoked ? "Revoked" : d.online ? "Connected" : d.lastSeen ? `Last seen ${new Date(d.lastSeen).toLocaleString()}` : "Offline"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className={`dot ${d.online ? "on" : ""}`} aria-hidden />
              {!d.revoked && <button className="btn" onClick={() => window.solo.link.revoke(d.deviceId)}>Revoke</button>}
              <button className="btn danger" onClick={() => window.solo.link.remove(d.deviceId)}>Remove</button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
