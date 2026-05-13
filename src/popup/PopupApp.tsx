import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CommitResult,
  DiffItem,
  DiffSummary,
  GitHubTreeItem,
  ProjectFile,
  RepoConfig,
} from '../shared/types';
import { getRepoConfig, isConfigured } from '../storage/extensionStorage';
import { getToken } from '../github/auth';
import { readZipFromFile, ZipError } from '../zip/zipReader';
import {
  GitHubApiError,
  GitHubClient,
  formatGitHubError,
} from '../github/githubClient';
import { computeDiff, hasActionableChanges, summarize } from '../diff/diffEngine';
import { CommitError, createCommit, type CommitProgress } from '../github/commitEngine';

type Phase =
  | { kind: 'loading' }
  | { kind: 'unconfigured'; reason: 'no-token' | 'no-repo' | 'both' }
  | { kind: 'ready' }
  | { kind: 'analyzing'; fileName: string; step: string }
  | {
      kind: 'preview';
      fileName: string;
      zipFiles: ProjectFile[];
      diffs: DiffItem[];
      includeDeletions: boolean;
      commitMessage: string;
      baseCommitSha: string;
      baseTreeSha: string;
    }
  | { kind: 'committing'; progress: string }
  | { kind: 'success'; result: CommitResult }
  | { kind: 'error'; message: string };

const DEFAULT_COMMIT_MESSAGE = 'Sync Overleaf project';

export function Popup(): React.ReactElement {
  const [config, setConfig] = useState<RepoConfig | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [c, t] = await Promise.all([getRepoConfig(), getToken()]);
        setConfig(c);
        setToken(t);
        if (!t && !isConfigured(c)) {
          setPhase({ kind: 'unconfigured', reason: 'both' });
        } else if (!t) {
          setPhase({ kind: 'unconfigured', reason: 'no-token' });
        } else if (!isConfigured(c)) {
          setPhase({ kind: 'unconfigured', reason: 'no-repo' });
        } else {
          setPhase({ kind: 'ready' });
        }
      } catch (e) {
        setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);

  const openOptions = useCallback(() => {
    chrome.runtime.openOptionsPage().catch(() => {
      // Options page may not be available; ignore.
    });
  }, []);

  const restart = useCallback(() => {
    setPhase({ kind: 'ready' });
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      if (!config || !token) return;
      setPhase({ kind: 'analyzing', fileName: file.name, step: 'Reading ZIP…' });
      try {
        const zipFiles = await readZipFromFile(file);
        setPhase({ kind: 'analyzing', fileName: file.name, step: 'Fetching GitHub state…' });
        const { baseCommitSha, baseTreeSha, treeItems } = await fetchGitHubTree(token, config);
        setPhase({ kind: 'analyzing', fileName: file.name, step: 'Computing diff…' });
        const diffs = await computeDiff(zipFiles, treeItems, config);
        setPhase({
          kind: 'preview',
          fileName: file.name,
          zipFiles,
          diffs,
          includeDeletions: config.includeDeletions,
          commitMessage: DEFAULT_COMMIT_MESSAGE,
          baseCommitSha,
          baseTreeSha,
        });
      } catch (e) {
        let msg: string;
        if (e instanceof ZipError) msg = e.message;
        else if (e instanceof GitHubApiError) msg = formatGitHubError(e);
        else msg = e instanceof Error ? e.message : String(e);
        setPhase({ kind: 'error', message: msg });
      }
    },
    [config, token],
  );

  const onFileChange = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const onCommit = useCallback(async () => {
    if (phase.kind !== 'preview' || !config || !token) return;
    if (!phase.commitMessage.trim()) return;
    if (!hasActionableChanges(phase.diffs, phase.includeDeletions)) return;

    const effectiveConfig: RepoConfig = {
      ...config,
      includeDeletions: phase.includeDeletions,
    };

    setPhase({ kind: 'committing', progress: 'Starting commit…' });
    try {
      const result = await createCommit(
        token,
        effectiveConfig,
        phase.zipFiles,
        phase.diffs,
        phase.commitMessage.trim(),
        { commitSha: phase.baseCommitSha, treeSha: phase.baseTreeSha },
        { onProgress: (p) => setPhase({ kind: 'committing', progress: describeProgress(p) }) },
      );
      setPhase({ kind: 'success', result });
    } catch (e) {
      let msg: string;
      if (e instanceof CommitError) msg = e.message;
      else if (e instanceof GitHubApiError) msg = formatGitHubError(e);
      else msg = e instanceof Error ? e.message : String(e);
      setPhase({ kind: 'error', message: msg });
    }
  }, [phase, config, token]);

  return (
    <div className="popup">
      <header className="popup-header">
        <h1>Overleaf Snapshot to GitHub</h1>
        <button
          className="gear"
          aria-label="Open options"
          title="Open options"
          onClick={openOptions}
          type="button"
        >
          <SettingsIcon />
        </button>
      </header>
      <div className="popup-body">
        {phase.kind === 'loading' && (
          <div className="progress-text" role="status" aria-live="polite">
            Loading…
          </div>
        )}

        {phase.kind === 'unconfigured' && (
          <UnconfiguredView reason={phase.reason} onOpenOptions={openOptions} />
        )}

        {phase.kind === 'ready' && config && (
          <ReadyView config={config} onChooseFile={onFileChange} inputRef={fileInputRef} />
        )}

        {phase.kind === 'analyzing' && (
          <div className="progress-text" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {phase.step}
            <div className="muted" style={{ marginTop: 4 }}>
              {phase.fileName}
            </div>
          </div>
        )}

        {phase.kind === 'preview' && config && (
          <PreviewView
            config={config}
            phase={phase}
            onChange={(next) => setPhase(next)}
            onCommit={onCommit}
            onRestart={restart}
          />
        )}

        {phase.kind === 'committing' && (
          <div className="progress-text" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {phase.progress}
          </div>
        )}

        {phase.kind === 'success' && <SuccessView result={phase.result} onAnother={restart} />}

        {phase.kind === 'error' && <ErrorView message={phase.message} onRetry={restart} />}
      </div>
    </div>
  );
}

