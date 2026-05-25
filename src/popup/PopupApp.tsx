import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CommitResult,
  ConnectionTestResult,
  DiffItem,
  DiffSummary,
  ExperimentalConfig,
  GitHubTreeItem,
  ProjectLink,
  ProjectLinkMap,
  RepoConfig,
  UIPreferences,
} from '../shared/types';
import {
  DEFAULT_EXPERIMENTAL_CONFIG,
  DEFAULT_REPO_CONFIG,
  DEFAULT_UI_PREFERENCES,
} from '../shared/constants';
import {
  clearLegacySingleConfig,
  getExperimentalConfig,
  getProjectLinkMap,
  getUIPreferences,
  isConfigured,
  isLinkComplete,
  readLegacySingleConfig,
  setProjectLink,
} from '../storage/extensionStorage';
import { ZipError } from '../zip/zipReader';
import {
  GitHubApiError,
  GitHubClient,
  formatGitHubError,
  testConnection,
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
  | { kind: 'unconfigured' }
  | {
      kind: 'link-setup';
      projectId: string;
      initialRepo: RepoConfig;
      initialToken: string;
      fromLegacy: boolean;
    }
  | { kind: 'pick-project' }
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
  const [linkMap, setLinkMap] = useState<ProjectLinkMap>({});
  const [activeLink, setActiveLink] = useState<ProjectLink | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [experimental, setExperimental] = useState<ExperimentalConfig>(
    DEFAULT_EXPERIMENTAL_CONFIG,
  );
  const [uiPrefs, setUiPrefs] = useState<UIPreferences>(DEFAULT_UI_PREFERENCES);
  const [overleafContext, setOverleafContext] =
    useState<OverleafProjectContext | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  // Sticky for the lifetime of this popup mount: once the stable
  // "Fetch from current Overleaf project" action has failed, the manual
  // ZIP upload section is revealed and stays revealed. We don't reset on
  // restart() because re-hiding after the user just learned the fallback
  // exists would be jarring.
  const [automaticFetchFailed, setAutomaticFetchFailed] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [ctx, map, e, ui, legacy] = await Promise.all([
          getActiveOverleafProjectContext(),
          getProjectLinkMap(),
          getExperimentalConfig(),
          getUIPreferences(),
          readLegacySingleConfig(),
        ]);
        setOverleafContext(ctx);
        setLinkMap(map);
        setExperimental(e);
        setUiPrefs(ui);

        if (ctx) {
          const existing = map[ctx.projectId];
          if (existing && isLinkComplete(existing)) {
            setActiveLink(existing);
            setActiveProjectId(ctx.projectId);
            setPhase({ kind: 'ready' });
          } else {
            const base = existing ?? (legacy ?? null);
            setPhase({
              kind: 'link-setup',
              projectId: ctx.projectId,
              initialRepo: base?.repo ?? { ...DEFAULT_REPO_CONFIG },
              initialToken: base?.token ?? '',
              fromLegacy: !existing && legacy !== null,
            });
          }
        } else if (Object.keys(map).length > 0) {
          setPhase({ kind: 'pick-project' });
        } else {
          setPhase({ kind: 'unconfigured' });
        }
      } catch (e) {
        setPhase({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
          allowManualFallback: false,
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

  const onSaveLink = useCallback(
    async (projectId: string, repo: RepoConfig, token: string, fromLegacy: boolean) => {
      const link: ProjectLink = { repo, token };
      await setProjectLink(projectId, link);
      if (fromLegacy) await clearLegacySingleConfig();
      setLinkMap((prev) => ({ ...prev, [projectId]: link }));
      setActiveLink(link);
      setActiveProjectId(projectId);
      setPhase({ kind: 'ready' });
    },
    [],
  );

  const onPickProject = useCallback(
    (projectId: string) => {
      const link = linkMap[projectId];
      if (!link) return;
      setActiveLink(link);
      setActiveProjectId(projectId);
      setPhase({ kind: 'ready' });
    },
    [linkMap],
  );

  const beginPreview = useCallback(
    async (snapshot: SourceSnapshot) => {
      if (!activeLink) return;
      try {
        setPhase({
          kind: 'analyzing',
          label: snapshot.displayName,
          step: 'Fetching GitHub state…',
        });
        const { baseCommitSha, baseTreeSha, treeItems } = await fetchGitHubTree(
          activeLink.token,
          activeLink.repo,
        );
        setPhase({
          kind: 'analyzing',
          label: snapshot.displayName,
          step: 'Computing diff…',
        });
        const diffs = await computeDiff(snapshot.files, treeItems, activeLink.repo);
        setPhase({
          kind: 'preview',
          snapshot,
          diffs,
          includeDeletions: activeLink.repo.includeDeletions,
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
    [activeLink],
  );

  const handleAutomaticFetch = useCallback(async () => {
    if (!overleafContext || !activeLink) return;
    setPhase({
      kind: 'analyzing',
      label: `Overleaf project ${overleafContext.projectId}`,
      step: 'Fetching Overleaf source ZIP…',
    });
    try {
      const snapshot = await sourceFromOverleafZipRoute(overleafContext.projectId);
      await beginPreview(snapshot);
    } catch (e) {
      setAutomaticFetchFailed(true);
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
  }, [overleafContext, activeLink, beginPreview]);

  const handleLiveReadOnly = useCallback(async () => {
    if (!overleafContext || !activeLink) return;
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
  }, [overleafContext, activeLink, experimental, beginPreview]);

  const handleManualFile = useCallback(
    async (file: File) => {
      if (!activeLink) return;
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
    [activeLink, beginPreview],
  );

  const onFileChange = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      if (file) void handleManualFile(file);
    },
    [handleManualFile],
  );

  const onCommit = useCallback(async () => {
    if (phase.kind !== 'preview' || !activeLink) return;
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
      ...activeLink.repo,
      includeDeletions: effectiveIncludeDeletions,
    };

    setPhase({ kind: 'committing', progress: 'Starting commit…' });
    try {
      const result = await createCommit(
        activeLink.token,
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
  }, [phase, activeLink]);

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
          <UnconfiguredView onOpenOptions={openOptions} />
        )}

        {phase.kind === 'link-setup' && (
          <LinkSetupView
            projectId={phase.projectId}
            initialRepo={phase.initialRepo}
            initialToken={phase.initialToken}
            fromLegacy={phase.fromLegacy}
            onSave={onSaveLink}
            onOpenOptions={openOptions}
          />
        )}

        {phase.kind === 'pick-project' && (
          <PickProjectView
            linkMap={linkMap}
            onPick={onPickProject}
            onOpenOptions={openOptions}
          />
        )}

        {phase.kind === 'ready' && activeLink && (
          <ReadyView
            config={activeLink.repo}
            projectId={activeProjectId}
            overleafContext={overleafContext}
            experimental={experimental}
            showManual={
              !overleafContext ||
              automaticFetchFailed ||
              uiPrefs.alwaysShowManualUpload
            }
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

        {phase.kind === 'preview' && activeLink && (
          <PreviewView
            config={activeLink.repo}
            projectId={activeProjectId}
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
  onOpenOptions,
}: {
  onOpenOptions: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="banner warning">
        No projects are linked yet. Open an Overleaf project tab
        (https://www.overleaf.com/project/…) to link it to a GitHub repo, or add
        a mapping manually in Options.
      </div>
      <button className="button primary full" type="button" onClick={onOpenOptions}>
        Open Options
      </button>
    </>
  );
}

function LinkSetupView({
  projectId,
  initialRepo,
  initialToken,
  fromLegacy,
  onSave,
  onOpenOptions,
}: {
  projectId: string;
  initialRepo: RepoConfig;
  initialToken: string;
  fromLegacy: boolean;
  onSave: (
    projectId: string,
    repo: RepoConfig,
    token: string,
    fromLegacy: boolean,
  ) => Promise<void>;
  onOpenOptions: () => void;
}): React.ReactElement {
  const [repo, setRepo] = useState<RepoConfig>(initialRepo);
  const [token, setTokenState] = useState<string>(initialToken);
  const [showToken, setShowToken] = useState<boolean>(false);
  const [test, setTest] = useState<
    { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; result: ConnectionTestResult }
  >({ kind: 'idle' });
  const [saving, setSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const trimmedRepo: RepoConfig = {
    ...repo,
    owner: repo.owner.trim(),
    repo: repo.repo.trim(),
    branch: repo.branch.trim() || 'main',
    targetDir: (repo.targetDir ?? '').trim(),
  };
  const canSave = isConfigured(trimmedRepo) && token.trim().length > 0 && !saving;

  const onTest = async () => {
    setTest({ kind: 'running' });
    const result = await testConnection(token.trim(), trimmedRepo);
    setTest({ kind: 'done', result });
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(projectId, trimmedRepo, token.trim(), fromLegacy);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <>
      <section className="mode-section">
        <h2 className="mode-title">
          <span className="mode-badge stable">Setup</span>
          Link this Overleaf project to a GitHub repo
        </h2>
        <div className="muted">
          Project ID: <code>{projectId}</code>
        </div>
        {fromLegacy && (
          <div className="banner success">
            Pre-filled from your previous single-repo setup. Save to attach it to
            this project; your old single config is then migrated.
          </div>
        )}

        <div className="setup-form">
          <label htmlFor="su-owner">Owner</label>
          <input
            id="su-owner"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={repo.owner}
            placeholder="username-or-org"
            onChange={(e) => setRepo({ ...repo, owner: e.target.value })}
          />

          <label htmlFor="su-repo">Repository</label>
          <input
            id="su-repo"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={repo.repo}
            placeholder="repo-name"
            onChange={(e) => setRepo({ ...repo, repo: e.target.value })}
          />

          <div className="row" style={{ gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="su-branch">Branch</label>
              <input
                id="su-branch"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={repo.branch}
                placeholder="main"
                onChange={(e) => setRepo({ ...repo, branch: e.target.value })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="su-dir">Target dir</label>
              <input
                id="su-dir"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={repo.targetDir ?? ''}
                placeholder="(optional)"
                onChange={(e) => setRepo({ ...repo, targetDir: e.target.value })}
              />
            </div>
          </div>

          <label htmlFor="su-token">GitHub token</label>
          <div className="row" style={{ gap: 6 }}>
            <input
              id="su-token"
              type={showToken ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={token}
              placeholder="github_pat_…"
              style={{ flex: 1 }}
              onChange={(e) => setTokenState(e.target.value)}
            />
            <button
              type="button"
              className="button"
              aria-pressed={showToken}
              onClick={() => setShowToken((v) => !v)}
            >
              {showToken ? 'Hide' : 'Show'}
            </button>
          </div>
          <div className="muted">
            Fine-grained PAT scoped to <em>only this repository</em> —{' '}
            <code>Contents: RW</code>, <code>Metadata: R</code>. Stored locally.
          </div>
        </div>

        <div className="row" style={{ gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="button"
            onClick={onTest}
            disabled={test.kind === 'running' || !isConfigured(trimmedRepo) || token.trim().length === 0}
          >
            {test.kind === 'running' ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Testing…
              </>
            ) : (
              'Test connection'
            )}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={save}
            disabled={!canSave}
            style={{ flex: 1 }}
          >
            {saving ? 'Saving…' : 'Save & continue'}
          </button>
        </div>

        {test.kind === 'done' && (
          <div
            className={`banner ${test.result.ok ? 'success' : 'error'}`}
            role={test.result.ok ? 'status' : 'alert'}
          >
            {test.result.ok
              ? `Connection OK${test.result.user ? ` as ${test.result.user.login}` : ''}.`
              : `Connection failed: ${test.result.error ?? 'unknown error'}`}
          </div>
        )}
        {saveError && (
          <div className="banner error" role="alert">
            Save failed: {saveError}
          </div>
        )}
      </section>

      <button className="button full" type="button" onClick={onOpenOptions}>
        Manage all mappings in Options
      </button>
    </>
  );
}

function PickProjectView({
  linkMap,
  onPick,
  onOpenOptions,
}: {
  linkMap: ProjectLinkMap;
  onPick: (projectId: string) => void;
  onOpenOptions: () => void;
}): React.ReactElement {
  const entries = Object.entries(linkMap);
  const [selected, setSelected] = useState<string>(entries[0]?.[0] ?? '');

  return (
    <>
      <section className="mode-section">
        <h2 className="mode-title">
          <span className="mode-badge fallback">No tab</span>
          No Overleaf project tab open
        </h2>
        <div className="muted">
          Pick which linked project's GitHub repo to target for a manual ZIP
          upload, or open an Overleaf project tab for automatic snapshot.
        </div>
        <div className="setup-form" style={{ marginTop: 4 }}>
          <label htmlFor="pick">Linked project</label>
          <select
            id="pick"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {entries.map(([pid, link]) => (
              <option key={pid} value={pid}>
                {pid} → {link.repo.owner}/{link.repo.repo}
              </option>
            ))}
          </select>
        </div>
        <button
          className="button primary full"
          type="button"
          disabled={!selected}
          onClick={() => onPick(selected)}
          style={{ marginTop: 4 }}
        >
          Continue with this repo
        </button>
      </section>

      <button className="button full" type="button" onClick={onOpenOptions}>
        Manage all mappings in Options
      </button>
    </>
  );
}

function ReadyView({
  config,
  projectId,
  overleafContext,
  experimental,
  showManual,
  onAutomatic,
  onLiveReadOnly,
  onChooseFile,
  inputRef,
}: {
  config: RepoConfig;
  projectId: string | null;
  overleafContext: OverleafProjectContext | null;
  experimental: ExperimentalConfig;
  showManual: boolean;
  onAutomatic: () => void;
  onLiveReadOnly: () => void;
  onChooseFile: (ev: React.ChangeEvent<HTMLInputElement>) => void;
  inputRef: React.RefObject<HTMLInputElement>;
}): React.ReactElement {
  return (
    <>
      <RepoSummary config={config} projectId={projectId} />

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
            No active Overleaf project tab. Automatic snapshot needs the project
            tab open; you can still upload a ZIP below for this repo.
          </div>
        )}
      </section>

      {showManual && (
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
      )}

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

function RepoSummary({
  config,
  projectId,
}: {
  config: RepoConfig;
  projectId: string | null;
}): React.ReactElement {
  return (
    <div className="repo-summary">
      {projectId && (
        <>
          <span className="k">Project</span>
          <code>{projectId}</code>
        </>
      )}
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
  projectId,
  phase,
  onChange,
  onCommit,
  onRestart,
}: {
  config: RepoConfig;
  projectId: string | null;
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
      <RepoSummary config={config} projectId={projectId} />
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
