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

export function Devices() {
  const snap = useLink();
  if (!snap) return <p className="sub">Starting link…</p>;
  return (
    <>
      <h1>Connected devices</h1>
      <p className="sub">Pair your phone once; it reconnects automatically on your Wi-Fi.</p>

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
              <strong>{d.name}</strong> <span className="sub">· {d.kind}</span>
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
