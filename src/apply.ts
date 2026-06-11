import { resolve } from "node:path";
import { loadSettings } from "./lib/config.js";
import { GitHubClient, type CostCenter } from "./lib/github.js";
import { loadMapping, teamKey, type TeamEntry } from "./lib/mapping.js";

const SETTINGS_PATH = resolve("config/settings.yml");
const MAPPING_PATH = resolve("mappings/team-cost-centers.yml");

interface PlannedChange {
  team: string;
  costCenter: string;
  toAdd: string[];
  toRemove: string[];
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

  const costCenters = await client.listCostCenters(settings.enterprise);
  const planned: PlannedChange[] = [];
  let failures = 0;

  for (const entry of mapping.teams) {
    const costCenterName = entry.costCenter ?? settings.defaultCostCenter;
    const label = teamKey(entry);
    console.log(`\n- ${label} -> "${costCenterName}"`);

    try {
      const members = await resolveTeamMembers(client, settings.enterprise, entry);
      const costCenter = await resolveOrCreateCostCenter(
        client,
        settings.enterprise,
        costCenterName,
        costCenters,
        dryRun,
      );

      const currentUsers = costCenter
        ? await client.getCostCenterUsers(settings.enterprise, costCenter.id)
        : [];
      const memberSet = new Set(members);
      const currentSet = new Set(currentUsers);

      const toAdd = difference(members, currentSet);
      const toRemove = difference(currentUsers, memberSet);
      planned.push({ team: label, costCenter: costCenterName, toAdd, toRemove });

      console.log(
        `  members=${members.length} current=${currentUsers.length} ` +
          `add=${toAdd.length} remove=${toRemove.length}`,
      );

      if (dryRun) {
        if (toAdd.length) console.log(`  [dry-run] would add: ${toAdd.join(", ")}`);
        if (toRemove.length) console.log(`  [dry-run] would remove: ${toRemove.join(", ")}`);
        continue;
      }

      if (!costCenter) {
        throw new Error(`cost center "${costCenterName}" could not be resolved`);
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

  console.log(`\nDone. ${planned.length} team(s) processed, ${failures} failure(s).`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
