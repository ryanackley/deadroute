/**
 * HTTP client for Atlassian Cloud REST APIs.
 * Uses Node built-in fetch with Basic Auth.
 */

export interface AtlassianUserResponse {
  accountId: string;
  displayName: string;
  emailAddress: string;
  active: boolean;
}

export interface AtlassianProjectResponse {
  id: number;
  key: string;
  name: string;
  self: string;
}

export interface ConfluenceSpaceResponse {
  id: string;
  key: string;
  name: string;
  status: string;
}

export interface IssueTypeResponse {
  issueTypes:[{
  id: string;
  name: string;
  description: string;
  subtask: boolean;
  hierarchyLevel: number;
  }]
}

export interface StatusDetail {
  id: string;
  name: string;
  description: string;
  statusCategory: { id: number; key: string; name: string };
}

export interface ProjectStatusResponse {
  id: string;
  name: string;
  subtask: boolean;
  statuses: StatusDetail[];
}

export interface CreatedIssueResponse {
  id: string;
  key: string;
  self: string;
}

export interface JiraIssueApiResponse {
  id: string;
  key: string;
  self: string;
  fields: Record<string, unknown>;
  names?: Record<string, string>;
}

export interface TransitionResponse {
  id: string;
  name: string;
  to: { id: string; name: string };
  hasScreen: boolean;
  isAvailable: boolean;
}

export interface ConfluencePageResponse {
  id: string;
  title: string;
  status: string;
  spaceId: string;
  parentId: string | null;
  authorId: string;
  version: { number: number; createdAt: string };
  body?: {
    atlas_doc_format?: { representation: string; value: string };
  };
}

export class AtlassianClient {
  private host: string;
  private authHeader: string;

