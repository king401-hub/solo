import { describe, expect, it } from "vitest";
import { cleanTranscript } from "./stt";

describe("cleanTranscript", () => {
  it("drops known hallucinations and non-speech tags", () => {
    for (const s of ["", " you ", "Thank you.", "[BLANK_AUDIO]", "(music)", "Thanks for watching!"]) expect(cleanTranscript(s)).toBe("");
  });
  it("keeps real speech and strips tags inside it", () => {
    expect(cleanTranscript(" Hey Solo, open Chrome. ")).toBe("Hey Solo, open Chrome.");
    expect(cleanTranscript("open [noise] chrome")).toBe("open chrome");
    expect(cleanTranscript("thank you for the help")).toBe("thank you for the help");
  });
});
