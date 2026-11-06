import type { Action, ActionKind, Risk } from "./tasks";

export type SessionKind = "personal" | "guest";

/** Default risk per action. Anything not listed is treated as "confirm" (deny-by-default spirit). */
const BASE_RISK: Record<ActionKind, Risk> = {
  "app.launch": "safe",
  "app.close": "confirm",
  "file.read": "confirm", // sensitive path access needs consent
  "file.write": "confirm",
  "file.move": "confirm",
  "file.delete": "confirm",
  "doc.create_pdf": "safe",
  "doc.create_pptx": "safe",
  "shell.run": "confirm",
  "input.type": "confirm",
  "input.click": "confirm",
  "browser.open": "safe",
  "notification.read": "safe",
  "notification.reply": "confirm", // external communication
  "media.control": "safe",
  "call.accept": "confirm",
  "call.reject": "safe",
  "call.dial": "confirm",
  "message.send": "confirm",
};

const SHELL_DENY = [
  /\brm\s+-rf\s+[\/~]/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sq]/i,
  /\bRemove-Item\b.*-Recurse.*(C:\\|\$env:)/i,
  /\breg\s+delete\b/i,
  /\bshutdown\b/i,
  /curl[^|]*\|\s*(sh|bash|iex)/i,
  /\bInvoke-Expression\b|\biex\b/i,
];

/**
 * Policy gate. Every agent action passes through here BEFORE execution.
 * - "forbidden": never runs.
 * - "confirm": needs explicit user approval (surfaced as awaiting_confirmation).
 * - "safe": may run immediately.
 */
export function assessAction(action: Action, session: SessionKind = "personal"): Risk {
  if (action.kind === "shell.run") {
    const cmd = String(action.args["command"] ?? "");
    if (!cmd.trim() || SHELL_DENY.some((re) => re.test(cmd))) return "forbidden";
  }
  // Guest sessions may not touch personal files or send/communicate on the owner's behalf.
  if (session === "guest") {
    const guestBlocked: ActionKind[] = [
      "file.read", "file.write", "file.move", "file.delete", "shell.run",
      "notification.read", "notification.reply", "message.send", "call.dial", "call.accept",
    ];
    if (guestBlocked.includes(action.kind)) return "forbidden";
  }
  return BASE_RISK[action.kind] ?? "confirm";
}
