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
  SYMLINK_SKIPPED_REASON_PREFIX,
  buildTokenCreationUrl,
} from '../shared/constants';
import {
  clearLegacySingleConfig,
  getExperimentalConfig,
  getMirrorMatchEnabled,
  getProjectLinkMap,
  getUIPreferences,
  isConfigured,
  isLinkComplete,
  readLegacySingleConfig,
  setMirrorMatchEnabled,
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
  describeOverleafZipFetchError,
  formatOverleafZipFetchError,
} from '../overleaf/overleafZipClient';
import {
  sourceFromManualZip,
  sourceFromOverleafZipRoute,
} from '../sources/sourceManager';
import { sourceFromGitHubBranch } from '../sources/sourceFromGitHubBranch';
import {
  applyPullPlan,
  describeCreateNote,
  describeFileReplaceNote,
  describeLineChange,
  describeNothingOnGitHub,
  describePullError,
  describePullOutcome,
  describePullPlan,
  discardPullPlan,
  isPullConfirmationTyped,
  mirrorInputFromSnapshot,
  planPullIntoOverleaf,
  pullConfirmationWord,
  pullPlanChangeCount,
  pullResultLabel,
  pullRowMessage,
  pullSourceOptions,
  type BinaryResult,
  type CreateResult,
  type DeleteResult,
  type FileReplaceResult,
  type PullPlan,
} from '../sources/pullFromGitHubHelpers';
import type { SourceMode, SourceSnapshot } from '../sources/sourceTypes';
import { fetchOverleafLiveSnapshot } from '../overleaf/live/liveSyncManager';
import {
  LiveSyncError,
  recoveryActionForLiveSyncError,
  type WriteBackResult,
} from '../overleaf/live/types';

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
  // No Overleaf tab and Manual ZIP upload is off: guidance only.
  | { kind: 'no-tab' }
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
  | {
      kind: 'error';
      message: string;
      // Today's inline ZIP picker, shown only while Manual ZIP upload is on.
      allowManualFallback: boolean;
      // While it is off, the same failures point at the setting instead.
      manualZipTip?: boolean;
      recovery?: string;
    };

const DEFAULT_COMMIT_MESSAGE = 'Sync Overleaf project';
// Overleaf's menu path for the source ZIP.
const MANUAL_ZIP_MENU = 'File → Download → Download as source (.zip)';
const MANUAL_ZIP_OPTIONS_TIP = 'You can also turn on Manual ZIP upload in Options.';

// The "What to try:" line for a failed automatic download while Manual ZIP
// upload is off. Most failures already end in their own advice (the message
// from formatOverleafZipFetchError), so this only fills the gap for those
// that don't; the ZIP picker used to be their only remedy.
function remedyForZipFetchError(e: unknown): string | undefined {
  if (e instanceof OverleafZipFetchError) {
    if (describeOverleafZipFetchError(e).advice !== null) return undefined;
    switch (e.code) {
      case 'forbidden':
      case 'not_found':
        return 'Check that you are signed in to an Overleaf account that can open this project, then try again.';
      default:
        break;
    }
  }
  return 'Wait a minute, then try again. If it keeps failing, reload the Overleaf tab.';
}

