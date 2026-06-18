import { resolve } from "node:path";
import { loadSettings } from "./lib/config.js";
import { GitHubClient, type CostCenter } from "./lib/github.js";
import { loadMapping, teamKey, type TeamEntry } from "./lib/mapping.js";

const SETTINGS_PATH = resolve("config/settings.yml");
const MAPPING_PATH = resolve("mappings/team-cost-centers.yml");

/** A user resolved to a cost center, with the team that placed them there. */
interface Assignment {
  user: string;
  costCenter: string;
  team: string;
}

/** A user claimed by more than one cost center across the mapping. */
interface Conflict {
  user: string;
  claims: { costCenter: string; team: string }[];
}

function difference(a: string[], b: Set<string>): string[] {
  return a.filter((item) => !b.has(item));
}

async function resolveTeamMembers(
  client: GitHubClient,
  enterprise: string,
  entry: TeamEntry,
): Promise<string[]> {
  if (entry.type === "enterprise") {
    return client.listEnterpriseTeamMembers(enterprise, entry.team);
  }
  // org is guaranteed present for organization entries by schema validation.
  return client.listOrgTeamMembers(entry.org!, entry.team);
}

/**
 * Phase 1: resolve every team's members into flat (user, costCenter, team) tuples.
 *
 * A team that cannot be resolved (e.g. a system-managed enterprise team whose
 * membership endpoint returns 404) is reported and skipped rather than aborting
 * the whole run.
 */
async function resolveAssignments(
  client: GitHubClient,
  enterprise: string,
  mapping: { teams: TeamEntry[] },
  defaultCostCenter: string,
): Promise<{ assignments: Assignment[]; failedTeams: string[]; taintedCostCenters: Set<string> }> {
  const assignments: Assignment[] = [];
  const failedTeams: string[] = [];
  // Cost centers targeted by a team we could not resolve. They are skipped in
  // the sync phase: with an incomplete member list we could wrongly remove
  // legitimate users.
  const taintedCostCenters = new Set<string>();
  for (const entry of mapping.teams) {
    const costCenter = entry.costCenter ?? defaultCostCenter;
    const team = teamKey(entry);
    try {
      const members = await resolveTeamMembers(client, enterprise, entry);
      console.log(`- ${team} -> "${costCenter}" (${members.length} member(s))`);
      for (const user of members) {
        assignments.push({ user, costCenter, team });
      }
    } catch (error) {
      failedTeams.push(team);
      taintedCostCenters.add(costCenter);
      console.error(`- ${team}: SKIPPED, could not resolve members: ${(error as Error).message}`);
    }
  }
  return { assignments, failedTeams, taintedCostCenters };
}

/**
 * Phase 2: fold assignments into a single user -> cost center decision and
 * detect users claimed by more than one cost center.
 *
 * Multiple teams mapping a user to the *same* cost center is fine (union); a
 * user mapped to *different* cost centers is a conflict, because a user can
 * belong to only one cost center.
 */
function buildDesiredState(assignments: Assignment[]): {
  desired: Map<string, string>;
  conflicts: Conflict[];
} {
  // user -> (costCenter -> teams that placed them there)
  const claims = new Map<string, Map<string, string[]>>();
  for (const { user, costCenter, team } of assignments) {
    const byCostCenter = claims.get(user) ?? new Map<string, string[]>();
    const teams = byCostCenter.get(costCenter) ?? [];
    teams.push(team);
    byCostCenter.set(costCenter, teams);
    claims.set(user, byCostCenter);
  }

  const desired = new Map<string, string>();
  const conflicts: Conflict[] = [];
  for (const [user, byCostCenter] of claims) {
    if (byCostCenter.size === 1) {
      desired.set(user, [...byCostCenter.keys()][0]);
    } else {
      conflicts.push({
        user,
        claims: [...byCostCenter.entries()].map(([costCenter, teams]) => ({
          costCenter,
          team: teams.join(", "),
        })),
      });
    }
  }
  return { desired, conflicts };
}

function reportConflicts(conflicts: Conflict[]): void {
  console.error(
    `\nConflict: ${conflicts.length} user(s) are claimed by multiple cost centers. ` +
      `A user can belong to only one cost center.`,
  );
  for (const { user, claims } of conflicts) {
    console.error(`  - ${user}:`);
    for (const claim of claims) {
      console.error(`      "${claim.costCenter}"  (via ${claim.team})`);
    }
  }
  console.error(
    `\nResolve by removing the user from all but one of the conflicting teams, ` +
      `or by mapping those teams to the same cost center.`,
  );
}

/**
 * Auto-resolve conflicts according to the configured `onConflict` mode and fold
 * the chosen cost center for each conflicted user into the desired state.
 *
 *   defaultCostCenter - assign the user to the default cost center.
 *   firstMatch        - assign the user to the first cost center detected
 *                       (claims are recorded in detection order).
 *
 * The affected users are reported as a warning; the run then continues.
 */
