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

/** Resolves when speech ends or is cancelled. */
export function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = opts.rate ?? 1;
    const v = pickVoice(speechSynthesis.getVoices(), opts.gender ?? "female", opts.voiceURI);
    if (v) u.voice = v;
    u.onend = () => resolve();
    u.onerror = () => resolve(); // "canceled"/"interrupted" are normal on barge-in
    speechSynthesis.speak(u);
  });
}

export const cancelSpeech = () => speechSynthesis.cancel();
