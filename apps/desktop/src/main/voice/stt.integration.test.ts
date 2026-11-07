import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { matchWake } from "@solo/shared";
import { createStt } from "./stt";

/**
 * Opt-in (downloads the ~40 MB Whisper model on first run):
 *   SOLO_STT_WAV_DIR=<dir with hey.wav + amb.wav, 16 kHz mono 16-bit PCM> npx vitest run stt.integration
 */
const dir = process.env["SOLO_STT_WAV_DIR"];

function readWav(path: string): Float32Array {
  const b = readFileSync(path);
  const data = b.indexOf("data");
  const pcm = new Int16Array(b.buffer.slice(b.byteOffset + data + 8, b.byteOffset + b.length - ((b.length - data - 8) % 2)));
  return Float32Array.from(pcm, (v) => v / 32768);
}

describe.skipIf(!dir)("local Whisper on real speech", () => {
  const stt = createStt({ cacheDir: join(homedir(), ".solo-test-models") });
  it("transcribes a wake-word request and the wake matcher extracts the command", async () => {
    const text = await stt.transcribe(readWav(join(dir!, "hey.wav")));
    console.log("HEY ->", JSON.stringify(text));
    const w = matchWake(text);
    expect(w.matched).toBe(true);
    expect(w.rest).toContain("chrome");
  }, 300_000);
  it("transcribes ambient speech that does NOT wake Solo", async () => {
    const text = await stt.transcribe(readWav(join(dir!, "amb.wav")));
    console.log("AMB ->", JSON.stringify(text));
    expect(text.length).toBeGreaterThan(10);
    expect(matchWake(text).matched).toBe(false);
  }, 300_000);
});
