/**
 * Language handling for how people actually speak to Solo: greetings with no wake word ("good morning"), Nigerian
 * English and Nigerian Pidgin expressions, and user-taught corrections for words the speech recogniser gets wrong.
 *
 * Honest scope: this is a small, rule-based helper that normalises common expressions and spots greetings. It does NOT
 * understand Pidgin grammar in general; the conversational model (Phase 4) is what really interprets meaning, and it is
 * told the user speaks Nigerian English. This layer only keeps routing and wake decisions from tripping over it.
 */

const norm = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s']/g, " ").replace(/'/g, "").replace(/\s+/g, " ").trim();

// ---- Greetings --------------------------------------------------------------------------------------------

export type GreetingKind = "morning" | "afternoon" | "evening" | "night" | "hello" | "howfar";

const GREETINGS: [RegExp, GreetingKind][] = [
  [/^good morning\b/, "morning"], [/^good afternoon\b/, "afternoon"], [/^good evening\b/, "evening"], [/^good night\b/, "night"],
  [/^(hello|hi|hey|hiya|howdy)\b/, "hello"],
  [/^(morning|afternoon|evening)\b/, "hello"],
  // Nigerian English / Pidgin
  [/^how far\b/, "howfar"], [/^how you dey\b/, "howfar"], [/^how body\b/, "howfar"], [/^how una dey\b/, "howfar"], [/^wetin dey\b/, "howfar"], [/^how now\b/, "howfar"],
];
/** Words that can follow a greeting without changing who it is for. */
const VOCATIVES = new Set(["sir", "ma", "madam", "boss", "oga", "bro", "there", "o", "na", "please", "solo", "solomon", "again", "friend", "my", "man", "dear"]);
/** If the greeting is followed by one of these, it is addressed to someone else. */
const OTHERS = new Set(["mum", "mom", "mummy", "mommy", "dad", "daddy", "baby", "honey", "darling", "sweetheart", "everyone", "everybody", "guys", "folks", "team", "class", "uncle", "aunty", "auntie", "sister", "brother", "pastor", "doctor", "teacher", "madam's", "all", "boys", "girls", "children", "kids"]);

export interface GreetingMatch { kind: GreetingKind; /** what was said after the greeting (vocatives removed) */ rest: string }

/**
 * Detects a greeting at the START of an utterance. Used only for the owner's verified voice: Solo answers "Good
 * morning" with no wake word. Greetings aimed at someone else ("hi mum", "good morning everyone") are not taken.
 */
export function matchGreeting(transcript: string): GreetingMatch | null {
  const t = norm(transcript);
  if (!t) return null;
  for (const [re, kind] of GREETINGS) {
    const m = re.exec(t);
    if (!m) continue;
    const words = t.slice(m[0].length).trim().split(" ").filter(Boolean);
    let i = 0;
    while (i < words.length && VOCATIVES.has(words[i]!) && i < 3) i++;
    const rest = words.slice(i);
    if (rest.length > 0 && rest.length <= 2 && rest.some((w) => OTHERS.has(w))) return null;
    if (rest.length === 0 && words.length > 0 && words.some((w) => OTHERS.has(w))) return null;
    if (i === 0 && words.length > 0 && OTHERS.has(words[0]!)) return null;
    return { kind, rest: rest.join(" ") };
  }
  return null;
}

/** A short spoken answer to a greeting, matched to the time of day. */
export function greetingReply(kind: GreetingKind, now: Date = new Date()): string {
  const h = now.getHours();
  const part = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  switch (kind) {
    case "morning": return "Good morning. How can I help?";
    case "afternoon": return "Good afternoon. How can I help?";
    case "evening": return "Good evening. How can I help?";
    case "night": return "Good night. Rest well.";
    case "howfar": return "I'm doing well, thank you. How are you, and how can I help?";
    default: return `Good ${part}. How can I help?`;
  }
}

// ---- Nigerian English / Pidgin normalisation ----------------------------------------------------------------

