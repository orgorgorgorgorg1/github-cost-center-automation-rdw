import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const settingsSchema = z.object({
  enterprise: z.string().min(1, "enterprise slug is required"),
  defaultCostCenter: z.string().min(1, "defaultCostCenter is required"),
  organizations: z.array(z.string().min(1)).default([]),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(path: string): Settings {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw) ?? {};
  return settingsSchema.parse(parsed);
}
