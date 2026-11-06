import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Orb, type OrbState } from "./Orb";
import "./tokens.css";

const STATES: OrbState[] = ["idle", "listening", "thinking", "speaking", "muted"];

function App() {
  const [state, setState] = useState<OrbState>("idle");
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 24, alignContent: "center" }}>
      <h1 style={{ fontWeight: 600, letterSpacing: -0.5, margin: 0 }}>Solo</h1>
      <Orb state={state} />
      <nav style={{ display: "flex", gap: 8 }} aria-label="Preview orb states">
        {STATES.map((s) => (
          <button key={s} onClick={() => setState(s)} aria-pressed={s === state}
            style={{ padding: "8px 14px", borderRadius: 999, border: "1px solid var(--border)",
              background: s === state ? "var(--accent)" : "var(--surface)", color: s === state ? "#fff" : "var(--text)", cursor: "pointer" }}>
            {s}
          </button>
        ))}
      </nav>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