type FetchedTree = {
  baseCommitSha: string;
  baseTreeSha: string;
  treeItems: GitHubTreeItem[];
};

async function fetchGitHubTree(token: string, config: RepoConfig): Promise<FetchedTree> {
  const client = new GitHubClient(token);
  const ref = await client.getRef(config.owner, config.repo, config.branch);
  const commit = await client.getCommit(config.owner, config.repo, ref.object.sha);
  const tree = await client.getTree(config.owner, config.repo, commit.tree.sha, true);
  if (tree.truncated) {
    throw new Error(
      'Repository tree is too large to compare. Use a target directory or a smaller repo.',
    );
  }
  return {
    baseCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    treeItems: tree.tree,
  };
}

function describeProgress(p: CommitProgress): string {
  switch (p.phase) {
    case 'verifyRef':
      return 'Verifying branch state…';
    case 'createBlobs':
      return `Uploading binary files (${p.current}/${p.total})…`;
    case 'createTree':
      return 'Creating tree…';
    case 'createCommit':
      return 'Creating commit…';
    case 'updateRef':
      return 'Updating branch…';
    default:
      return 'Committing…';
  }
}

function UnconfiguredView({
  reason,
  onOpenOptions,
}: {
  reason: 'no-token' | 'no-repo' | 'both';
  onOpenOptions: () => void;
}): React.ReactElement {
  const message =
    reason === 'no-token'
      ? 'GitHub token is not set.'
      : reason === 'no-repo'
        ? 'GitHub repository is not configured.'
        : 'GitHub token and repository are not configured.';
  return (
    <>
      <div className="banner warning">{message}</div>
      <button className="button primary full" type="button" onClick={onOpenOptions}>
        Open Options
      </button>
    </>
  );
}

function ReadyView({
  config,
  onChooseFile,
  inputRef,
}: {
  config: RepoConfig;
  onChooseFile: (ev: React.ChangeEvent<HTMLInputElement>) => void;
  inputRef: React.RefObject<HTMLInputElement>;
}): React.ReactElement {
  return (
    <>
      <RepoSummary config={config} />
      <div className="banner warning">
        Download the Overleaf <strong>Source</strong> ZIP from <em>Menu → Source</em>, then select
        it below.
      </div>
      <div className="file-input">
        <label htmlFor="zipInput">Overleaf source ZIP</label>
        <input
          id="zipInput"
          ref={inputRef}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          onChange={onChooseFile}
        />
      </div>
    </>
  );
}

function RepoSummary({ config }: { config: RepoConfig }): React.ReactElement {
  return (
    <div className="repo-summary">
      <span className="k">Repo</span>
      <code>
        {config.owner}/{config.repo}
      </code>
      <span className="k">Branch</span>
      <code>{config.branch}</code>
      {config.targetDir ? (
        <>
          <span className="k">Target</span>
          <code>{config.targetDir}/</code>
        </>
      ) : null}
    </div>
  );
}

