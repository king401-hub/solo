import { z } from "zod";

export const MemoryCategory = z.enum(["personal", "conversation", "project", "task"]);
export type MemoryCategory = z.infer<typeof MemoryCategory>;

export const Memory = z.object({
  id: z.string(),
  category: MemoryCategory,
  scope: z.enum(["personal", "guest"]).default("personal"), // guest memory is isolated
  title: z.string(),
  content: z.string(),
  project: z.string().optional(),
  excluded: z.boolean().default(false), // user-excluded from retrieval
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Memory = z.infer<typeof Memory>;

/** Content that must never be persisted as memory. Conservative pattern screen. */
const SECRET_PATTERNS = [
  /\bpassword\s*(is|:|=)\s*\S+/i,
  /\b(api[_-]?key|secret|token)\s*(is|:|=)\s*\S{8,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b\d{13,19}\b/, // card-like numbers
];
export const looksSensitive = (text: string) => SECRET_PATTERNS.some((re) => re.test(text));