export function Popup(): React.ReactElement {
  const [linkMap, setLinkMap] = useState<ProjectLinkMap>({});
  const [activeLink, setActiveLink] = useState<ProjectLink | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [experimental, setExperimental] = useState<ExperimentalConfig>(
    DEFAULT_EXPERIMENTAL_CONFIG,
  );
  const [uiPrefs, setUiPrefs] = useState<UIPreferences>(DEFAULT_UI_PREFERENCES);
  // Off by default (Options → Popup display). While off, no Manual ZIP upload
  // is rendered anywhere in this popup.
  const manualZipEnabled = uiPrefs.manualZipUploadEnabled;
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
          // Picking a linked repo only serves a manual ZIP upload, so without
          // that setting there is nothing to pick.
          setPhase({ kind: ui.manualZipUploadEnabled ? 'pick-project' : 'no-tab' });
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
        const client = new GitHubClient(activeLink.token);
        const diffs = await computeDiff(snapshot.files, treeItems, activeLink.repo, {
          // Only for the few text files whose Overleaf text holds U+FFFD.
          fetchBlobBytes: (sha) =>
            client.getBlobBytes(activeLink.repo.owner, activeLink.repo.repo, sha),
        });
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
      // A ZIP you download yourself hits the same size limits, or is just as
      // empty, so these two get no manual fallback.
      const noFallback =
        e instanceof OverleafZipFetchError &&
        (e.code === 'project_too_large' || e.code === 'project_empty');
      if (!noFallback) setAutomaticFetchFailed(true);
      let message: string;
      if (e instanceof OverleafZipFetchError) {
        message = formatOverleafZipFetchError(e);
      } else {
        message = `Couldn't download this project from Overleaf. Details: ${e instanceof Error ? e.message : String(e)}`;
      }
      setPhase({
        kind: 'error',
        message,
        // Without Manual ZIP upload the error carries a real remedy when its
        // message has none, and the tip about the setting.
        recovery:
          !noFallback && !manualZipEnabled ? remedyForZipFetchError(e) : undefined,
        allowManualFallback: !noFallback,
        manualZipTip: !noFallback,
      });
    }
  }, [overleafContext, activeLink, beginPreview, manualZipEnabled]);

  const handleLiveReadOnly = useCallback(async () => {
    if (!overleafContext || !activeLink) return;
    setPhase({
      kind: 'analyzing',
      label: `Overleaf project ${overleafContext.projectId}`,
      step: 'Reading every file from the open Overleaf tab… (this can take a while)',
    });
    try {
      const live = await fetchOverleafLiveSnapshot(
        overleafContext.projectId,
        experimental,
      );
      const snapshot: SourceSnapshot = {
        mode: 'overleaf-live-readonly',
        projectId: live.projectId,
        displayName: `Overleaf project ${live.projectId}`,
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
        manualZipTip: true,
      });
    }
  }, [overleafContext, activeLink, experimental, beginPreview]);

  const handleManualFile = useCallback(
    async (file: File) => {
      if (!activeLink || !manualZipEnabled) return;
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
    [activeLink, beginPreview, manualZipEnabled],
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

        {phase.kind === 'no-tab' && <NoTabView onOpenOptions={openOptions} />}

        {phase.kind === 'ready' && activeLink && (
          <ReadyView
            config={activeLink.repo}
            token={activeLink.token}
            projectId={activeProjectId}
            overleafContext={overleafContext}
            experimental={experimental}
            showManual={
              manualZipEnabled &&
              (!overleafContext ||
                automaticFetchFailed ||
                uiPrefs.alwaysShowManualUpload)
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
            manualZipEnabled={manualZipEnabled}
            allowManualFallback={phase.allowManualFallback}
            manualZipTip={phase.manualZipTip ?? false}
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
      "This repository has too many files for GitHub to list in one request, so it can't be compared. Use a smaller repository.",
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
      return `Uploading images and other non-text files (${p.current}/${p.total})…`;
    case 'createTree':
      return 'Preparing commit…';
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
        No projects are linked yet. Open your project on overleaf.com and click
        this extension's icon to link it, or use <em>Add mapping</em> in
        Options.
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
            Pre-filled from your previous single-repo setup. Saving links these
            settings to this project and removes the old shared setting. Other
            projects need to be linked separately (including the token).
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
              <label htmlFor="su-dir">Target directory</label>
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
            <a href={buildTokenCreationUrl(repo)} target="_blank" rel="noreferrer">
              Create a token on GitHub ↗
            </a>{' '}
            — permissions are pre-filled; under <em>Repository access</em> choose{' '}
            <em>Only select repositories</em> and pick this repo. The token is
            saved only in this browser.
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

// Manual ZIP upload is off, so there is nothing to do without an Overleaf tab.
function NoTabView({ onOpenOptions }: { onOpenOptions: () => void }): React.ReactElement {
  return (
    <>
      <section className="mode-section">
        <h2 className="mode-title">
          <span className="mode-badge fallback">No tab</span>
          No Overleaf project tab open
        </h2>
        <div className="muted">
          Open your project on overleaf.com, then click this extension's icon.
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          {MANUAL_ZIP_OPTIONS_TIP}
        </div>
      </section>

      <button className="button full" type="button" onClick={onOpenOptions}>
        Open Options
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
                {link.repo.owner}/{link.repo.repo} ({link.repo.branch}) · Overleaf
                project {pid}
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
  token,
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
  token: string;
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
            No active Overleaf project tab.{' '}
            {showManual
              ? 'Automatic snapshot needs the project tab open; you can still upload a ZIP below for this repo.'
              : "Open the project on overleaf.com, then click this extension's icon."}
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
            In Overleaf, choose <em>{MANUAL_ZIP_MENU}</em>, then select that
            file below.
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

      {experimental.experimentalLiveSyncEnabled &&
        experimental.liveReadOnlyPullEnabled && (
          <section className="mode-section experimental">
            <h2 className="mode-title">
              <span className="mode-badge experimental">Experimental</span>
              Read from the open Overleaf tab (Overleaf → GitHub)
            </h2>
            <div className="muted">
              Reads every file from the open Overleaf tab instead of
              downloading a ZIP, then shows the same preview. Slower on large
              projects, so use <em>Fetch from current Overleaf project</em>{' '}
              when it works.
            </div>
            <button
              className="button full"
              type="button"
              onClick={onLiveReadOnly}
              disabled={!overleafContext}
              title={
                overleafContext
                  ? 'Read all files from the open Overleaf tab and show what would change on GitHub'
                  : 'Open the Overleaf project tab to use this'
              }
              style={{ marginTop: 8 }}
            >
              Read from the Overleaf tab
            </button>
          </section>
        )}

      {experimental.experimentalLiveSyncEnabled &&
        experimental.overleafWriteBackEnabled &&
        overleafContext && (
          <PullFromGitHubSection
            projectId={overleafContext.projectId}
            repoConfig={config}
            token={token}
            experimental={experimental}
          />
        )}
      {experimental.experimentalLiveSyncEnabled &&
        experimental.overleafWriteBackEnabled &&
        !overleafContext && (
          <section className="mode-section experimental">
            <h2 className="mode-title">
              <span className="mode-badge experimental">Experimental</span>
              Pull from GitHub into Overleaf
            </h2>
            <div className="muted">
              To pull into Overleaf, open this popup from the project's tab
              on overleaf.com.
            </div>
          </section>
        )}

      {experimental.experimentalLiveSyncEnabled && experimental.localReplicaEnabled && (
        <section className="mode-section experimental">
          <h2 className="mode-title">
            <span className="mode-badge experimental">Experimental</span>
            Local replica
          </h2>
          <div className="muted">
            Local folder comparison isn't available yet. This setting does
            nothing for now.
          </div>
        </section>
      )}
    </>
  );
}

// Popup section for pulling GitHub HEAD into Overleaf via the live
// bridge. The pull button first shows a preview (planPullIntoOverleaf,
// which writes nothing); only its confirm button writes, and only the
// files the preview listed (applyPullPlan). Mirrors the Options "Pull from
// GitHub" dev panel in the popup's tighter visual budget. Local state
// only — no popup Phase change.
function PullFromGitHubSection({
  projectId,
  repoConfig,
  token,
  experimental,
}: {
  projectId: string;
  repoConfig: RepoConfig;
  token: string;
  experimental: ExperimentalConfig;
}): React.ReactElement {
  type Mode = 'idle' | 'planning' | 'preview' | 'applying' | 'done' | 'error';
  const [mode, setMode] = useState<Mode>('idle');
  const [plan, setPlan] = useState<PullPlan | null>(null);
  const [typedConfirmation, setTypedConfirmation] = useState<string>('');
  const [step, setStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [errorRecovery, setErrorRecovery] = useState<string | null>(null);
  const [results, setResults] = useState<WriteBackResult[] | null>(null);
  const [createResults, setCreateResults] = useState<CreateResult[] | null>(null);
  const [binaryResults, setBinaryResults] = useState<BinaryResult[] | null>(null);
  const [noOverleafDocs, setNoOverleafDocs] = useState<string[]>([]);
  const [sourceSkipped, setSourceSkipped] = useState<
    { path: string; reason: string }[]
  >([]);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [createMissing, setCreateMissing] = useState<boolean>(false);
  const [fileReplaceResults, setFileReplaceResults] = useState<FileReplaceResult[] | null>(null);
  const [deleteResults, setDeleteResults] = useState<DeleteResult[] | null>(null);
  // "Make Overleaf match GitHub exactly": remembered for this project only
  // (it is the option that deletes files, so one project's choice never
  // carries over to another). Off until the stored choice has been read.
  const [mirror, setMirror] = useState<boolean>(false);
  const [mirrorLoaded, setMirrorLoaded] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const remembered = await getMirrorMatchEnabled(projectId);
        if (!cancelled) setMirror(remembered);
      } catch {
        // Unreadable: it stays off.
      }
      if (!cancelled) setMirrorLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const changeMirror = (value: boolean) => {
    setMirror(value);
    void setMirrorMatchEnabled(projectId, value).catch(() => {
      // The choice still applies to the pull started from this popup.
    });
  };

  // A plan keeps its Overleaf session open until it is applied or
  // discarded; discard it if the section goes away with a preview open.
  const planRef = useRef<PullPlan | null>(null);
  const holdPlan = (next: PullPlan | null) => {
    planRef.current = next;
    setPlan(next);
  };
  useEffect(
    () => () => {
      if (planRef.current) void discardPullPlan(planRef.current);
    },
    [],
  );

  const reset = () => {
    // Cancel from the preview: nothing has been written.
    if (planRef.current) void discardPullPlan(planRef.current);
    holdPlan(null);
    setTypedConfirmation('');
    setMode('idle');
    setStep('');
    setError(null);
    setErrorRecovery(null);
    setResults(null);
    setCreateResults(null);
    setBinaryResults(null);
    setFileReplaceResults(null);
    setDeleteResults(null);
    setNoOverleafDocs([]);
    setSourceSkipped([]);
    setCommitSha(null);
  };

  const fail = (e: unknown) => {
    const described = describePullError(e);
    setError(described.message);
    setErrorRecovery(described.recovery);
    setMode('error');
  };

  // Step 1: work out what the pull would change. Writes nothing.
  const preview = async () => {
    setMode('planning');
    setError(null);
    setErrorRecovery(null);
    setResults(null);
    setCreateResults(null);
    setBinaryResults(null);
    setFileReplaceResults(null);
    setDeleteResults(null);
    setNoOverleafDocs([]);
    setSourceSkipped([]);
    setCommitSha(null);
    setTypedConfirmation('');
    try {
      setStep('Fetching GitHub branch…');
      // With "Make Overleaf match GitHub exactly" every file type and every
      // non-text file is fetched, and the full tree is kept to see what
      // GitHub has (pullSourceOptions).
      const snapshot = await sourceFromGitHubBranch(
        token,
        repoConfig,
        pullSourceOptions(experimental, mirror),
      );
      setCommitSha(snapshot.commitSha);
      setSourceSkipped(snapshot.skipped);

      if (snapshot.files.length === 0) {
        setError(
          describeNothingOnGitHub(
            repoConfig.branch,
            repoConfig.targetDir,
            snapshot.skipped.length,
            mirror,
          ),
        );
        setMode('error');
        return;
      }

      const next = await planPullIntoOverleaf({
        projectId,
        files: snapshot.files,
        skippedOnGitHub: snapshot.skipped,
        experimental,
        createMissing,
        ...(mirror ? { mirror: mirrorInputFromSnapshot(snapshot, repoConfig) } : {}),
        onProgress: setStep,
      });
      setNoOverleafDocs(next.missingInOverleaf);
      holdPlan(next);
      setMode('preview');
    } catch (e) {
      fail(e);
    } finally {
      setStep('');
    }
  };

  // Step 2, after the user confirmed: write exactly what the preview listed.
  // Per-file failures produce result rows rather than aborting.
  const apply = async () => {
    const confirmed = planRef.current;
    if (!confirmed) return;
    holdPlan(null);
    setMode('applying');
    try {
      const outcome = await applyPullPlan(confirmed, setStep, typedConfirmation);
      setResults(outcome.results);
      setCreateResults(outcome.createResults);
      setBinaryResults(outcome.binaryResults);
      setFileReplaceResults(outcome.fileReplaceResults ?? null);
      setDeleteResults(outcome.deleteResults ?? null);
      setMode('done');
    } catch (e) {
      fail(e);
    } finally {
      setStep('');
    }
  };

  const previewText = plan ? describePullPlan(plan) : null;
  // The word to type (`replace`, `delete` or `delete N`), or null.
  const confirmationWord = plan ? pullConfirmationWord(plan) : null;
  const canConfirm =
    plan !== null &&
    pullPlanChangeCount(plan) > 0 &&
    (confirmationWord === null || isPullConfirmationTyped(typedConfirmation, plan));

  const finished = results || createResults || binaryResults || fileReplaceResults || deleteResults;
  const summary = finished
    ? describePullOutcome({
        results,
        createResults,
        binaryResults,
        fileReplaceResults,
        deleteResults,
      }).join(' · ')
    : null;
  const anyProblem =
    [results, createResults, binaryResults].some((rows) =>
      rows?.some((r) => r.status === 'failed' || r.status === 'conflict'),
    ) ||
    [fileReplaceResults, deleteResults].some((rows) =>
      rows?.some((r) => r.status !== 'replaced' && r.status !== 'deleted'),
    );

  const isSymlinkSkip = (s: { reason: string }) => s.reason.startsWith(SYMLINK_SKIPPED_REASON_PREFIX);
  const linkItems = sourceSkipped.filter(isSymlinkSkip);
  const binaryItems = sourceSkipped.filter((s) => s.reason.startsWith('binary'));
  const extFilteredItems = sourceSkipped.filter(
    (s) => !s.reason.startsWith('binary') && !isSymlinkSkip(s),
  );
  // Files with no doc in Overleaf; when new files were created they are in
  // the create results instead.
  const notInOverleaf = createResults ? [] : noOverleafDocs;

  return (
    <section className="mode-section experimental">
      <h2 className="mode-title">
        <span className="mode-badge experimental">Experimental</span>
        Pull from GitHub into Overleaf
      </h2>
      <div className="muted">
        Copies the latest version of <code>{repoConfig.branch}</code> from{' '}
        <code>{repoConfig.owner}/{repoConfig.repo}</code>
        {repoConfig.targetDir ? <> (only <code>{repoConfig.targetDir}/</code>)</> : null}
        {' '}into this Overleaf project. You first see which files would
        change, and nothing is written until you confirm. New files (on
        GitHub but not in Overleaf) are left out unless you opt in below.
      </div>

      {mode === 'idle' && (
        <>
          <label
            className="checkbox-row"
            style={{ marginTop: 8, fontSize: 11.5 }}
          >
            <input
              type="checkbox"
              checked={createMissing || mirror}
              disabled={mirror}
              onChange={(e) => setCreateMissing(e.target.checked)}
            />
            <span>
              Also create new files in Overleaf
              <div className="muted" style={{ fontSize: 11 }}>
                Adds files that are on GitHub but not yet in Overleaf,
                creating folders as needed. Text files must have an allowed
                type; images, PDFs and other non-text files are uploaded only
                if <em>Allow uploading new images and other non-text
                files</em> is on in Options.
                {mirror && ' Included while Make Overleaf match GitHub exactly is on, for every file type.'}
              </div>
            </span>
          </label>
          <label
            className="checkbox-row"
            style={{ marginTop: 8, fontSize: 11.5 }}
          >
            <input
              type="checkbox"
              checked={mirror}
              disabled={!mirrorLoaded}
              onChange={(e) => changeMirror(e.target.checked)}
            />
            <span>
              Make Overleaf match GitHub exactly
              <div className="muted" style={{ fontSize: 11 }}>
                Also deletes files that aren&apos;t on GitHub and replaces
                uploaded files that differ. You&apos;ll see the list and type{' '}
                <strong>delete</strong> to confirm. Deleted files can be
                restored from Overleaf&apos;s History.
              </div>
            </span>
          </label>
          <button
            className={mirror ? 'button full danger' : 'button full'}
            type="button"
            onClick={preview}
            disabled={!mirrorLoaded}
            style={{ marginTop: 8 }}
          >
            {mirror ? 'Pull and match GitHub' : 'Pull from GitHub into Overleaf'}
          </button>
        </>
      )}

      {mode === 'preview' && plan && previewText && (
        <div style={{ marginTop: 8 }}>
          {commitSha && (
            <div className="muted" style={{ fontSize: 11.5 }}>
              GitHub version <code>{commitSha.substring(0, 7)}</code>
            </div>
          )}
          {previewText.nothingToPull && (
            <div
              className={`banner ${plan.notPulled.length === 0 ? 'success' : 'warning'}`}
              role="status"
              style={{ marginTop: 6, fontSize: 11.5 }}
            >
              {previewText.nothingToPull}
            </div>
          )}
          {previewText.replace && (
            <div
              className="banner warning"
              role="alert"
              style={{ marginTop: 6, fontSize: 11.5 }}
            >
              {previewText.replace}
              <PullPreviewList
                items={plan.replace.map((r) => ({ path: r.path, note: describeLineChange(r) }))}
              />
            </div>
          )}
          {previewText.create && (
            <PullPreviewList
              summary={previewText.create}
              items={plan.create.map((c) => ({ path: c.path, note: describeCreateNote(c) }))}
            />
          )}
          {previewText.upload && (
            <PullPreviewList
              summary={previewText.upload}
              items={plan.upload.map((f) => ({ path: f.path }))}
            />
          )}
          {previewText.mirror?.replaceFilesTitle && plan.mirror && (
            <div
              className="banner warning"
              role="alert"
              style={{ marginTop: 6, fontSize: 11.5 }}
            >
              {previewText.mirror.replaceFilesNote}
              <PullPreviewList
                summary={previewText.mirror.replaceFilesTitle}
                items={plan.mirror.replaceFiles.map((f) => ({
                  path: f.path,
                  note: describeFileReplaceNote(f),
                }))}
                open
              />
            </div>
          )}
          {previewText.mirror?.largeDeletionWarning && (
            <div
              className="banner error"
              role="alert"
              style={{ marginTop: 6, fontSize: 11.5 }}
            >
              <strong>{previewText.mirror.largeDeletionWarning}</strong>
            </div>
          )}
          {previewText.mirror?.rootDocWarning && (
            <div
              className="banner error"
              role="alert"
              style={{ marginTop: 6, fontSize: 11.5 }}
            >
              <strong>{previewText.mirror.rootDocWarning}</strong>
            </div>
          )}
          {previewText.mirror?.deleteTitle && plan.mirror && (
            <div
              className="banner warning"
              role="alert"
              style={{ marginTop: 6, fontSize: 11.5 }}
            >
              {previewText.mirror.deleteNote}
              <PullPreviewList
                summary={previewText.mirror.deleteTitle}
                items={plan.mirror.deletions
                  .filter((d) => d.kind !== 'folder')
                  .map((d) => ({ path: d.path }))}
                open
              />
              {previewText.mirror.deleteFolders && (
                <PullPreviewList
                  summary={previewText.mirror.deleteFolders}
                  items={plan.mirror.deletions
                    .filter((d) => d.kind === 'folder')
                    .map((d) => ({ path: `${d.path}/` }))}
                />
              )}
            </div>
          )}
          {!previewText.mirror?.deleteTitle && previewText.mirror?.deleteFolders && plan.mirror && (
            <PullPreviewList
              summary={previewText.mirror.deleteFolders}
              items={plan.mirror.deletions
                .filter((d) => d.kind === 'folder')
                .map((d) => ({ path: `${d.path}/` }))}
            />
          )}
          {previewText.mirror?.kept.map((group) => (
            <PullPreviewList
              key={group.source}
              summary={group.summary}
              items={group.paths.map((path) => ({ path }))}
            />
          ))}
          {previewText.mirror?.notDeleted && plan.mirror && (
            <PullPreviewList
              summary={previewText.mirror.notDeleted}
              items={plan.mirror.notDeleted.map((n) => ({ path: n.path, note: n.reason }))}
            />
          )}
          {previewText.upToDate && (
            <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
              {previewText.upToDate}
            </div>
          )}
          {previewText.notPulled && (
            <PullPreviewList
              summary={previewText.notPulled}
              items={plan.notPulled.map((s) => ({ path: s.path, note: s.reason }))}
            />
          )}

          {previewText.nothingToPull ? (
            <button
              className="button full"
              type="button"
              onClick={reset}
              style={{ marginTop: 8 }}
            >
              OK
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (canConfirm) void apply();
              }}
              style={{ marginTop: 8 }}
            >
              {confirmationWord !== null && (
                <>
                  <label
                    htmlFor="pull-confirm-word"
                    style={{ display: 'block', fontSize: 11.5, marginBottom: 4 }}
                  >
                    To confirm, type <strong>{confirmationWord}</strong>
                  </label>
                  <input
                    id="pull-confirm-word"
                    type="text"
                    value={typedConfirmation}
                    onChange={(e) => setTypedConfirmation(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </>
              )}
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <button
                  className="button primary"
                  type="submit"
                  disabled={!canConfirm}
                  style={{ flex: 1 }}
                >
                  {previewText.confirmLabel}
                </button>
                <button className="button" type="button" onClick={reset}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {(mode === 'planning' || mode === 'applying') && (
        <div className="progress-text" role="status" aria-live="polite" style={{ marginTop: 8 }}>
          <span className="spinner" aria-hidden="true" />
          {step || (mode === 'planning' ? 'Checking what would change…' : 'Pulling…')}
        </div>
      )}

      {mode === 'error' && error && (
        <>
          <div className="banner error" role="alert" style={{ marginTop: 8 }}>
            {error}
            {errorRecovery && (
              <div className="muted" style={{ marginTop: 6 }}>
                What to try: {errorRecovery}
              </div>
            )}
          </div>
          <button
            className="button full"
            type="button"
            onClick={reset}
            style={{ marginTop: 6 }}
          >
            Dismiss
          </button>
        </>
      )}

      {mode === 'done' && summary && (
        <>
          {commitSha && (
            <div className="muted" style={{ marginTop: 8, fontSize: 11.5 }}>
              Pulled from GitHub commit <code>{commitSha.substring(0, 7)}</code>
            </div>
          )}
          <div
            className={`banner ${anyProblem ? 'warning' : 'success'}`}
            role="status"
            style={{ marginTop: 6, fontSize: 12 }}
          >
            {summary}
          </div>
          <PullResultList
            title="Text files already in Overleaf"
            kind="doc"
            rows={results}
          />
          <PullResultList title="New text files" kind="create" rows={createResults} />
          <PullResultList
            title="Images, PDFs and other non-text files"
            kind="upload"
            rows={binaryResults}
          />
          <PullResultList
            title="Uploaded files replaced with the GitHub version"
            kind="replaceFile"
            rows={fileReplaceResults}
          />
          <PullResultList
            title="Files deleted from Overleaf"
            kind="delete"
            rows={deleteResults}
          />
          {(notInOverleaf.length > 0 || sourceSkipped.length > 0) && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11.5 }}>
                Files not pulled (
                {notInOverleaf.length + sourceSkipped.length})
              </summary>
              <ul style={{ marginTop: 4, fontSize: 11.5, paddingLeft: 16 }}>
                {notInOverleaf.map((p) => (
                  <li key={`no-${p}`}>
                    <code>{p}</code> — not in Overleaf yet (tick{' '}
                    <em>Also create new files in Overleaf</em>)
                  </li>
                ))}
                {binaryItems.map((s) => (
                  <li key={`bin-${s.path}`}>
                    <code>{s.path}</code> — not a known text file type (turn on{' '}
                    <em>Allow uploading new images and other non-text files</em>{' '}
                    in Options)
                  </li>
                ))}
                {extFilteredItems.map((s) => (
                  <li key={`ext-${s.path}`}>
                    <code>{s.path}</code> — file type not in Options →{' '}
                    <em>Allowed write-back extensions</em>
                  </li>
                ))}
                {linkItems.map((s) => (
                  <li key={`link-${s.path}`}>
                    <code>{s.path}</code> — a symbolic link on GitHub, which
                    Overleaf can&apos;t hold
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button
            className="button full"
            type="button"
            onClick={reset}
            style={{ marginTop: 6 }}
          >
            Done
          </button>
        </>
      )}
    </section>
  );
}

// One group of a finished pull's result rows, collapsed under its title.
function PullResultList({
  title,
  kind,
  rows,
}: {
  title: string;
  kind: 'doc' | 'create' | 'upload' | 'replaceFile' | 'delete';
  rows: Array<WriteBackResult | CreateResult | BinaryResult | FileReplaceResult | DeleteResult> | null;
}): React.ReactElement | null {
  if (!rows || rows.length === 0) return null;
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ cursor: 'pointer', fontSize: 11.5 }}>
        {title} ({rows.length})
      </summary>
      <ul style={{ marginTop: 4, fontSize: 11.5, paddingLeft: 16, overflowWrap: 'anywhere' }}>
        {rows.map((r, i) => {
          const label = pullResultLabel(kind, r.status);
          const message = pullRowMessage(label, r.message);
          return (
            <li key={i}>
              <strong>{label}</strong> —{' '}
              <code>{'kind' in r && r.kind === 'folder' ? `${r.path}/` : r.path}</code>
              {message ? `: ${message}` : ''}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// Files listed in the pull preview. With a summary line the list starts
// collapsed under it; without one it is shown, collapsed only when long.
const PREVIEW_LIST_SHOWN_MAX = 8;

function PullPreviewList({
  summary,
  items,
  open,
}: {
  summary?: string;
  items: Array<{ path: string; note?: string }>;
  // Start expanded: used for the files a pull deletes or replaces, which the
  // user should read before confirming.
  open?: boolean;
}): React.ReactElement {
  const list = (
    <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 11.5, overflowWrap: 'anywhere' }}>
      {items.map((item) => (
        <li key={item.path}>
          <code>{item.path}</code>
          {item.note ? <> — {item.note}</> : null}
        </li>
      ))}
    </ul>
  );
  if (!summary && items.length <= PREVIEW_LIST_SHOWN_MAX) return list;
  return (
    <details style={{ marginTop: 6 }} open={open}>
      <summary style={{ cursor: 'pointer', fontSize: 11.5 }}>
        {summary ?? `Show all ${items.length} files`}
      </summary>
      {list}
    </details>
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
      return 'Overleaf tab';
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
          {phase.snapshot.warnings.length} file{phase.snapshot.warnings.length === 1 ? '' : 's'}{' '}
          couldn't be read, so this snapshot may be incomplete.{' '}
          <strong>Deletions are off</strong> so those files aren't removed from
          GitHub. To commit deletions, go Back and use{' '}
          <em>Fetch from current Overleaf project</em>.
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
              <span className="muted"> — off because some files couldn't be read</span>
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
          title={
            !actionable
              ? 'No changes to commit'
              : phase.commitMessage.trim().length === 0
                ? 'Enter a commit message'
                : 'Commit to GitHub'
          }
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
            {item.warning && <span className="diff-row-warning">{item.warning}</span>}
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
  manualZipEnabled,
  allowManualFallback,
  manualZipTip,
  onRetry,
  onChooseFile,
  inputRef,
}: {
  message: string;
  recovery?: string;
  manualZipEnabled: boolean;
  allowManualFallback: boolean;
  manualZipTip: boolean;
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
            What to try: {recovery}
          </div>
        )}
      </div>
      {!manualZipEnabled && manualZipTip && (
        <div className="muted">{MANUAL_ZIP_OPTIONS_TIP}</div>
      )}
      {manualZipEnabled && allowManualFallback && (
        <div className="file-input">
          <label htmlFor="zipInputFallback">
            Or download the project yourself in Overleaf ({MANUAL_ZIP_MENU})
            and choose that file here
          </label>
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
        Start over
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