function PreviewView({
  config,
  phase,
  onChange,
  onCommit,
  onRestart,
}: {
  config: RepoConfig;
  phase: Extract<Phase, { kind: 'preview' }>;
  onChange: (p: Phase) => void;
  onCommit: () => void;
  onRestart: () => void;
}): React.ReactElement {
  const summary: DiffSummary = useMemo(() => summarize(phase.diffs), [phase.diffs]);
  const actionable = hasActionableChanges(phase.diffs, phase.includeDeletions);
  const deletions = phase.diffs.filter((d) => d.status === 'deleted');

  const setMessage = (msg: string) => onChange({ ...phase, commitMessage: msg });
  const setIncludeDeletions = (v: boolean) => onChange({ ...phase, includeDeletions: v });

  const filesByStatus = useMemo(() => {
    const groups: Record<DiffItem['status'], DiffItem[]> = {
      added: [],
      modified: [],
      deleted: [],
      unchanged: [],
    };
    for (const d of phase.diffs) groups[d.status].push(d);
    return groups;
  }, [phase.diffs]);

  return (
    <>
      <RepoSummary config={config} />
      <div className="muted">
        ZIP: <code>{phase.fileName}</code>
      </div>

      <div className="summary">
        <span className="pill">
          <span className="dot added" /> Added {summary.added}
        </span>
        <span className="pill">
          <span className="dot modified" /> Modified {summary.modified}
        </span>
        <span className="pill">
          <span className="dot deleted" /> Deleted {summary.deleted}
        </span>
        <span className="pill">
          <span className="dot unchanged" /> Unchanged {summary.unchanged}
        </span>
      </div>

      {summary.added + summary.modified + summary.deleted === 0 ? (
        <div className="banner warning">No changes detected between the ZIP and GitHub.</div>
      ) : (
        <div className="diff-list">
          <DiffSection title="Added" status="added" items={filesByStatus.added} />
          <DiffSection title="Modified" status="modified" items={filesByStatus.modified} />
          <DiffSection
            title={phase.includeDeletions ? 'Deleted (will be removed)' : 'Deleted (skipped)'}
            status="deleted"
            items={filesByStatus.deleted}
            defaultOpen={phase.includeDeletions}
            struckThrough={phase.includeDeletions}
          />
          <DiffSection
            title="Unchanged"
            status="unchanged"
            items={filesByStatus.unchanged}
            defaultOpen={false}
          />
        </div>
      )}

      {deletions.length > 0 && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={phase.includeDeletions}
            onChange={(e) => setIncludeDeletions(e.target.checked)}
          />
          <span>
            Include deletions ({deletions.length} file{deletions.length === 1 ? '' : 's'})
          </span>
        </label>
      )}

      {phase.includeDeletions && deletions.length > 0 && (
        <div className="delete-warning">
          <strong>{deletions.length}</strong> file{deletions.length === 1 ? '' : 's'} will be
          permanently removed from <code>{config.branch}</code>
          {config.targetDir ? (
            <>
              {' '}
              under <code>{config.targetDir}/</code>
            </>
          ) : null}
          . Make sure your ZIP is complete.
        </div>
      )}

      <div className="commit-form">
        <label htmlFor="commitMsg">Commit message</label>
        <textarea
          id="commitMsg"
          rows={2}
          value={phase.commitMessage}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={DEFAULT_COMMIT_MESSAGE}
        />
      </div>

      <div className="row between">
        <button className="button" type="button" onClick={onRestart}>
          Pick different ZIP
        </button>
        <button
          className="button primary"
          type="button"
          onClick={onCommit}
          disabled={!actionable || phase.commitMessage.trim().length === 0}
          title={!actionable ? 'No changes to commit' : 'Commit to GitHub'}
        >
          Commit to GitHub
        </button>
      </div>
    </>
  );
}

function DiffSection({
  title,
  status,
  items,
  defaultOpen = true,
  struckThrough = false,
}: {
  title: string;
  status: DiffItem['status'];
  items: DiffItem[];
  defaultOpen?: boolean;
  struckThrough?: boolean;
}): React.ReactElement | null {
  if (items.length === 0) return null;
  const chipLabel = CHIP_LABELS[status];
  const chipA11y = CHIP_A11Y[status];
  return (
    <details className={`diff-section diff-${status}`} open={defaultOpen}>
      <summary>
        <span className="diff-section-title">
          <span className={`dot ${status}`} aria-hidden="true" />
          {title}
        </span>
        <span className="diff-section-count">{items.length}</span>
      </summary>
      <ul>
        {items.map((item) => (
          <li
            key={`${status}-${item.path}`}
            className={`diff-row diff-row-${status}${struckThrough ? ' struck' : ''}`}
            title={item.path}
          >
            <span
              className={`chip chip-${status}`}
              aria-label={chipA11y}
            >
              {chipLabel}
            </span>
            <span className="path">{item.path}</span>
            {item.sizeBytes != null && (
              <span className="size" aria-label={`${formatSize(item.sizeBytes)} file size`}>
                {formatSize(item.sizeBytes)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

const CHIP_LABELS: Record<DiffItem['status'], string> = {
  added: 'ADD',
  modified: 'MOD',
  deleted: 'DEL',
  unchanged: '—',
};

const CHIP_A11Y: Record<DiffItem['status'], string> = {
  added: 'added file',
  modified: 'modified file',
  deleted: 'deleted file',
  unchanged: 'unchanged file',
};

function SuccessView({
  result,
  onAnother,
}: {
  result: CommitResult;
  onAnother: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="success-card" role="status" aria-live="polite">
        <div>
          <strong>Commit created.</strong>
        </div>
        <div>
          <code>{result.sha.substring(0, 7)}</code>
        </div>
        <a href={result.htmlUrl} target="_blank" rel="noreferrer noopener">
          View on GitHub <span aria-hidden="true">→</span>
        </a>
      </div>
      <button className="button full" type="button" onClick={onAnother}>
        Analyze another ZIP
      </button>
    </>
  );
}

function ErrorView({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="banner error" role="alert">
        {message}
      </div>
      <button className="button full" type="button" onClick={onRetry}>
        Try again
      </button>
    </>
  );
}

function SettingsIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
