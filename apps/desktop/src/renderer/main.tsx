import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Orb } from "./Orb";
import { Voice, orbFor } from "./voice/Voice";
import { useVoice } from "./voice/useVoice";
import { Devices, useLink } from "./Devices";
import { Files } from "./Files";
import "./tokens.css";
import "./shell.css";

const SCREENS = [
  { id: "home", label: "Home", phase: 0 },
  { id: "voice", label: "Voice", phase: 3 },
  { id: "conversation", label: "Conversation", phase: 4 },
  { id: "memory", label: "Memory", phase: 5 },
  { id: "tasks", label: "Tasks", phase: 6 },
  { id: "devices", label: "Devices", phase: 0 },
  { id: "files", label: "Files", phase: 0 },
  { id: "audio", label: "Audio & calls", phase: 8 },
  { id: "models", label: "Models", phase: 10 },
  { id: "usage", label: "Usage & budget", phase: 4 },
  { id: "settings", label: "Settings", phase: 11 },
] as const;
type ScreenId = (typeof SCREENS)[number]["id"];
function Home() {
  const v = useVoice();
  const snap = useLink();
  const online = snap?.devices.filter((d) => d.online).length ?? 0;
  return (
    <>
      <h1>Solo</h1>
      <p className="sub">{online > 0 ? `${online} device${online > 1 ? "s" : ""} connected` : "No device connected"}</p>
      <div className="card" style={{ padding: 40 }}>
        <Orb state={orbFor(v.phase)} />
      </div>
    </>
  );
}

function Planned({ label, phase }: { label: string; phase: number }) {
  return (
    <>
      <h1>{label}</h1>
      <p className="sub"><span className="tag">Planned · Phase {phase}</span></p>
    </>
  );
}

function App() {
  const [screen, setScreen] = useState<ScreenId>("home");
  const snap = useLink();
  const anyOnline = !!snap?.devices.some((d) => d.online);
  const cur = SCREENS.find((s) => s.id === screen)!;
  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="brand">Solo</div>
        {SCREENS.map((s) => (
          <button key={s.id} className="nav" aria-current={s.id === screen ? "page" : undefined} onClick={() => setScreen(s.id)}>
            {s.label}
            {s.id === "devices" && <span className={`dot ${anyOnline ? "on" : ""}`} aria-label={anyOnline ? "device connected" : "no device connected"} />}
          </button>
        ))}
      </nav>
      <main className="main">
        {screen === "home" ? <Home /> : screen === "devices" ? <Devices /> : screen === "voice" ? <Voice /> : screen === "files" ? <Files /> : <Planned label={cur.label} phase={cur.phase} />}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
