// Payloads GitHub minimaux, aux formes réelles des webhooks `issue_comment` et `issues`.

export const INSTALLATION_ID = 4242;
export const repo = { installationId: INSTALLATION_ID, owner: "acme", repo: "sandbox" };

const user = (login: string, type = "User") => ({ id: login.length * 1000 + 7, login, type });

const repository = {
  id: 99,
  name: "sandbox",
  full_name: "acme/sandbox",
  private: true,
  default_branch: "main",
  owner: { id: 1, login: "acme", type: "Organization" },
};

export function issueComment(options: {
  body: string;
  login?: string;
  userType?: string;
  action?: string;
  issueNumber?: number;
  onPullRequest?: boolean;
}) {
  const author = user(options.login ?? "alice", options.userType);
  return {
    action: options.action ?? "created",
    installation: { id: INSTALLATION_ID },
    repository,
    sender: author,
    issue: {
      number: options.issueNumber ?? 1,
      title: "Ajouter un endpoint de santé",
      body: "Il faut un /healthz.",
      ...(options.onPullRequest ? { pull_request: { url: "https://api.github.com/x" } } : {}),
    },
    comment: { id: 555, body: options.body, user: author },
  };
}

export function issues(options: {
  action: string;
  body?: string;
  label?: string;
  login?: string;
  userType?: string;
  issueNumber?: number;
}) {
  return {
    action: options.action,
    installation: { id: INSTALLATION_ID },
    repository,
    sender: user(options.login ?? "alice", options.userType),
    issue: {
      number: options.issueNumber ?? 2,
      title: "Bug de pagination",
      body: options.body ?? "",
    },
    ...(options.label ? { label: { name: options.label } } : {}),
  };
}
