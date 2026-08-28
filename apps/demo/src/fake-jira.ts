import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  CORS_HEADERS,
  headerValue,
  parseJsonObject,
  readRawBody,
  requestUrl,
  sendJson,
  sendText,
} from "./http.js";

/**
 * A stand-in for a Jira Data Center instance, speaking exactly the REST v2
 * endpoints `@maestro/adapter-jira` calls, with response bodies shaped like
 * the recorded fixtures in `packages/adapter-jira/fixtures` — no invented
 * fields. It also plays the OTHER half of the integration: when a comment is
 * created it delivers a webhook signed with the real HMAC-SHA256 scheme, so
 * Maestro's fail-closed verification is genuinely exercised.
 *
 * It is a DEMO PROP. It stores everything in memory, it authenticates with a
 * throwaway PAT, and it is never part of a deployment.
 */

const API = "/rest/api/2";

export interface JiraUser {
  name: string;
  key: string;
  emailAddress: string;
  displayName: string;
  active: boolean;
}

const USERS: Record<string, JiraUser> = {
  "ayse.kaya": {
    name: "ayse.kaya",
    key: "JIRAUSER10201",
    emailAddress: "ayse.kaya@bank.example",
    displayName: "Ayşe Kaya",
    active: true,
  },
  "mert.demir": {
    name: "mert.demir",
    key: "JIRAUSER10321",
    emailAddress: "mert.demir@bank.example",
    displayName: "Mert Demir",
    active: true,
  },
  "selin.arslan": {
    name: "selin.arslan",
    key: "JIRAUSER10344",
    emailAddress: "selin.arslan@bank.example",
    displayName: "Selin Arslan",
    active: true,
  },
  "maestro-svc": {
    name: "maestro-svc",
    key: "JIRAUSER11000",
    emailAddress: "maestro-svc@bank.example",
    displayName: "Maestro Servis",
    active: true,
  },
};

const GROUPS: Record<string, string[]> = {
  "tech-leads": ["mert.demir", "selin.arslan"],
  "product-owners": ["ayse.kaya"],
};

export interface FakeJiraComment {
  id: string;
  author: string;
  body: string;
  created: string;
  updated: string;
}

/** Jira's three workflow buckets — what colours the status lozenge. */
export type JiraStatusCategory = "new" | "indeterminate" | "done";

export interface FakeJiraIssue {
  id: string;
  key: string;
  projectKey: string;
  summary: string;
  description: string;
  issueType: string;
  /** Stock `priority` field name, e.g. "Yüksek". */
  priority: string;
  /** Stock `status` field name — the workflow step the issue sits on. */
  status: string;
  statusCategory: JiraStatusCategory;
  reporter: string;
  assignee: string | null;
  components: string[];
  labels: string[];
  created: string;
  updated: string;
}

/** Ids/colours DC ships with, so the UI can draw the same lozenge and icon. */
const STATUS_CATEGORIES: Record<JiraStatusCategory, { id: number; colorName: string; name: string }> = {
  new: { id: 2, colorName: "blue-gray", name: "To Do" },
  indeterminate: { id: 4, colorName: "yellow", name: "In Progress" },
  done: { id: 3, colorName: "green", name: "Done" },
};

const PRIORITY_IDS: Record<string, string> = {
  "En yüksek": "1",
  Yüksek: "2",
  Orta: "3",
  Düşük: "4",
  "En düşük": "5",
};

