import { Octokit } from "@octokit/rest";

/** API version that exposes the Enterprise Cost Center and Enterprise Teams endpoints. */
const GITHUB_API_VERSION = "2026-03-10";

/** GitHub limits cost-center resource mutations to 50 entries per request. */
const RESOURCE_BATCH_SIZE = 50;

export interface CostCenterResource {
  type: string;
  name: string;
}

export interface CostCenter {
  id: string;
  name: string;
  state?: string;
  resources?: CostCenterResource[];
}

export interface Team {
  /** Stable slug used for membership lookups. */
  slug: string;
  /** Human-readable name (falls back to slug). */
  name: string;
  /** Numeric team id. Used for enterprise team membership lookups because
   *  enterprise team slugs are prefixed with "ent:" and the colon is not
   *  accepted on the memberships sub-resource path. */
  id?: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export class GitHubClient {
  private readonly octokit: Octokit;
  /** Cache of enterprise slug -> (team slug -> team id), populated lazily. */
  private enterpriseTeamIds = new Map<string, Map<string, number>>();

  constructor(token: string) {
    if (!token) {
      throw new Error("A GitHub token is required (set GH_TOKEN).");
    }
    this.octokit = new Octokit({ auth: token });
  }

  private costCenterHeaders() {
    return { "X-GitHub-Api-Version": GITHUB_API_VERSION };
  }

  // ---- Cost centers -------------------------------------------------------

  async listCostCenters(enterprise: string): Promise<CostCenter[]> {
    const res = await this.octokit.request(
      "GET /enterprises/{enterprise}/settings/billing/cost-centers",
      { enterprise, state: "active", headers: this.costCenterHeaders() },
    );
    return (res.data as { costCenters?: CostCenter[] }).costCenters ?? [];
  }

  async getCostCenter(enterprise: string, costCenterId: string): Promise<CostCenter> {
    const res = await this.octokit.request(
      "GET /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}",
      {
        enterprise,
        cost_center_id: costCenterId,
        headers: this.costCenterHeaders(),
      },
    );
    return res.data as CostCenter;
  }

  async createCostCenter(enterprise: string, name: string): Promise<CostCenter> {
    const res = await this.octokit.request(
      "POST /enterprises/{enterprise}/settings/billing/cost-centers",
      { enterprise, name, headers: this.costCenterHeaders() },
    );
    return res.data as CostCenter;
  }

  /** Returns the logins currently assigned to a cost center. */
  async getCostCenterUsers(enterprise: string, costCenterId: string): Promise<string[]> {
    const costCenter = await this.getCostCenter(enterprise, costCenterId);
    return (costCenter.resources ?? [])
      .filter((resource) => resource.type.toLowerCase() === "user")
      .map((resource) => resource.name);
  }

  async addUsersToCostCenter(
    enterprise: string,
    costCenterId: string,
    users: string[],
  ): Promise<void> {
    for (const batch of chunk(users, RESOURCE_BATCH_SIZE)) {
      await this.octokit.request(
        "POST /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource",
        {
          enterprise,
          cost_center_id: costCenterId,
          users: batch,
          headers: this.costCenterHeaders(),
        },
      );
    }
  }

  async removeUsersFromCostCenter(
    enterprise: string,
    costCenterId: string,
    users: string[],
  ): Promise<void> {
    for (const batch of chunk(users, RESOURCE_BATCH_SIZE)) {
      await this.octokit.request(
        "DELETE /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource",
        {
          enterprise,
          cost_center_id: costCenterId,
          users: batch,
          headers: this.costCenterHeaders(),
        },
      );
    }
  }

  // ---- Teams --------------------------------------------------------------

  async listEnterpriseTeams(enterprise: string): Promise<Team[]> {
    const teams = await this.octokit.paginate(
      "GET /enterprises/{enterprise}/teams",
      {
        enterprise,
        per_page: 100,
        headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION },
      },
    );
    const mapped = (teams as Array<{ id: number; slug: string; name?: string }>).map((team) => ({
      id: team.id,
      slug: team.slug,
      name: team.name ?? team.slug,
    }));
    // Refresh the slug -> id cache so membership lookups can use the id.
    const bySlug = new Map<string, number>();
    for (const team of mapped) {
      bySlug.set(team.slug, team.id);
    }
    this.enterpriseTeamIds.set(enterprise, bySlug);
    return mapped;
  }

  /** Resolve an enterprise team slug to its numeric id, listing teams if needed. */
  private async resolveEnterpriseTeamId(enterprise: string, teamSlug: string): Promise<number> {
    if (!this.enterpriseTeamIds.has(enterprise)) {
      await this.listEnterpriseTeams(enterprise);
    }
    const id = this.enterpriseTeamIds.get(enterprise)?.get(teamSlug);
    if (id === undefined) {
      throw new Error(`enterprise team "${teamSlug}" not found in enterprise "${enterprise}"`);
    }
    return id;
  }

  async listEnterpriseTeamMembers(enterprise: string, teamSlug: string): Promise<string[]> {
    // Use the numeric id (accepted in place of the slug) to avoid the colon in
    // "ent:"-prefixed slugs breaking the memberships sub-resource path.
    const teamId = await this.resolveEnterpriseTeamId(enterprise, teamSlug);
    const memberships = await this.octokit.paginate(
      "GET /enterprises/{enterprise}/teams/{enterprise_team}/memberships",
      {
        enterprise,
        enterprise_team: String(teamId),
        per_page: 100,
        headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION },
      },
    );
    return (memberships as Array<{ login?: string; user?: { login: string } }>)
      .map((m) => m.login ?? m.user?.login)
      .filter((login): login is string => Boolean(login));
  }

  async listOrgTeams(org: string): Promise<Team[]> {
    const teams = await this.octokit.paginate(this.octokit.teams.list, {
      org,
      per_page: 100,
    });
    return teams.map((team) => ({ slug: team.slug, name: team.name }));
  }

  async listOrgTeamMembers(org: string, teamSlug: string): Promise<string[]> {
    const members = await this.octokit.paginate(this.octokit.teams.listMembersInOrg, {
      org,
      team_slug: teamSlug,
      per_page: 100,
    });
    return members.map((member) => member.login);
  }
}
