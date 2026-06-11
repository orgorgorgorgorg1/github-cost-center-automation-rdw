import { resolve } from "node:path";
import { loadSettings } from "./lib/config.js";
import { GitHubClient } from "./lib/github.js";
import { loadMapping, saveMapping, teamKey, type TeamEntry } from "./lib/mapping.js";

const SETTINGS_PATH = resolve("config/settings.yml");
const MAPPING_PATH = resolve("mappings/team-cost-centers.yml");

async function discoverLiveTeams(
  client: GitHubClient,
  enterprise: string,
  organizations: string[],
): Promise<TeamEntry[]> {
  const live: TeamEntry[] = [];

  const enterpriseTeams = await client.listEnterpriseTeams(enterprise);
  for (const team of enterpriseTeams) {
    live.push({ type: "enterprise", team: team.slug });
  }

  for (const org of organizations) {
    const orgTeams = await client.listOrgTeams(org);
    for (const team of orgTeams) {
      live.push({ type: "organization", org, team: team.slug });
    }
  }

  return live;
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";

  const settings = loadSettings(SETTINGS_PATH);
  const mapping = loadMapping(MAPPING_PATH);
  const client = new GitHubClient(token);

  const liveTeams = await discoverLiveTeams(client, settings.enterprise, settings.organizations);
  const liveByKey = new Map(liveTeams.map((team) => [teamKey(team), team]));
  const mappedByKey = new Map(mapping.teams.map((entry) => [teamKey(entry), entry]));

  const added: string[] = [];
  const removed: string[] = [];
  const nextEntries: TeamEntry[] = [];

  // Keep existing entries whose team still exists; drop the rest.
  for (const entry of mapping.teams) {
    if (liveByKey.has(teamKey(entry))) {
      nextEntries.push(entry);
    } else {
      removed.push(teamKey(entry));
    }
  }

  // Append teams that exist but are not yet mapped, defaulting their cost center.
  for (const [key, team] of liveByKey) {
    if (!mappedByKey.has(key)) {
      nextEntries.push({ ...team, costCenter: settings.defaultCostCenter });
      added.push(key);
    }
  }

  if (added.length === 0 && removed.length === 0) {
    console.log("No drift detected. Mapping is up to date.");
    return;
  }

  saveMapping(MAPPING_PATH, { teams: nextEntries });

  console.log(`Updated mapping: +${added.length} -${removed.length}`);
  if (added.length) console.log(`Added:\n  ${added.join("\n  ")}`);
  if (removed.length) console.log(`Removed:\n  ${removed.join("\n  ")}`);

  // Expose a summary for the workflow (PR body / step summary).
  const summary = [
    added.length ? `### Added teams (defaulted to \`${settings.defaultCostCenter}\`)\n` +
      added.map((k) => `- \`${k}\``).join("\n") : "",
    removed.length ? `### Removed teams (no longer exist)\n` +
      removed.map((k) => `- \`${k}\``).join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=true\n`);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `summary<<EOF\n${summary}\nEOF\n`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