/** Longest phrases first. Conservative: ambiguous words (like "na", "dey" alone) are left alone. */
const LEXICON: [string, string][] = [
  ["wetin dey happen", "what is happening"], ["how you dey", "how are you"], ["how una dey", "how are you"], ["how far", "how are you"], ["how body", "how are you"],
  ["no wahala", "no problem"], ["i dey fine", "i am fine"], ["i dey come", "i am coming"], ["i dey go", "i am going"], ["abeg make you", "please"],
  ["make you", "please"], ["make i", "let me"], ["i wan", "i want"], ["i no wan", "i do not want"], ["i no fit", "i cannot"], ["you fit", "can you"],
  ["i no know", "i do not know"], ["no be", "is not"], ["wetin", "what"], ["abeg", "please"], ["oga", "boss"], ["wahala", "trouble"],
  ["comot", "leave"], ["sabi", "know"], ["pikin", "child"], ["chop", "eat"], ["abi", "right"], ["oya", "come on"], ["jare", "please"],
  ["sef", "even"], ["wey", "that"], ["dey", "is"],
];

/** Rewrites common Nigerian English and Pidgin expressions into plain English for intent routing. Not for display. */
export function normalizeNaija(text: string): string {
  let t = ` ${norm(text)} `;
  for (const [from, to] of LEXICON) t = t.replace(new RegExp(` ${from} `, "g"), ` ${to} `).replace(new RegExp(` ${from} `, "g"), ` ${to} `);
  return t.replace(/\s+/g, " ").trim();
}

export type IntentKind = "greeting" | "command" | "question" | "statement";
export interface Intent { kind: IntentKind; text: string; /** the plain-English reading of what was said */ normalized: string }

const COMMAND_VERBS = new Set(["open", "close", "play", "pause", "stop", "call", "send", "search", "find", "create", "make", "show", "read", "remind", "set", "turn", "start", "launch", "write", "delete", "save", "copy", "paste", "download", "install", "run", "check", "tell", "take", "go", "switch", "mute", "unmute", "increase", "decrease", "continue", "resume", "organize", "organise", "list", "add", "schedule", "book", "message", "text"]);
const QUESTION_STARTS = new Set(["what", "when", "where", "why", "who", "whom", "which", "how", "is", "are", "am", "do", "does", "did", "can", "could", "would", "will", "should", "shall", "have", "has", "was", "were"]);

/**
 * Coarse intent: is the user greeting, asking something, telling Solo to do something, or just talking? Used to avoid
 * turning every remark into a task. Real interpretation is left to the conversational model.
 */
export function intentOf(text: string): Intent {
  const normalized = normalizeNaija(text);
  const words = normalized.split(" ").filter(Boolean);
  if (matchGreeting(text) && matchGreeting(text)!.rest === "") return { kind: "greeting", text, normalized };
  const first = words[0] === "please" ? words[1] : words[0];
  if (/\?\s*$/.test(text.trim()) || (first && QUESTION_STARTS.has(first))) {
    // "can you open chrome" is a request in disguise
    if (words.some((w, i) => i > 0 && COMMAND_VERBS.has(w)) && /^(can|could|would|will) (you|u)\b/.test(normalized.replace(/^please /, ""))) return { kind: "command", text, normalized };
    return { kind: "question", text, normalized };
  }
  if (first && COMMAND_VERBS.has(first)) return { kind: "command", text, normalized };
  if (words.length >= 3 && words.slice(0, 3).some((w) => COMMAND_VERBS.has(w)) && words.includes("please")) return { kind: "command", text, normalized };
  return { kind: "statement", text, normalized };
}

// ---- User-taught corrections ------------------------------------------------------------------------------

export interface Correction { heard: string; meant: string }

/**
 * Applies the corrections the user has taught Solo ("sorry low" really means "Solo"). Whole-phrase, case-insensitive,
 * longest rule first. Applied to the transcript before wake and intent decisions, so a mis-hearing of the wake word that
 * the user fixed once stops causing misses.
 */
export function applyCorrections(text: string, rules: Correction[]): string {
  let out = text;
  const sorted = [...rules].filter((r) => r.heard.trim() && r.meant.trim()).sort((a, b) => b.heard.length - a.heard.length);
  for (const r of sorted) {
    const esc = r.heard.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?=$|[^\\p{L}\\p{N}])`, "giu"), (_m, pre: string) => `${pre}${r.meant.trim()}`);
  }
  return out;
}
