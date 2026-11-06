import { describe, expect, it } from "vitest";
import {
  assessAction, checkBudget, isFreeModel, looksSensitive, parseEnvelope, PROTOCOL_VERSION,
} from "./index";

describe("protocol", () => {
  const hb = { v: PROTOCOL_VERSION, id: "m1", ts: 1, from: "dev-12345678", type: "heartbeat", payload: {} };
  it("accepts a valid envelope", () => expect(parseEnvelope(hb)?.type).toBe("heartbeat"));
  it("rejects wrong version", () => expect(parseEnvelope({ ...hb, v: 99 })).toBeNull());
  it("rejects unknown type and garbage", () => {
    expect(parseEnvelope({ ...hb, type: "evil" })).toBeNull();
    expect(parseEnvelope("x")).toBeNull();
  });
});

describe("permission policy", () => {
  it("forbids destructive shell", () => {
    expect(assessAction({ kind: "shell.run", args: { command: "rm -rf /" } })).toBe("forbidden");
    expect(assessAction({ kind: "shell.run", args: { command: "iex (iwr x)" } })).toBe("forbidden");
    expect(assessAction({ kind: "shell.run", args: { command: "" } })).toBe("forbidden");
  });
  it("requires confirmation for ordinary shell and deletes", () => {
    expect(assessAction({ kind: "shell.run", args: { command: "npm test" } })).toBe("confirm");
    expect(assessAction({ kind: "file.delete", args: {} })).toBe("confirm");
  });
  it("allows launching apps", () => expect(assessAction({ kind: "app.launch", args: {} })).toBe("safe"));
  it("blocks personal data actions in guest mode", () => {
    expect(assessAction({ kind: "file.read", args: {} }, "guest")).toBe("forbidden");
    expect(assessAction({ kind: "notification.read", args: {} }, "guest")).toBe("forbidden");
  });
});

describe("budget", () => {
  const b = { monthlyLimitUsd: 5, warnAtFraction: 0.8, hardStop: true };
  it("free calls always pass", () => expect(checkBudget(100, 0, b)).toBe("ok"));
  it("warns near limit", () => expect(checkBudget(3.9, 0.2, b)).toBe("warn"));
  it("blocks over limit with hardStop", () => expect(checkBudget(4.9, 0.2, b)).toBe("blocked"));
  it("detects free models", () => expect(isFreeModel("a/b:free")).toBe(true));
});

describe("memory safety", () => {
  it("flags secrets", () => {
    expect(looksSensitive("my password is hunter22")).toBe(true);
    expect(looksSensitive("key: sk-abcdefghijklmnopqrstu")).toBe(true);
  });
  it("passes normal text", () => expect(looksSensitive("I prefer short answers")).toBe(false));
});
