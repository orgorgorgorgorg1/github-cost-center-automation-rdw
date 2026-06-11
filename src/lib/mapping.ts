import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { z } from "zod";

const teamEntrySchema = z
  .object({
    type: z.enum(["enterprise", "organization"]),
    org: z.string().min(1).optional(),
    team: z.string().min(1),
    costCenter: z.string().min(1).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.type === "organization" && !entry.org) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "org is required when type is 'organization'",
        path: ["org"],
      });
    }
    if (entry.type === "enterprise" && entry.org) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "org must not be set when type is 'enterprise'",
        path: ["org"],
      });
    }
  });

const mappingSchema = z.object({
  teams: z.array(teamEntrySchema).default([]),
});

export type TeamEntry = z.infer<typeof teamEntrySchema>;
export type Mapping = z.infer<typeof mappingSchema>;

export function loadMapping(path: string): Mapping {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw) ?? {};
  return mappingSchema.parse(parsed);
}

/**
 * Stable identity for a team entry, used to diff the mapping against live teams.
 * Enterprise teams are keyed by slug; org teams by org + slug.
 */
export function teamKey(entry: Pick<TeamEntry, "type" | "org" | "team">): string {
  return entry.type === "enterprise"
    ? `enterprise:${entry.team}`
    : `organization:${entry.org}:${entry.team}`;
}

const HEADER = `# Central mapping between GitHub teams and Enterprise Cost Centers.
#
# Each entry assigns the members of one team to one cost center.
#   type:       "enterprise" or "organization".
#   org:        Organization slug. Required only when type is "organization".
#   team:       Team slug.
#   costCenter: (optional) Cost center name. When omitted, the default cost
#               center from config/settings.yml is used.
#
# This file is the source of truth. The discovery workflow keeps it in sync with
# the teams that actually exist; the apply workflow pushes its contents to the
# Enterprise Cost Center membership via the GitHub REST API.

`;

/** Sort entries deterministically so generated PRs produce minimal diffs. */
export function sortEntries(entries: TeamEntry[]): TeamEntry[] {
  return [...entries].sort((a, b) => teamKey(a).localeCompare(teamKey(b)));
}

export function saveMapping(path: string, mapping: Mapping): void {
  const ordered: Mapping = { teams: sortEntries(mapping.teams) };
  const body = stringify(ordered, { lineWidth: 0 });
  writeFileSync(path, HEADER + body, "utf8");
}
