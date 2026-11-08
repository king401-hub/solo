/** Spoken replies via the OS voices (Windows SAPI/OneCore through Chromium). Local, free, interruptible. */
import { pickVoice, type VoiceSettings } from "@solo/shared";

export interface SpeakOptions { voiceURI?: string; rate?: number; gender?: VoiceSettings["voiceGender"] }

export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const have = speechSynthesis.getVoices();
    if (have.length) return resolve(have);
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}

/**
 * Split a reply into sentence-sized pieces. Long single utterances are where speech engines misbehave (Chromium stops
 * some voices after about 15 seconds), and shorter pieces also let a stop request take effect between sentences.
 */
export function splitForSpeech(text: string, maxLen = 220): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?;:\n]+[.!?;:]*\s*/g) ?? [];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > maxLen && cur) { out.push(cur.trim()); cur = ""; }
    if (s.length > maxLen) { // one very long sentence: break at commas, then at word boundaries
      for (let part of s.split(/(?<=,)\s+/)) {
        while (part.length > maxLen) {
          const cut = part.lastIndexOf(" ", maxLen);
          const at = cut > maxLen / 2 ? cut : maxLen; // no sensible space: hard cut rather than loop forever
          if (cur) { out.push(cur.trim()); cur = ""; }
          out.push(part.slice(0, at).trim());
          part = part.slice(at).trim();
        }
        if ((cur + part).length > maxLen && cur) { out.push(cur.trim()); cur = ""; }
        cur += part + " ";
      }
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Chromium can garbage-collect an utterance that is still being spoken, which silently cuts the speech off. Keep every
// utterance reachable until it has finished.
const alive = new Set<SpeechSynthesisUtterance>();
let generation = 0;

/** Speaks the text piece by piece. Resolves when finished or when cancelSpeech() is called. */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const my = ++generation;
  const voice = pickVoice(speechSynthesis.getVoices(), opts.gender ?? "female", opts.voiceURI);
  for (const piece of splitForSpeech(text)) {
    if (my !== generation) return; // cancelled, or superseded by a newer reply
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(piece);
      u.rate = opts.rate ?? 1;
      if (voice) u.voice = voice;
      alive.add(u);
      const done = () => { alive.delete(u); resolve(); };
      u.onend = done;
      u.onerror = done; // "canceled" / "interrupted" are normal when the user stops Solo
      speechSynthesis.speak(u);
    });
  }
}

export function cancelSpeech() {
  generation++; // stops the piece-by-piece loop even between sentences
  speechSynthesis.cancel();
}

export const isSpeaking = () => speechSynthesis.speaking || alive.size > 0;
