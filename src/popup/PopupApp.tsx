import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CommitResult,
  DiffItem,
  DiffSummary,
  ExperimentalConfig,
  GitHubTreeItem,
  ProjectFile,
  RepoConfig,
} from '../shared/types';
import { DEFAULT_EXPERIMENTAL_CONFIG } from '../shared/constants';
import {
  getExperimentalConfig,
  getRepoConfig,
  isConfigured,
} from '../storage/extensionStorage';
import { getToken } from '../github/auth';
import { ZipError } from '../zip/zipReader';
import {
  GitHubApiError,
  GitHubClient,
  formatGitHubError,
} from '../github/githubClient';
import { computeDiff, hasActionableChanges, summarize } from '../diff/diffEngine';
import { CommitError, createCommit, type CommitProgress } from '../github/commitEngine';
import {
  getActiveOverleafProjectContext,
  type OverleafProjectContext,
} from '../overleaf/overleafContext';
import {
  OverleafZipFetchError,
  formatOverleafZipFetchError,
} from '../overleaf/overleafZipClient';
import {
  sourceFromManualZip,
  sourceFromOverleafZipRoute,
} from '../sources/sourceManager';
import type { SourceMode, SourceSnapshot } from '../sources/sourceTypes';
import { fetchOverleafLiveSnapshot } from '../overleaf/live/liveSyncManager';
import { LiveSyncError, recoveryActionForLiveSyncError } from '../overleaf/live/types';

type Phase =
  | { kind: 'loading' }
  | { kind: 'unconfigured'; reason: 'no-token' | 'no-repo' | 'both' }
  | { kind: 'ready' }
  | { kind: 'analyzing'; label: string; step: string }
  | {
      kind: 'preview';
      snapshot: SourceSnapshot;
      diffs: DiffItem[];
      includeDeletions: boolean;
      commitMessage: string;
      baseCommitSha: string;
      baseTreeSha: string;
    }
  | { kind: 'committing'; progress: string }
  | { kind: 'success'; result: CommitResult; manualFallbackHint?: boolean }
  | { kind: 'error'; message: string; allowManualFallback: boolean; recovery?: string };

const DEFAULT_COMMIT_MESSAGE = 'Sync Overleaf project';

