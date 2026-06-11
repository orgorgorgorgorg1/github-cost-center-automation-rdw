import { Octokit } from "@octokit/rest";

/** API version that exposes the Enterprise Cost Center billing endpoints. */
const COST_CENTER_API_VERSION = "2026-03-10";

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

  constructor(token: string) {
    if (!token) {
      throw new Error("A GitHub token is required (set GH_TOKEN).");
    }
    this.octokit = new Octokit({ auth: token });
  }

  private costCenterHeaders() {
    return { "X-GitHub-Api-Version": COST_CENTER_API_VERSION };
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
      { enterprise, per_page: 100 },
    );
    return (teams as Array<{ slug: string; name?: string }>).map((team) => ({
      slug: team.slug,
      name: team.name ?? team.slug,
    }));
  }

  async listEnterpriseTeamMembers(enterprise: string, teamSlug: string): Promise<string[]> {
    const memberships = await this.octokit.paginate(
      "GET /enterprises/{enterprise}/teams/{team_slug}/memberships",
      { enterprise, team_slug: teamSlug, per_page: 100 },
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
