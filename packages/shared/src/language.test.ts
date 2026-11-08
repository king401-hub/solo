import { describe, expect, it } from "vitest";
import { applyCorrections, greetingReply, intentOf, matchGreeting, normalizeNaija } from "./index";

describe("greetings (no wake word needed for the owner)", () => {
  it("recognises plain English greetings", () => {
    expect(matchGreeting("Hello")).toEqual({ kind: "hello", rest: "" });
    expect(matchGreeting("Hi.")).toEqual({ kind: "hello", rest: "" });
    expect(matchGreeting("Good morning!")).toEqual({ kind: "morning", rest: "" });
    expect(matchGreeting("good afternoon sir")).toEqual({ kind: "afternoon", rest: "" });
    expect(matchGreeting("Good evening, Solo")).toEqual({ kind: "evening", rest: "" });
  });
  it("recognises Nigerian English and Pidgin greetings", () => {
    expect(matchGreeting("How far?")).toEqual({ kind: "howfar", rest: "" });
    expect(matchGreeting("how you dey")).toEqual({ kind: "howfar", rest: "" });
    expect(matchGreeting("Good morning o")).toEqual({ kind: "morning", rest: "" });
    expect(matchGreeting("hello oga")).toEqual({ kind: "hello", rest: "" });
    expect(matchGreeting("wetin dey")).toEqual({ kind: "howfar", rest: "" });
  });
  it("keeps what was said after the greeting as the request", () => {
    expect(matchGreeting("Good morning, open Chrome")).toEqual({ kind: "morning", rest: "open chrome" });
    expect(matchGreeting("hello what is the time")).toEqual({ kind: "hello", rest: "what is the time" });
  });
  it("ignores greetings aimed at other people and ordinary sentences", () => {
    for (const s of ["hi mum", "good morning everyone", "hello guys", "hey daddy", "hi baby how was school", "I said hello to him", "the hello world program", "this is high", "history of rome", ""]) {
      expect(matchGreeting(s), s).toBeNull();
    }
  });
  it("answers appropriately", () => {
    expect(greetingReply("morning")).toBe("Good morning. How can I help?");
    expect(greetingReply("night")).toBe("Good night. Rest well.");
    expect(greetingReply("hello", new Date(2026, 0, 1, 9))).toBe("Good morning. How can I help?");
    expect(greetingReply("hello", new Date(2026, 0, 1, 14))).toBe("Good afternoon. How can I help?");
    expect(greetingReply("hello", new Date(2026, 0, 1, 20))).toBe("Good evening. How can I help?");
    expect(greetingReply("howfar")).toContain("How are you");
  });
});

describe("Nigerian English and Pidgin", () => {
  it("rewrites common expressions to plain English for routing", () => {
    expect(normalizeNaija("Abeg open Chrome for me")).toBe("please open chrome for me");
    expect(normalizeNaija("Oga, wetin dey happen?")).toBe("boss what is happening");
    expect(normalizeNaija("I wan call my brother")).toBe("i want call my brother");
    expect(normalizeNaija("No wahala")).toBe("no problem");
    expect(normalizeNaija("I no fit find the file")).toBe("i cannot find the file");
    expect(normalizeNaija("make you send the message")).toBe("please send the message");
  });
  it("does not mangle ordinary English", () => {
    expect(normalizeNaija("Open the document and read it")).toBe("open the document and read it");
    expect(normalizeNaija("sefton and abigail went home")).toBe("sefton and abigail went home"); // no partial-word matches
  });
  it("tells greetings, questions, commands and chat apart", () => {
    expect(intentOf("good morning").kind).toBe("greeting");
    expect(intentOf("how far").kind).toBe("greeting");
    expect(intentOf("What time is it?").kind).toBe("question");
    expect(intentOf("how do I reset the router").kind).toBe("question");
    expect(intentOf("open Chrome and search for Django").kind).toBe("command");
    expect(intentOf("abeg open vs code").kind).toBe("command");
    expect(intentOf("please send the file to Dell").kind).toBe("command");
    expect(intentOf("can you open the browser").kind).toBe("command");
    expect(intentOf("I am tired today").kind).toBe("statement");
    expect(intentOf("the weather is nice").kind).toBe("statement");
  });
});

describe("user-taught corrections", () => {
  const rules = [{ heard: "so low", meant: "Solo" }, { heard: "sorry low", meant: "Solo" }, { heard: "salami", meant: "Solomon" }];
  it("fixes whole phrases, case-insensitively", () => {
    expect(applyCorrections("Hey so low open Chrome", rules)).toBe("Hey Solo open Chrome");
    expect(applyCorrections("hi SORRY LOW", rules)).toBe("hi Solo");
    expect(applyCorrections("hey salami", rules)).toBe("hey Solomon");
  });
  it("never changes the middle of another word and ignores empty rules", () => {
    expect(applyCorrections("a solowing example", rules)).toBe("a solowing example");
    expect(applyCorrections("so lowest price", rules)).toBe("so lowest price");
    expect(applyCorrections("keep this", [{ heard: "", meant: "x" }, { heard: "y", meant: "" }])).toBe("keep this");
  });
  it("copes with regex characters in what the user typed", () => {
    expect(applyCorrections("price is $5 (ok)", [{ heard: "$5 (ok)", meant: "five dollars" }])).toBe("price is five dollars");
  });
});
