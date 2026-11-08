import { describe, expect, it } from "vitest";
import { MIN_ENROLL_CLIPS, buildPrint, centroid, cosine, isOwner, score, thresholdFor, unit } from "./index";

/** Deterministic pseudo-embeddings: a "person" direction plus small per-clip noise. */
function rng(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 - 0.5; }; }
const person = (seed: number, dim = 64) => { const r = rng(seed); return Array.from({ length: dim }, () => r() * 2); };
const clipOf = (p: number[], noise: number, seed: number) => { const r = rng(seed); return unit(p.map((x) => x + r() * noise)); };

describe("voice print maths", () => {
  const me = person(1), other = person(2);
  it("cosine basics", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([1, 0], [1, 0, 0])).toBe(-1); // mismatched models never match
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
  it("builds a print from consistent clips and rejects fewer than the minimum", () => {
    const clips = Array.from({ length: MIN_ENROLL_CLIPS }, (_, i) => clipOf(me, 0.3, 10 + i));
    const r = buildPrint(clips, "m", { now: 5 });
    expect(r.quality.ok).toBe(true);
    expect(r.print).toMatchObject({ v: 1, model: "m", createdAt: 5 });
    expect(r.print!.clips).toHaveLength(MIN_ENROLL_CLIPS);
    const few = buildPrint(clips.slice(0, 2), "m");
    expect(few.quality.ok).toBe(false);
    expect(few.print).toBeUndefined();
  });
  it("refuses inconsistent enrolment (a second person talking, or garbage)", () => {
    const clips = [clipOf(me, 0.3, 1), clipOf(me, 0.3, 2), clipOf(me, 0.3, 3), clipOf(other, 0.3, 4)];
    const r = buildPrint(clips, "m");
    expect(r.quality.ok).toBe(false);
    expect(r.quality.reason).toMatch(/alike/);
    expect(r.print).toBeUndefined();
  });
  it("accepts the owner and rejects another person at normal strictness", () => {
    const { print } = buildPrint(Array.from({ length: 5 }, (_, i) => clipOf(me, 0.3, 20 + i)), "m");
    const mine = isOwner(print!, clipOf(me, 0.3, 99), 0.5);
    const theirs = isOwner(print!, clipOf(other, 0.3, 98), 0.5);
    expect(mine.owner).toBe(true);
    expect(theirs.owner).toBe(false);
    expect(mine.score).toBeGreaterThan(theirs.score);
    expect(score(print!, centroid(print!.clips))).toBeGreaterThan(0.95);
  });
  it("strictness moves the threshold monotonically and is clamped", () => {
    expect(thresholdFor(0)).toBeLessThan(thresholdFor(0.5));
    expect(thresholdFor(0.5)).toBeLessThan(thresholdFor(1));
    expect(thresholdFor(-3)).toBe(thresholdFor(0));
    expect(thresholdFor(9)).toBe(thresholdFor(1));
  });
});
