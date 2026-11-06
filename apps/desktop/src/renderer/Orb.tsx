export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "muted";

const LABEL: Record<OrbState, string> = {
  idle: "Say “Hey Solo”", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking", muted: "Microphone off",
};

export function Orb({ state }: { state: OrbState }) {
  const color = state === "muted" ? "var(--muted)" : state === "speaking" ? "var(--accent-2)" : "var(--accent)";
  const pulse = state === "listening" ? "1.4s" : state === "thinking" ? "0.8s" : state === "speaking" ? "1s" : "3s";
  return (
    <div role="status" aria-live="polite" style={{ textAlign: "center" }}>
      <style>{`@keyframes solo-pulse{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(1.08);opacity:1}}`}</style>
      <div style={{
        width: 160, height: 160, borderRadius: "50%", margin: "0 auto 20px",
        background: `radial-gradient(circle at 35% 30%, #fff8, ${color} 55%, transparent 75%)`,
        boxShadow: `0 0 60px ${color}`,
        animation: state === "muted" ? "none" : `solo-pulse ${pulse} ease-in-out infinite`,
      }} />
      <div style={{ color: "var(--muted)", fontSize: 15 }}>{LABEL[state]}</div>
    </div>
  );
}