  constructor(host: string, email: string, apiToken: string) {
    this.host = host.replace(/\/+$/, "");
    this.authHeader =
      "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  }

  // ---- Low-level request with retry on 429 ----

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.host}${path}`;
    let retries = 0;
    const maxRetries = 3;

    while (true) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429 && retries < maxRetries) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
        retries++;
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new AtlassianApiError(method, path, res.status, text);
      }

      // 204 No Content
      if (res.status === 204) return undefined as T;

      return (await res.json()) as T;
    }
  }

  // ---- User APIs (Jira REST v3) ----

  async getMyself(): Promise<AtlassianUserResponse> {
    return this.request<AtlassianUserResponse>("GET", "/rest/api/3/myself");
  }

  async createUser(
    emailAddress: string,
    displayName: string,
    products: string[],
  ): Promise<AtlassianUserResponse> {
    return this.request<AtlassianUserResponse>("POST", "/rest/api/3/user", {
      emailAddress,
      displayName,
      products,
    });
  }

  async searchUsers(query: string): Promise<AtlassianUserResponse[]> {
    return this.request<AtlassianUserResponse[]>(
      "GET",
      `/rest/api/3/user/search?query=${encodeURIComponent(query)}`,
    );
  }

  // ---- Project APIs (Jira REST v3) ----

  async createProject(params: {
    key: string;
    name: string;
    projectTypeKey: "software" | "service_desk";
    projectTemplateKey: string;
    leadAccountId: string;
    description?: string;
  }): Promise<AtlassianProjectResponse> {
    return this.request<AtlassianProjectResponse>(
      "POST",
      "/rest/api/3/project",
      params,
    );
  }

  async searchProjects(): Promise<{ values: AtlassianProjectResponse[] }> {
    return this.request<{ values: AtlassianProjectResponse[] }>(
      "GET",
      "/rest/api/3/project/search",
    );
  }

  // ---- Issue CRUD APIs (Jira REST v3) ----

  async getIssueTypesForProject(
    projectKey: string,
  ): Promise<IssueTypeResponse> {
    return this.request<IssueTypeResponse>(
      "GET",
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
    );
  }

  async getProjectStatuses(
    projectKey: string,
  ): Promise<ProjectStatusResponse[]> {
    return this.request<ProjectStatusResponse[]>(
      "GET",
      `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`,
    );
  }

  async createIssue(fields: Record<string, unknown>): Promise<CreatedIssueResponse> {
    return this.request<CreatedIssueResponse>(
      "POST",
      "/rest/api/3/issue",
      { fields },
    );
  }

  async getIssue(keyOrId: string): Promise<JiraIssueApiResponse> {
    return this.request<JiraIssueApiResponse>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(keyOrId)}?fields=*all&expand=names`,
    );
  }

  async addComment(
    issueKey: string,
    body: object,
  ): Promise<{ id: string; self: string }> {
    return this.request<{ id: string; self: string }>(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      { body },
    );
  }

  async getTransitions(
    issueKey: string,
  ): Promise<{ transitions: TransitionResponse[] }> {
    return this.request<{ transitions: TransitionResponse[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
  }

  async doTransition(
    issueKey: string,
    transitionId: string,
  ): Promise<void> {
    return this.request<void>(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
      { transition: { id: transitionId } },
    );
  }

  async createIssueLink(
    inwardKey: string,
    outwardKey: string,
    linkType: string,
  ): Promise<void> {
    return this.request<void>(
      "POST",
      "/rest/api/3/issueLink",
      {
        type: { name: linkType },
        inwardIssue: { key: inwardKey },
        outwardIssue: { key: outwardKey },
      },
    );
  }

  // ---- Confluence Page APIs (v2) ----

  async createPage(params: {
    spaceId: string;
    title: string;
    body: { representation: "atlas_doc_format"; value: string };
    parentId?: string;
    status?: "current" | "draft";
  }): Promise<ConfluencePageResponse> {
    return this.request<ConfluencePageResponse>(
      "POST",
      "/wiki/api/v2/pages",
      {
        spaceId: params.spaceId,
        title: params.title,
        parentId: params.parentId,
        status: params.status || "current",
        body: params.body,
      },
    );
  }

  async getPageByTitle(
    spaceId: string,
    title: string,
  ): Promise<ConfluencePageResponse | null> {
    const result = await this.request<{ results: ConfluencePageResponse[] }>(
      "GET",
      `/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/pages?title=${encodeURIComponent(title)}`,
    );
    return result.results[0] || null;
  }

  async getPage(pageId: string): Promise<ConfluencePageResponse> {
    return this.request<ConfluencePageResponse>(
      "GET",
      `/wiki/api/v2/pages/${encodeURIComponent(pageId)}?body-format=atlas_doc_format`,
    );
  }

  async addPageComment(
    pageId: string,
    body: { representation: "atlas_doc_format"; value: string },
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>(
      "POST",
      "/wiki/api/v2/footer-comments",
      { pageId, body },
    );
  }

  // ---- Reactions (internal APIs) ----

  async addJiraCommentReaction(params: {
    cloudId: string;
    issueId: string;
    commentId: string;
    emojiId: string; // Unicode code point hex, e.g. "2764" for ❤️
  }): Promise<void> {
    const url = `${this.host}/gateway/api/reactions/reactions`;

    let retries = 0;
    const maxRetries = 3;

    while (true) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          emojiId: params.emojiId,
          ari: `ari:cloud:jira:${params.cloudId}:comment/${params.commentId}`,
          containerAri: `ari:cloud:jira:${params.cloudId}:issue/${params.issueId}`,
        }),
      });

      if (res.status === 429 && retries < maxRetries) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
        retries++;
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new AtlassianApiError("POST", "/gateway/api/reactions/reactions", res.status, text);
      }

      return;
    }
  }

  // ---- Confluence Reactions (internal GraphQL) ----

  async addConfluenceReaction(params: {
    cloudId: string;
    contentId: number;
    contentType: "PAGE" | "BLOGPOST" | "COMMENT";
    containerId: number;
    containerType: "SPACE";
    emojiId: string; // Unicode code point hex, e.g. "2764" for ❤️
  }): Promise<void> {
    const url = `${this.host}/wiki/cgraphql?q=ReactionsConfluenceSaveReactionMutation`;

    let retries = 0;
    const maxRetries = 3;

    while (true) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify([
          {
            operationName: "ReactionsConfluenceSaveReactionMutation",
            variables: {
              cloudId: params.cloudId,
              contentId: params.contentId,
              contentType: params.contentType,
              containerId: params.containerId,
              containerType: params.containerType,
              emojiId: params.emojiId,
            },
            query: `mutation ReactionsConfluenceSaveReactionMutation($cloudId: ID!, $contentId: Long!, $containerId: Long!, $containerType: ContainerType!, $contentType: GraphQLReactionContentType!, $emojiId: String!) {
  confluence_addReaction(
    cloudId: $cloudId
    input: {contentId: $contentId, containerId: $containerId, containerType: $containerType, contentType: $contentType, emojiId: $emojiId}
  ) {
    ari
    containerAri
    emojiId
    __typename
  }
}`,
          },
        ]),
      });

      if (res.status === 429 && retries < maxRetries) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
        retries++;
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new AtlassianApiError("POST", "/wiki/cgraphql", res.status, text);
      }

      return;
    }
  }

  // ---- Server Info ----

  async getServerInfo(): Promise<{ cloudId: string; baseUrl: string; serverTitle: string }> {
    return this.request<{ cloudId: string; baseUrl: string; serverTitle: string }>(
      "GET",
      "/_edge/tenant_info",
    );
  }

  // ---- Confluence Space APIs (v2) ----

  async createSpace(params: {
    key: string;
    name: string;
    description?: { value: string; representation: "plain" };
  }): Promise<ConfluenceSpaceResponse> {
    return this.request<ConfluenceSpaceResponse>(
      "POST",
      "/wiki/api/v2/spaces",
      params,
    );
  }

  async getSpaces(): Promise<{ results: ConfluenceSpaceResponse[] }> {
    return this.request<{ results: ConfluenceSpaceResponse[] }>(
      "GET",
      "/wiki/api/v2/spaces",
    );
  }

  // ---- Jira Software (Agile) APIs ----

  async getBoards(
    projectKeyOrId?: string,
  ): Promise<{ values: AgileBoardResponse[] }> {
    const params = projectKeyOrId
      ? `?projectKeyOrId=${encodeURIComponent(projectKeyOrId)}`
      : "";
    return this.request<{ values: AgileBoardResponse[] }>(
      "GET",
      `/rest/agile/1.0/board${params}`,
    );
  }

  async getBoardSprints(
    boardId: string,
  ): Promise<{ values: AgileSprintResponse[] }> {
    return this.request<{ values: AgileSprintResponse[] }>(
      "GET",
      `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint`,
    );
  }

  async createSprint(params: {
    name: string;
    originBoardId: number;
    startDate?: string;
    endDate?: string;
    goal?: string;
  }): Promise<AgileSprintResponse> {
    return this.request<AgileSprintResponse>(
      "POST",
      "/rest/agile/1.0/sprint",
      params,
    );
  }

  async updateSprint(
    sprintId: string,
    params: {
      state?: string;
      name?: string;
      startDate?: string;
      endDate?: string;
      goal?: string;
    },
  ): Promise<AgileSprintResponse> {
    return this.request<AgileSprintResponse>(
      "PUT",
      `/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}`,
      params,
    );
  }

  async moveIssuesToSprint(
    sprintId: string,
    issueKeys: string[],
  ): Promise<void> {
    return this.request<void>(
      "POST",
      `/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}/issue`,
      { issues: issueKeys },
    );
  }

  async moveIssuesToBacklog(
    issueKeys: string[],
  ): Promise<void> {
    return this.request<void>(
      "POST",
      "/rest/agile/1.0/backlog/issue",
      { issues: issueKeys },
    );
  }
}

// ---- Agile API response types ----

export interface AgileBoardResponse {
  id: number;
  name: string;
  type: string;
  self: string;
}

export interface AgileSprintResponse {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  originBoardId?: number;
  goal?: string;
  self: string;
}

export class AtlassianApiError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body}`);
    this.name = "AtlassianApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
