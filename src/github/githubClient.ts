import { GITHUB_API_BASE } from '../shared/constants';
import type {
  ConnectionTestResult,
  GitHubTreeItem,
  GitHubTreeResponse,
  RepoConfig,
} from '../shared/types';

export class GitHubApiError extends Error {
  status: number;
  body: string;
  path: string;
  parsedBody: unknown;
  constructor(status: number, body: string, path: string) {
    super(`GitHub API ${status} ${path}`);
    this.name = 'GitHubApiError';
    this.status = status;
    this.body = body;
    this.path = path;
    try {
      this.parsedBody = body ? JSON.parse(body) : null;
    } catch {
      this.parsedBody = null;
    }
  }
}

export type CreateTreeItem = {
  path: string;
  mode: '100644' | '100755' | '040000' | '160000' | '120000';
  type: 'blob' | 'tree' | 'commit';
  sha?: string | null;
  content?: string;
};

export class GitHubClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const url = `${GITHUB_API_BASE}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${this.token}`,
    };
    if (init?.body) {
      headers['Content-Type'] = 'application/json';
    }
    const merged: RequestInit = {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    };
    const res = await fetch(url, merged);
    if (!res.ok) {
      const bodyText = await safeText(res);
      throw new GitHubApiError(res.status, bodyText, path);
    }
    // Some endpoints (e.g. 204) have no body
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  getUser(): Promise<{ login: string }> {
    return this.request('/user');
  }

  getRepo(
    owner: string,
    repo: string,
  ): Promise<{
    default_branch: string;
    permissions?: { admin: boolean; push: boolean; pull: boolean };
    private: boolean;
    full_name: string;
  }> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  getRef(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ ref: string; object: { sha: string; type: string } }> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
  }

  getCommit(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<{ sha: string; tree: { sha: string }; parents: Array<{ sha: string }> }> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${sha}`,
    );
  }

  getTree(
    owner: string,
    repo: string,
    sha: string,
    recursive = true,
  ): Promise<GitHubTreeResponse> {
    const qs = recursive ? '?recursive=1' : '';
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${sha}${qs}`,
    );
  }

  createBlob(
    owner: string,
    repo: string,
    content: string,
    encoding: 'utf-8' | 'base64',
  ): Promise<{ sha: string }> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
      {
        method: 'POST',
        body: JSON.stringify({ content, encoding }),
      },
    );
  }

  createTree(
    owner: string,
    repo: string,
    baseTreeSha: string,
    tree: CreateTreeItem[],
  ): Promise<{ sha: string; tree: GitHubTreeItem[] }> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTreeSha, tree }),
      },
    );
  }

  createCommit(
    owner: string,
    repo: string,
    message: string,
    treeSha: string,
    parents: string[],
  ): Promise<{ sha: string; html_url: string }> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({ message, tree: treeSha, parents }),
      },
    );
  }

  updateRef(
    owner: string,
    repo: string,
    branch: string,
    sha: string,
    force: boolean,
  ): Promise<{ ref: string; object: { sha: string } }> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha, force }),
      },
    );
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export function formatGitHubError(err: unknown): string {
  if (err instanceof GitHubApiError) {
    const body = (err.parsedBody ?? null) as { message?: string; errors?: unknown } | null;
    switch (err.status) {
      case 401:
        return 'GitHub token is invalid or expired.';
      case 403: {
        const msg = (body?.message ?? '').toLowerCase();
        if (msg.includes('rate limit')) {
          return 'GitHub rate limit reached. Please wait and try again.';
        }
        if (msg.includes('sso')) {
          return 'GitHub token requires SSO authorization for this organization.';
        }
        return 'Token does not have required repository contents permission.';
      }
      case 404:
        return 'Repository or branch was not found, or the token cannot access it.';
      case 409:
        return 'GitHub branch changed. Refresh diff and try again.';
      case 422: {
        const detail = body?.message ?? 'Validation failed.';
        return `GitHub validation error: ${detail}`;
      }
      case 429:
        return 'GitHub rate limit reached. Please wait and try again.';
      default:
        return `GitHub error ${err.status}: ${body?.message ?? 'unknown'}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function testConnection(
  token: string,
  config: RepoConfig,
): Promise<ConnectionTestResult> {
  if (!token.trim()) {
    return { ok: false, error: 'GitHub token is empty.' };
  }
  if (!config.owner.trim() || !config.repo.trim()) {
    return { ok: false, error: 'Repository owner and name are required.' };
  }
  if (!config.branch.trim()) {
    return { ok: false, error: 'Branch is required.' };
  }
  const client = new GitHubClient(token);
  try {
    const user = await client.getUser();
    const repo = await client.getRepo(config.owner, config.repo);
    let branchFound = false;
    try {
      await client.getRef(config.owner, config.repo, config.branch);
      branchFound = true;
    } catch (e) {
      if (e instanceof GitHubApiError && e.status === 404) {
        branchFound = false;
      } else {
        throw e;
      }
    }
    const contentsPermission = Boolean(repo.permissions?.push);
    const ok = branchFound && contentsPermission;
    return {
      ok,
      user: { login: user.login },
      defaultBranch: repo.default_branch,
      branchFound,
      contentsPermission,
      error: ok
        ? undefined
        : !branchFound
          ? `Branch "${config.branch}" not found in ${config.owner}/${config.repo}.`
          : 'Token lacks write (push) permission to this repository.',
    };
  } catch (e) {
    return { ok: false, error: formatGitHubError(e) };
  }
}
