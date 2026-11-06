import { z } from "zod";

export const Mode = z.enum(["conversation", "work", "study", "agent"]);
export type Mode = z.infer<typeof Mode>;

export const AgentTarget = z.enum(["windows", "android"]);
export type AgentTarget = z.infer<typeof AgentTarget>;

export const Risk = z.enum(["safe", "confirm", "forbidden"]);
export type Risk = z.infer<typeof Risk>;

/** Concrete operations an agent may be asked to perform. The model never emits raw shell. */
export const ActionKind = z.enum([
  "app.launch",
  "app.close",
  "file.read",
  "file.write",
  "file.move",
  "file.delete",
  "doc.create_pdf",
  "doc.create_pptx",
  "shell.run",
  "input.type",
  "input.click",
  "browser.open",
  "notification.read",
  "notification.reply",
  "media.control",
  "call.accept",
  "call.reject",
  "call.dial",
  "message.send",
]);
export type ActionKind = z.infer<typeof ActionKind>;

export const Action = z.object({
  kind: ActionKind,
  args: z.record(z.unknown()),
});
export type Action = z.infer<typeof Action>;

export const TaskStatus = z.enum([
  "queued",
  "awaiting_confirmation",
  "running",
  "done",
  "failed",
  "cancelled",
]);

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  target: AgentTarget,
  actions: z.array(Action),
  status: TaskStatus,
  checkpoint: z.record(z.unknown()).optional(), // saved before session timeout; never discarded
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Task = z.infer<typeof Task>;