function resolveConflicts(
  desired: Map<string, string>,
  conflicts: Conflict[],
  mode: "defaultCostCenter" | "firstMatch",
  defaultCostCenter: string,
): void {
  console.warn(
    `\nWarning: ${conflicts.length} user(s) are claimed by multiple cost centers; ` +
      `resolving via onConflict="${mode}".`,
  );
  for (const { user, claims } of conflicts) {
    const costCenter = mode === "defaultCostCenter" ? defaultCostCenter : claims[0].costCenter;
    desired.set(user, costCenter);
    console.warn(`  - ${user} -> "${costCenter}"`);
  }
}

/**
 * Phase 3: invert the per-user decision into the desired membership of each
 * cost center referenced by the mapping.
 */
function desiredMembershipByCostCenter(desired: Map<string, string>): Map<string, Set<string>> {
  const byCostCenter = new Map<string, Set<string>>();
  for (const [user, costCenter] of desired) {
    const users = byCostCenter.get(costCenter) ?? new Set<string>();
    users.add(user);
    byCostCenter.set(costCenter, users);
  }
  return byCostCenter;
}

async function resolveOrCreateCostCenter(
  client: GitHubClient,
  enterprise: string,
  name: string,
  existing: CostCenter[],
  dryRun: boolean,
): Promise<CostCenter | undefined> {
  const match = existing.find((cc) => cc.name === name);
  if (match) {
    return match;
  }
  if (dryRun) {
    console.log(`  [dry-run] would create cost center "${name}"`);
    return undefined;
  }
  console.log(`  Creating cost center "${name}"`);
  const created = await client.createCostCenter(enterprise, name);
  existing.push(created);
  return created;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";

  const settings = loadSettings(SETTINGS_PATH);
  const mapping = loadMapping(MAPPING_PATH);
  const client = new GitHubClient(token);

  console.log(
    `Applying ${mapping.teams.length} mapping(s) to enterprise "${settings.enterprise}"` +
      (dryRun ? " (dry-run)" : ""),
  );

  // Phase 1: resolve team members.
  console.log("\nResolving team members...");
  const { assignments, failedTeams, taintedCostCenters } = await resolveAssignments(
    client,
    settings.enterprise,
    mapping,
    settings.defaultCostCenter,
  );

  // Phase 2: build the global user -> cost center decision and detect conflicts.
  const { desired, conflicts } = buildDesiredState(assignments);
  if (conflicts.length > 0) {
    if (settings.onConflict === "stop") {
      reportConflicts(conflicts);
      // Fail before any write so conflicts are resolved by a human.
      process.exitCode = 1;
      return;
    }
    resolveConflicts(desired, conflicts, settings.onConflict, settings.defaultCostCenter);
  }

  // Phase 3: invert into desired membership per cost center.
  const desiredByCostCenter = desiredMembershipByCostCenter(desired);
  console.log(
    `\nResolved ${desired.size} user assignment(s) across ` +
      `${desiredByCostCenter.size} cost center(s).`,
  );
  if (taintedCostCenters.size > 0) {
    console.warn(
      `\nSkipping ${taintedCostCenters.size} cost center(s) because one or more of ` +
        `their teams could not be resolved (avoids removing valid members): ` +
        `${[...taintedCostCenters].map((c) => `"${c}"`).join(", ")}`,
    );
  }

  // Phase 4: sync each referenced cost center exactly once.
  const costCenters = await client.listCostCenters(settings.enterprise);
  let failures = failedTeams.length;

  for (const [name, desiredUsers] of desiredByCostCenter) {
    if (taintedCostCenters.has(name)) {
      continue;
    }
    console.log(`\n- Cost center "${name}" (desired ${desiredUsers.size} user(s))`);
    try {
      const costCenter = await resolveOrCreateCostCenter(
        client,
        settings.enterprise,
        name,
        costCenters,
        dryRun,
      );

      const currentUsers = costCenter
        ? await client.getCostCenterUsers(settings.enterprise, costCenter.id)
        : [];
      const desiredArray = [...desiredUsers];

      const toAdd = difference(desiredArray, new Set(currentUsers));
      const toRemove = difference(currentUsers, desiredUsers);

      console.log(
        `  current=${currentUsers.length} add=${toAdd.length} remove=${toRemove.length}`,
      );

      if (dryRun) {
        if (toAdd.length) console.log(`  [dry-run] would add: ${toAdd.join(", ")}`);
        if (toRemove.length) console.log(`  [dry-run] would remove: ${toRemove.join(", ")}`);
        continue;
      }

      if (!costCenter) {
        throw new Error(`cost center "${name}" could not be resolved`);
      }
      if (toAdd.length) {
        await client.addUsersToCostCenter(settings.enterprise, costCenter.id, toAdd);
      }
      if (toRemove.length) {
        await client.removeUsersFromCostCenter(settings.enterprise, costCenter.id, toRemove);
      }
    } catch (error) {
      failures += 1;
      console.error(`  ERROR: ${(error as Error).message}`);
    }
  }

  const processed = [...desiredByCostCenter.keys()].filter(
    (name) => !taintedCostCenters.has(name),
  ).length;
  console.log(
    `\nDone. ${processed} cost center(s) processed, ` +
      `${failedTeams.length} team(s) skipped, ${failures} failure(s).`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