export function Popup(): React.ReactElement {
  const [config, setConfig] = useState<RepoConfig | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [experimental, setExperimental] = useState<ExperimentalConfig>(
    DEFAULT_EXPERIMENTAL_CONFIG,
  );
  const [overleafContext, setOverleafContext] =
    useState<OverleafProjectContext | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [c, t, e, ctx] = await Promise.all([
          getRepoConfig(),
          getToken(),
          getExperimentalConfig(),
          getActiveOverleafProjectContext(),
        ]);
        setConfig(c);
        setToken(t);
        setExperimental(e);
        setOverleafContext(ctx);
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
        setPhase({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
          allowManualFallback: true,
        });
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

  const beginPreview = useCallback(
    async (snapshot: SourceSnapshot) => {
      if (!config || !token) return;
      try {
        setPhase({
          kind: 'analyzing',
          label: snapshot.displayName,
          step: 'Fetching GitHub state…',
        });
        const { baseCommitSha, baseTreeSha, treeItems } = await fetchGitHubTree(token, config);
        setPhase({
          kind: 'analyzing',
          label: snapshot.displayName,
          step: 'Computing diff…',
        });
        const diffs = await computeDiff(snapshot.files, treeItems, config);
        setPhase({
          kind: 'preview',
          snapshot,
          diffs,
          includeDeletions: config.includeDeletions,
          commitMessage: DEFAULT_COMMIT_MESSAGE,
          baseCommitSha,
          baseTreeSha,
        });
      } catch (e) {
        let msg: string;
        if (e instanceof GitHubApiError) msg = formatGitHubError(e);
        else msg = e instanceof Error ? e.message : String(e);
        setPhase({
          kind: 'error',
          message: msg,
          allowManualFallback: snapshot.mode !== 'manual-zip',
        });
      }
    },
    [config, token],
  );

  const handleAutomaticFetch = useCallback(async () => {
    if (!overleafContext || !config || !token) return;
    setPhase({
      kind: 'analyzing',
      label: `Overleaf project ${overleafContext.projectId}`,
      step: 'Fetching Overleaf source ZIP…',
    });
    try {
      const snapshot = await sourceFromOverleafZipRoute(overleafContext.projectId);
      await beginPreview(snapshot);
    } catch (e) {
      let message: string;
      if (e instanceof OverleafZipFetchError) {
        message = `${formatOverleafZipFetchError(e)} Automatic Overleaf export failed. You can still download the source ZIP manually from Overleaf and select it here.`;
      } else if (e instanceof ZipError) {
        message = `${e.message} Automatic Overleaf export failed. You can still download the source ZIP manually from Overleaf and select it here.`;
      } else {
        message = `${e instanceof Error ? e.message : String(e)} Automatic Overleaf export failed. You can still download the source ZIP manually from Overleaf and select it here.`;
      }
      setPhase({
        kind: 'error',
        message,
        allowManualFallback: true,
      });
    }
  }, [overleafContext, config, token, beginPreview]);

  const handleLiveReadOnly = useCallback(async () => {
    if (!overleafContext || !config || !token) return;
    setPhase({
      kind: 'analyzing',
      label: `Overleaf project ${overleafContext.projectId}`,
      step: 'Connecting to Overleaf live session…',
    });
    try {
      const live = await fetchOverleafLiveSnapshot(
        overleafContext.projectId,
        experimental,
      );
      const snapshot: SourceSnapshot = {
        mode: 'overleaf-live-readonly',
        projectId: live.projectId,
        displayName: `Live ${live.projectId}`,
        files: live.files,
        warnings: live.warnings,
        metadata: { fetchedAt: live.fetchedAt },
      };
      await beginPreview(snapshot);
    } catch (e) {
      let message: string;
      let recovery: string | undefined;
      if (e instanceof LiveSyncError) {
        message = e.message;
        recovery = e.recovery ?? recoveryActionForLiveSyncError(e.code);
      } else {
        message = e instanceof Error ? e.message : String(e);
      }
      setPhase({
        kind: 'error',
        message,
        recovery,
        allowManualFallback: true,
      });
    }
  }, [overleafContext, config, token, experimental, beginPreview]);

  const handleManualFile = useCallback(
    async (file: File) => {
      if (!config || !token) return;
      setPhase({ kind: 'analyzing', label: file.name, step: 'Reading ZIP…' });
      try {
        const snapshot = await sourceFromManualZip(file);
        await beginPreview(snapshot);
      } catch (e) {
        let msg: string;
        if (e instanceof ZipError) msg = e.message;
        else msg = e instanceof Error ? e.message : String(e);
        setPhase({
          kind: 'error',
          message: msg,
          allowManualFallback: false,
        });
      }
    },
    [config, token, beginPreview],
  );

  const onFileChange = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      if (file) void handleManualFile(file);
    },
    [handleManualFile],
  );

  const onCommit = useCallback(async () => {
    if (phase.kind !== 'preview' || !config || !token) return;
    if (!phase.commitMessage.trim()) return;
    // Defense in depth: a snapshot with fetch warnings is potentially
    // incomplete. Files that failed to fetch will appear as "deleted" in
    // the diff because computeDiff sees them in GitHub but not in the
    // snapshot. Honoring includeDeletions in that state would silently
    // remove real files from GitHub. Force the flag off here even if the
    // UI checkbox somehow ended up enabled.
    const effectiveIncludeDeletions =
      phase.snapshot.warnings.length > 0 ? false : phase.includeDeletions;
    if (!hasActionableChanges(phase.diffs, effectiveIncludeDeletions)) return;

    const effectiveConfig: RepoConfig = {
      ...config,
      includeDeletions: effectiveIncludeDeletions,
    };

    setPhase({ kind: 'committing', progress: 'Starting commit…' });
    try {
      const result = await createCommit(
        token,
        effectiveConfig,
        phase.snapshot.files,
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
      setPhase({ kind: 'error', message: msg, allowManualFallback: false });
    }
  }, [phase, config, token]);

  return (
    <div className="popup">
      <header className="popup-header">
        <h1>Overleaf GitHub Snapshot</h1>
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
          <ReadyView
            config={config}
            overleafContext={overleafContext}
            experimental={experimental}
            onAutomatic={handleAutomaticFetch}
            onLiveReadOnly={handleLiveReadOnly}
            onChooseFile={onFileChange}
            inputRef={fileInputRef}
          />
        )}

        {phase.kind === 'analyzing' && (
          <div className="progress-text" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {phase.step}
            <div className="muted" style={{ marginTop: 4 }}>
              {phase.label}
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

        {phase.kind === 'error' && (
          <ErrorView
            message={phase.message}
            recovery={phase.recovery}
            allowManualFallback={phase.allowManualFallback}
            onRetry={restart}
            onChooseFile={onFileChange}
            inputRef={fileInputRef}
          />
        )}
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
  overleafContext,
  experimental,
  onAutomatic,
  onLiveReadOnly,
  onChooseFile,
  inputRef,
}: {
  config: RepoConfig;
  overleafContext: OverleafProjectContext | null;
  experimental: ExperimentalConfig;
  onAutomatic: () => void;
  onLiveReadOnly: () => void;
  onChooseFile: (ev: React.ChangeEvent<HTMLInputElement>) => void;
  inputRef: React.RefObject<HTMLInputElement>;
}): React.ReactElement {
  return (
    <>
      <RepoSummary config={config} />

      <section className="mode-section">
        <h2 className="mode-title">
          <span className="mode-badge stable">Stable</span>
          Commit Overleaf snapshot to GitHub
        </h2>
        {overleafContext ? (
          <>
            <div className="muted">
              Current Overleaf project detected.<br />
              Project ID: <code>{overleafContext.projectId}</code>
            </div>
            <button
              className="button primary full"
              type="button"
              onClick={onAutomatic}
              style={{ marginTop: 8 }}
            >
              Fetch from current Overleaf project
            </button>
          </>
        ) : (
          <div className="muted">
            No active Overleaf project tab detected. Open an Overleaf project tab
            (https://www.overleaf.com/project/…) to use automatic snapshot, or
            upload a ZIP below.
          </div>
        )}
      </section>

      <section className="mode-section">
        <h2 className="mode-title">
          <span className="mode-badge fallback">Fallback</span>
          Manual ZIP upload
        </h2>
        <div className="muted">
          Download the Overleaf <strong>Source</strong> ZIP from{' '}
          <em>Menu → Source</em>, then select it below.
        </div>
        <div className="file-input" style={{ marginTop: 6 }}>
          <label htmlFor="zipInput">Overleaf source ZIP</label>
          <input
            id="zipInput"
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            onChange={onChooseFile}
          />
        </div>
      </section>

      {experimental.experimentalLiveSyncEnabled && (
        <section className="mode-section experimental">
          <h2 className="mode-title">
            <span className="mode-badge experimental">Experimental</span>
            Live Sync
          </h2>
          <div className="muted">
            These features depend on Overleaf internals that may break without
            warning. The ZIP route above is always available as a fallback.
          </div>
          {experimental.liveReadOnlyPullEnabled && (
            <>
              <button
                className="button full"
                type="button"
                onClick={onLiveReadOnly}
                disabled={!overleafContext}
                title={
                  overleafContext
                    ? 'Pull docs + files via the live Overleaf session, then commit to GitHub'
                    : 'Open the Overleaf project tab to enable live read-only pull'
                }
                style={{ marginTop: 8 }}
              >
                Live read-only pull from Overleaf
              </button>
              <div className="muted" style={{ marginTop: 4, fontSize: 11.5 }}>
                Status: implemented via a content-script bridge on the Overleaf
                project tab (Socket.IO 0.9 / joinProject / joinDoc). Depends on
                Overleaf's live protocol staying stable; if anything moves you
                will see a typed error and the ZIP route remains available.
                If you just installed/updated the extension, refresh the
                Overleaf tab once so the bridge can load.
              </div>
            </>
          )}
          {(experimental.overleafWriteBackEnabled || experimental.localReplicaEnabled) && (
            <div className="muted" style={{ marginTop: 8, fontSize: 11.5 }}>
              Note: write-back and local-replica modules are present in the
              codebase but have no popup UI in this build. Enabling their
              flags has no visible effect yet — they are slated for a future
              release.
            </div>
          )}
        </section>
      )}
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

function modeLabel(mode: SourceMode): string {
  switch (mode) {
    case 'manual-zip':
      return 'Manual ZIP';
    case 'overleaf-zip-route':
      return 'Automatic ZIP';
    case 'overleaf-live-readonly':
      return 'Live read-only';
    case 'local-replica':
      return 'Local replica';
  }
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
  // A snapshot with fetch warnings is potentially incomplete — files that
  // failed to fetch will look like deletions in the diff. Block the
  // deletion path entirely until the snapshot is clean. Adds and mods are
  // still safe to commit.
  const hasFetchWarnings = phase.snapshot.warnings.length > 0;
  const effectiveIncludeDeletions = hasFetchWarnings ? false : phase.includeDeletions;
  const actionable = hasActionableChanges(phase.diffs, effectiveIncludeDeletions);
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
        Source: <strong>{modeLabel(phase.snapshot.mode)}</strong>{' '}
        <code>{phase.snapshot.displayName}</code>
      </div>
      {hasFetchWarnings && (
        <div className="banner warning">
          {phase.snapshot.warnings.length} warning{phase.snapshot.warnings.length === 1 ? '' : 's'} during fetch — snapshot may be incomplete.{' '}
          <strong>Deletions are blocked</strong> to avoid removing files that
          just failed to fetch. Use the ZIP route for a complete snapshot if
          you also need to commit deletions.
          <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
            {phase.snapshot.warnings.slice(0, 5).map((w, i) => (
              <li key={i} style={{ fontSize: 11.5 }}>{w}</li>
            ))}
            {phase.snapshot.warnings.length > 5 && (
              <li style={{ fontSize: 11.5 }}>
                …and {phase.snapshot.warnings.length - 5} more
              </li>
            )}
          </ul>
        </div>
      )}

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
        <div className="banner warning">No changes detected between the source and GitHub.</div>
      ) : (
        <div className="diff-list">
          <DiffSection title="Added" status="added" items={filesByStatus.added} />
          <DiffSection title="Modified" status="modified" items={filesByStatus.modified} />
          <DiffSection
            title={effectiveIncludeDeletions ? 'Deleted (will be removed)' : 'Deleted (skipped)'}
            status="deleted"
            items={filesByStatus.deleted}
            defaultOpen={effectiveIncludeDeletions}
            struckThrough={effectiveIncludeDeletions}
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
            disabled={hasFetchWarnings}
            checked={effectiveIncludeDeletions}
            onChange={(e) => setIncludeDeletions(e.target.checked)}
          />
          <span>
            Include deletions ({deletions.length} file{deletions.length === 1 ? '' : 's'})
            {hasFetchWarnings && (
              <span className="muted"> — blocked while warnings exist</span>
            )}
          </span>
        </label>
      )}

      {effectiveIncludeDeletions && deletions.length > 0 && (
        <div className="delete-warning">
          <strong>{deletions.length}</strong> file{deletions.length === 1 ? '' : 's'} will be
          permanently removed from <code>{config.branch}</code>
          {config.targetDir ? (
            <>
              {' '}
              under <code>{config.targetDir}/</code>
            </>
          ) : null}
          . Make sure your source is complete.
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
          Back
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
        Make another commit
      </button>
    </>
  );
}

function ErrorView({
  message,
  recovery,
  allowManualFallback,
  onRetry,
  onChooseFile,
  inputRef,
}: {
  message: string;
  recovery?: string;
  allowManualFallback: boolean;
  onRetry: () => void;
  onChooseFile: (ev: React.ChangeEvent<HTMLInputElement>) => void;
  inputRef: React.RefObject<HTMLInputElement>;
}): React.ReactElement {
  return (
    <>
      <div className="banner error" role="alert">
        {message}
        {recovery && (
          <div className="muted" style={{ marginTop: 6 }}>
            Recovery: {recovery}
          </div>
        )}
      </div>
      {allowManualFallback && (
        <div className="file-input">
          <label htmlFor="zipInputFallback">Or upload Overleaf source ZIP manually</label>
          <input
            id="zipInputFallback"
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            onChange={onChooseFile}
          />
        </div>
      )}
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
