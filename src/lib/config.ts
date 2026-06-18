import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const settingsSchema = z.object({
  enterprise: z.string().min(1, "enterprise slug is required"),
  defaultCostCenter: z.string().min(1, "defaultCostCenter is required"),
  organizations: z.array(z.string().min(1)).default([]),
  // How to handle a user claimed by more than one cost center:
  //   stop              - report the conflict and abort before any write (default).
  //   defaultCostCenter - assign the user to defaultCostCenter.
  //   firstMatch        - assign the user to the first cost center detected.
  onConflict: z.enum(["stop", "defaultCostCenter", "firstMatch"]).default("stop"),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(path: string): Settings {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw) ?? {};
  return settingsSchema.parse(parsed);
}