export interface FakeJiraOptions {
  /** PAT the adapter must present as `Authorization: Bearer <pat>`. */
  pat: string;
  /** Shared secret the outgoing webhook signature is computed with. */
  webhookSecret: string;
  /** Where webhooks go; a function so the target port may be bound later. */
  webhookUrl: () => string | null;
  issue: Omit<FakeJiraIssue, "id" | "created" | "updated" | "priority" | "status" | "statusCategory"> &
    Partial<Pick<FakeJiraIssue, "created" | "updated" | "priority" | "status" | "statusCategory">>;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface FakeJira {
  server: Server;
  /** Adds a comment as a human would in the Jira UI, webhook included. */
  addHumanComment(author: string, body: string): Promise<FakeJiraComment>;
  state(): { issue: FakeJiraIssue; comments: Array<FakeJiraComment & { displayName: string }> };
  /** Deliveries that failed to reach Maestro — surfaced, never swallowed. */
  webhookErrors: string[];
}

/** Jira DC serialises timestamps with an RFC-822 style offset: `+0300`. */
export function jiraDateTime(date: Date): string {
  const shifted = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return `${shifted.toISOString().replace(/Z$/, "")}+0300`;
}

function userOrThrow(name: string): JiraUser {
  const user = USERS[name];
  if (!user) throw new Error(`fake Jira: unknown user "${name}"`);
  return user;
}

function userJson(user: JiraUser, base: string): Record<string, unknown> {
  return {
    self: `${base}/rest/api/2/user?username=${user.name}`,
    name: user.name,
    key: user.key,
    emailAddress: user.emailAddress,
    displayName: user.displayName,
    active: user.active,
    timeZone: "Europe/Istanbul",
  };
}

export function createFakeJira(options: FakeJiraOptions): FakeJira {
  const now = options.now ?? ((): Date => new Date());
  const nowText = (): string => jiraDateTime(now());
  const webhookErrors: string[] = [];

  const issue: FakeJiraIssue = {
    ...options.issue,
    id: "10501",
    priority: options.issue.priority ?? "Yüksek",
    status: options.issue.status ?? "Geliştirmede",
    statusCategory: options.issue.statusCategory ?? "indeterminate",
    created: options.issue.created ?? nowText(),
    updated: options.issue.updated ?? nowText(),
  };
  const comments: FakeJiraComment[] = [];
  let nextCommentId = 45200;
  let nextIssueId = 10688;
  let nextIssueNumber = 612;
  let base = "http://127.0.0.1";

  const priorityJson = (): Record<string, unknown> => ({
    self: `${base}${API}/priority/${PRIORITY_IDS[issue.priority] ?? "3"}`,
    id: PRIORITY_IDS[issue.priority] ?? "3",
    name: issue.priority,
  });

  const statusJson = (): Record<string, unknown> => {
    const category = STATUS_CATEGORIES[issue.statusCategory];
    return {
      self: `${base}${API}/status/${category.id}`,
      id: String(category.id),
      name: issue.status,
      statusCategory: {
        self: `${base}${API}/statuscategory/${category.id}`,
        id: category.id,
        key: issue.statusCategory,
        colorName: category.colorName,
        name: category.name,
      },
    };
  };

  const issueJson = (): Record<string, unknown> => ({
    expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
    id: issue.id,
    self: `${base}${API}/issue/${issue.id}`,
    key: issue.key,
    fields: {
      summary: issue.summary,
      description: issue.description,
      issuetype: {
        self: `${base}${API}/issuetype/10001`,
        id: "10001",
        description: "A user story",
        name: issue.issueType,
        subtask: false,
      },
      priority: priorityJson(),
      status: statusJson(),
      project: {
        self: `${base}${API}/project/10100`,
        id: "10100",
        key: issue.projectKey,
        name: "Ugur Payments",
        projectTypeKey: "software",
      },
      reporter: userJson(userOrThrow(issue.reporter), base),
      assignee: issue.assignee === null ? null : userJson(userOrThrow(issue.assignee), base),
      components: issue.components.map((name, index) => ({
        self: `${base}${API}/component/${10310 + index}`,
        id: String(10310 + index),
        name,
      })),
      labels: issue.labels,
      parent: null,
      created: issue.created,
      updated: issue.updated,
    },
  });

  const commentJson = (comment: FakeJiraComment): Record<string, unknown> => ({
    self: `${base}${API}/issue/${issue.id}/comment/${comment.id}`,
    id: comment.id,
    author: userJson(userOrThrow(comment.author), base),
    body: comment.body,
    updateAuthor: userJson(userOrThrow(comment.author), base),
    created: comment.created,
    updated: comment.updated,
  });

  /**
   * Deliver a `comment_created` webhook, signed the way Jira DC signs one.
   * Fire-and-forget on purpose: a real Jira does not block a comment on the
   * consumer answering, and a failed delivery is recorded rather than hidden.
   */
  function emitCommentWebhook(comment: FakeJiraComment): void {
    const target = options.webhookUrl();
    if (target === null) return;
    const payload = {
      timestamp: now().getTime(),
      webhookEvent: "comment_created",
      comment: commentJson(comment),
      issue: {
        id: issue.id,
        self: `${base}${API}/issue/${issue.id}`,
        key: issue.key,
        fields: {
          summary: issue.summary,
          issuetype: { id: "10001", name: issue.issueType, subtask: false },
          project: { id: "10100", key: issue.projectKey, name: "Ugur Payments" },
          labels: issue.labels,
          priority: priorityJson(),
          status: statusJson(),
        },
      },
    };
    const raw = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", options.webhookSecret).update(raw, "utf8").digest("hex")}`;
    void fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature": signature },
      body: raw,
    })
      .then(async (response) => {
        if (!response.ok) webhookErrors.push(`webhook ${response.status}: ${await response.text()}`);
      })
      .catch((error: unknown) => {
        webhookErrors.push(String(error));
        options.onError?.(error);
      });
  }

  function addComment(author: string, body: string): FakeJiraComment {
    const at = nowText();
    const comment: FakeJiraComment = { id: String(nextCommentId++), author, body, created: at, updated: at };
    comments.push(comment);
    issue.updated = at;
    return comment;
  }

  function authorized(req: IncomingMessage): boolean {
    return headerValue(req, "authorization") === `Bearer ${options.pat}`;
  }

  function groupPage(url: URL): Record<string, unknown> {
    const groupName = url.searchParams.get("groupname") ?? "";
    const startAt = Number(url.searchParams.get("startAt") ?? "0");
    const maxResults = Number(url.searchParams.get("maxResults") ?? "50");
    const members = (GROUPS[groupName] ?? []).map((name) => userJson(userOrThrow(name), base));
    const page = members.slice(startAt, startAt + maxResults);
    return {
      self: `${base}${API}/group/member?groupname=${encodeURIComponent(groupName)}&startAt=${startAt}`,
      maxResults,
      startAt,
      total: members.length,
      isLast: startAt + page.length >= members.length,
      values: page,
    };
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      options.onError?.(error);
      sendJson(res, 500, { errorMessages: [String(error)] });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = requestUrl(req);
    const path = url.pathname;
    const method = req.method ?? "GET";
    base = `http://${req.headers.host ?? "127.0.0.1"}`;

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // ---- demo-only surface: what the browser (i.e. "a person in Jira") uses.
    if (path === "/_demo/state" && method === "GET") {
      sendJson(res, 200, {
        project: { key: issue.projectKey, name: "Ugur Payments" },
        issue,
        // The browser draws a Jira issue screen, which names people rather
        // than usernames — so the directory travels with the payload.
        users: Object.fromEntries(
          Object.entries(USERS).map(([name, user]) => [name, { name, displayName: user.displayName }]),
        ),
        comments: comments.map((comment) => ({
          ...comment,
          displayName: userOrThrow(comment.author).displayName,
        })),
      }, CORS_HEADERS);
      return;
    }
    if (path === "/_demo/comment" && method === "POST") {
      const body = parseJsonObject(await readRawBody(req));
      const author = typeof body?.["author"] === "string" ? body["author"] : "";
      const text = typeof body?.["body"] === "string" ? body["body"] : "";
      if (!USERS[author] || text.trim().length === 0) {
        sendJson(res, 400, { errorMessages: ["author and body are required"] }, CORS_HEADERS);
        return;
      }
      const comment = addComment(author, text);
      sendJson(res, 201, commentJson(comment), CORS_HEADERS);
      emitCommentWebhook(comment);
      return;
    }

    // ---- the real Jira DC REST surface the adapter speaks to.
    if (!path.startsWith(API)) {
      sendText(res, 404, "not found");
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { errorMessages: ["invalid PAT"], errors: {} });
      return;
    }

    const rest = path.slice(API.length);
    const raw = method === "GET" ? "" : await readRawBody(req);
    const body = raw.length > 0 ? parseJsonObject(raw) : null;

    const commentMatch = /^\/issue\/([^/]+)\/comment(?:\/([^/]+))?$/.exec(rest);
    if (commentMatch) {
      const key = decodeURIComponent(commentMatch[1] ?? "");
      if (key !== issue.key) {
        sendJson(res, 404, { errorMessages: [`issue ${key} not found`] });
        return;
      }
      const text = typeof body?.["body"] === "string" ? body["body"] : "";
      if (method === "POST") {
        const comment = addComment("maestro-svc", text);
        sendJson(res, 201, commentJson(comment));
        emitCommentWebhook(comment);
        return;
      }
      if (method === "PUT" && commentMatch[2] !== undefined) {
        const target = comments.find((comment) => comment.id === commentMatch[2]);
        if (!target) {
          sendJson(res, 404, { errorMessages: ["comment not found"] });
          return;
        }
        target.body = text;
        target.updated = nowText();
        sendJson(res, 200, commentJson(target));
        return;
      }
    }

    if (rest === "/issue" && method === "POST") {
      const fields = (body?.["fields"] ?? {}) as Record<string, unknown>;
      const key = `${issue.projectKey}-${nextIssueNumber++}`;
      const summary = typeof fields["summary"] === "string" ? fields["summary"] : "";
      if (summary.trim().length === 0) {
        sendJson(res, 400, { errorMessages: ["summary is required"] });
        return;
      }
      const id = String(nextIssueId++);
      sendJson(res, 201, { id, key, self: `${base}${API}/issue/${id}` });
      return;
    }

    if (rest === "/issueLink" && method === "POST") {
      const type = (body?.["type"] ?? {}) as Record<string, unknown>;
      if (typeof type["name"] !== "string") {
        sendJson(res, 400, { errorMessages: ["link type is required"] });
        return;
      }
      res.writeHead(201);
      res.end();
      return;
    }

    if (rest === "/group/member" && method === "GET") {
      sendJson(res, 200, groupPage(url));
      return;
    }

    const assigneeMatch = /^\/issue\/([^/]+)\/assignee$/.exec(rest);
    if (assigneeMatch && method === "PUT") {
      const name = body?.["name"];
      if (name !== null && typeof name !== "string") {
        sendJson(res, 400, { errorMessages: ["name must be a string or null"] });
        return;
      }
      issue.assignee = name === null ? null : name;
      issue.updated = nowText();
      res.writeHead(204);
      res.end();
      return;
    }

    const issueMatch = /^\/issue\/([^/]+)$/.exec(rest);
    if (issueMatch) {
      const key = decodeURIComponent(issueMatch[1] ?? "");
      if (key !== issue.key) {
        sendJson(res, 404, { errorMessages: [`issue ${key} not found`] });
        return;
      }
      if (method === "GET") {
        sendJson(res, 200, issueJson());
        return;
      }
      if (method === "PUT") {
        const fields = (body?.["fields"] ?? {}) as Record<string, unknown>;
        const labels = fields["labels"];
        if (Array.isArray(labels)) {
          issue.labels = labels.filter((label): label is string => typeof label === "string");
        }
        issue.updated = nowText();
        res.writeHead(204);
        res.end();
        return;
      }
    }

    sendJson(res, 404, { errorMessages: [`no fake Jira route for ${method} ${path}`] });
  }

  return {
    server,
    addHumanComment(author: string, body: string): Promise<FakeJiraComment> {
      const comment = addComment(author, body);
      emitCommentWebhook(comment);
      return Promise.resolve(comment);
    },
    state() {
      return {
        issue: { ...issue },
        comments: comments.map((comment) => ({
          ...comment,
          displayName: userOrThrow(comment.author).displayName,
        })),
      };
    },
    webhookErrors,
  };
}
