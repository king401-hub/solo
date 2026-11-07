import { describe, expect, it } from "vitest";
import { SyncStore, pickVoice, wins, type SyncDelta } from "./index";

describe("last-writer-wins", () => {
  it("higher timestamp wins; ties go to the larger device id", () => {
    expect(wins({ updatedAt: 2, by: "a" }, { updatedAt: 1, by: "z" })).toBe(true);
    expect(wins({ updatedAt: 1, by: "z" }, { updatedAt: 2, by: "a" })).toBe(false);
    expect(wins({ updatedAt: 5, by: "b" }, { updatedAt: 5, by: "a" })).toBe(true);
    expect(wins({ updatedAt: 5, by: "a" }, { updatedAt: 5, by: "b" })).toBe(false);
    expect(wins({ updatedAt: 1, by: "a" })).toBe(true);
  });

  it("two devices converge no matter the delivery order", () => {
    const pc = new SyncStore("pc", {}, () => 1000);
    const phone = new SyncStore("phone", {}, () => 1000); // same wall clock => tie, broken by id
    const a = pc.set("settings", "voice", { speechRate: 1.2 });
    const b = phone.set("settings", "voice", { speechRate: 0.8 });
    pc.apply(b); phone.apply(a);
    expect(pc.get("settings", "voice")).toEqual(phone.get("settings", "voice"));
    expect(pc.get("settings", "voice")).toEqual({ speechRate: 0.8 }); // "phone" > "pc"
  });

  it("a slow clock still overwrites data it has already seen (hybrid clock)", () => {
    const pc = new SyncStore("pc", {}, () => 10_000);
    const phone = new SyncStore("phone", {}, () => 1_000); // clock far behind
    phone.apply(pc.set("settings", "voice", { v: 1 }));
    const edit = phone.set("settings", "voice", { v: 2 });
    expect(edit.updatedAt).toBeGreaterThan(10_000);
    expect(pc.apply(edit)).toBe(true);
    expect(pc.get("settings", "voice")).toEqual({ v: 2 });
  });

  it("stale deltas are ignored; deletes propagate and beat older writes", () => {
    const pc = new SyncStore("pc", {}, () => 100);
    const old: SyncDelta = { table: "tasks", rowId: "t1", updatedAt: 50, by: "phone", deleted: false, data: { x: 1 } };
    pc.set("tasks", "t1", { x: 2 });
    expect(pc.apply(old)).toBe(false);
    expect(pc.get("tasks", "t1")).toEqual({ x: 2 });
    const del = pc.remove("tasks", "t1");
    expect(pc.get("tasks", "t1")).toBeUndefined();
    const phone = new SyncStore("phone", {}, () => 1);
    phone.apply({ ...old, updatedAt: 60 });
    expect(phone.apply(del)).toBe(true);
    expect(phone.get("tasks", "t1")).toBeUndefined();
  });

  it("offline edits on both sides merge on reconnect via full snapshot exchange", () => {
    const pc = new SyncStore("pc", {}, () => 100);
    const phone = new SyncStore("phone", {}, () => 100);
    pc.set("settings", "voice", { speechRate: 1.5 });
    phone.set("settings", "other", { n: 1 });
    for (const d of pc.all()) phone.apply(d);
    for (const d of phone.all()) pc.apply(d);
    expect(pc.get("settings", "other")).toEqual({ n: 1 });
    expect(phone.get("settings", "voice")).toEqual({ speechRate: 1.5 });
  });

  it("listeners distinguish local from remote changes; snapshot restores", () => {
    const s = new SyncStore("pc", {}, () => 1);
    const seen: boolean[] = [];
    s.onChange((_d, local) => seen.push(local));
    s.set("settings", "a", {});
    s.apply({ table: "settings", rowId: "b", updatedAt: 9, by: "x", deleted: false, data: {} });
    expect(seen).toEqual([true, false]);
    const copy = new SyncStore("pc", JSON.parse(JSON.stringify(s.toJSON())));
    expect(copy.get("settings", "b")).toEqual({});
  });
});

describe("pickVoice", () => {
  const v = (name: string, lang = "en-US") => ({ name, lang, voiceURI: name });
  const win = [v("Microsoft David - English (United States)"), v("Microsoft Zira - English (United States)")];
  it("defaults to a female voice", () => expect(pickVoice(win, "female")?.name).toContain("Zira"));
  it("male on request, system default for any", () => {
    expect(pickVoice(win, "male")?.name).toContain("David");
    expect(pickVoice(win, "any")).toBeUndefined();
  });
  it("prefers English and honours an explicit device choice", () => {
    const mixed = [v("Microsoft Hedda - German", "de-DE"), v("Microsoft Hazel - English (Great Britain)", "en-GB")];
    expect(pickVoice(mixed, "female")?.name).toContain("Hazel");
    expect(pickVoice(win, "female", "Microsoft David - English (United States)")?.name).toContain("David");
  });
  it("falls back to undefined when no matching voice exists", () => expect(pickVoice([v("Microsoft David")], "female")).toBeUndefined());
});
