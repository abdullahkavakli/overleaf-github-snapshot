import React, { useEffect, useState } from 'react';
import type {
  ConnectionTestResult,
  ExperimentalConfig,
  ProjectLink,
  ProjectLinkMap,
  RepoConfig,
  UIPreferences,
} from '../shared/types';
import {
  DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS,
  DEFAULT_EXPERIMENTAL_CONFIG,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_REPO_CONFIG,
  DEFAULT_UI_PREFERENCES,
} from '../shared/constants';
import {
  clearExperimentalConfig,
  clearLegacySingleConfig,
  clearProjectLinks,
  clearUIPreferences,
  getExperimentalConfig,
  getProjectLinkMap,
  getUIPreferences,
  isConfigured,
  removeProjectLink,
  setExperimentalConfig,
  setProjectLink,
  setUIPreferences,
} from '../storage/extensionStorage';
import { testConnection } from '../github/githubClient';
import { normalizeOverleafProjectId } from '../overleaf/overleafContext';
import {
  fetchProjectMetadataViaBridge,
  readDocViaBridge,
} from '../overleaf/live/bridgeClient';
import { flattenProjectTree } from '../overleaf/live/overleafProjectLoader';
import { writeSelectedFilesBackToOverleaf } from '../overleaf/live/overleafWriteBack';
import type { WriteBackCandidate, WriteBackResult } from '../overleaf/live/types';
import { computeSha256 } from '../diff/fileHasher';
import { sourceFromGitHubBranch } from '../sources/sourceFromGitHubBranch';
import {
  createMissingDocsForPull,
  type CreateResult,
} from '../sources/pullFromGitHubHelpers';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

type EditorState = {
  projectId: string;
  isNew: boolean;
  repo: RepoConfig;
  token: string;
  ignoreText: string;
};

export function Options(): React.ReactElement {
  const [links, setLinks] = useState<ProjectLinkMap>({});
  const [loaded, setLoaded] = useState<boolean>(false);
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [experimental, setExperimental] = useState<ExperimentalConfig>(
    DEFAULT_EXPERIMENTAL_CONFIG,
  );
  const [extText, setExtText] = useState<string>(
    DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS.join('\n'),
  );
  const [expSave, setExpSave] = useState<SaveState>({ kind: 'idle' });
  const [uiPrefs, setUiPrefs] = useState<UIPreferences>(DEFAULT_UI_PREFERENCES);
  const [uiPrefsSaveError, setUiPrefsSaveError] = useState<string | null>(null);

  const reload = async () => {
    const map = await getProjectLinkMap();
    setLinks(map);
  };

  useEffect(() => {
    void (async () => {
      const [map, e, ui] = await Promise.all([
        getProjectLinkMap(),
        getExperimentalConfig(),
        getUIPreferences(),
      ]);
      setLinks(map);
      setExperimental(e);
      setExtText(
        (e.allowedWriteBackExtensions ?? DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS).join('\n'),
      );
      setUiPrefs(ui);
      setLoaded(true);
    })();
  }, []);

  // Auto-saves on toggle so users don't have to hunt for a save button on a
  // single-checkbox section. If the write fails we surface the error inline
  // and revert the optimistic state so the UI matches storage.
  const updateUiPrefs = async (next: UIPreferences) => {
    const previous = uiPrefs;
    setUiPrefs(next);
    setUiPrefsSaveError(null);
    try {
      await setUIPreferences(next);
    } catch (e) {
      setUiPrefs(previous);
      setUiPrefsSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const startAdd = () => {
    setEditError(null);
    setEditing({
      projectId: '',
      isNew: true,
      repo: { ...DEFAULT_REPO_CONFIG },
      token: '',
      ignoreText: DEFAULT_IGNORE_PATTERNS.join('\n'),
    });
  };

  const startEdit = (projectId: string) => {
    const link = links[projectId];
    if (!link) return;
    setEditError(null);
    setEditing({
      projectId,
      isNew: false,
      repo: { ...link.repo },
      token: link.token,
      ignoreText: (link.repo.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS).join('\n'),
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditError(null);

    let projectId = editing.projectId;
    if (editing.isNew) {
      const normalized = normalizeOverleafProjectId(editing.projectId);
      if (!normalized) {
        setEditError(
          'Enter a valid Overleaf project ID or a project URL (https://www.overleaf.com/project/…).',
        );
        return;
      }
      if (links[normalized]) {
        setEditError(`Project ${normalized} is already linked. Edit that mapping instead.`);
        return;
      }
      projectId = normalized;
    }

    const patterns = parseIgnorePatterns(editing.ignoreText);
    const repo: RepoConfig = {
      owner: editing.repo.owner.trim(),
      repo: editing.repo.repo.trim(),
      branch: editing.repo.branch.trim() || 'main',
      targetDir: (editing.repo.targetDir ?? '').trim(),
      includeDeletions: editing.repo.includeDeletions,
      ignorePatterns: patterns.length > 0 ? patterns : [...DEFAULT_IGNORE_PATTERNS],
    };
    const token = editing.token.trim();
    if (!isConfigured(repo)) {
      setEditError('Owner, repository, and branch are required.');
      return;
    }
    if (token.length === 0) {
      setEditError('A GitHub token is required for this project.');
      return;
    }

    const link: ProjectLink = { repo, token };
    await setProjectLink(projectId, link);
    await reload();
    setEditing(null);
  };

  const removeMapping = async (projectId: string) => {
    if (!confirm(`Remove the mapping for project ${projectId}? This does not touch GitHub.`)) {
      return;
    }
    await removeProjectLink(projectId);
    await reload();
    if (editing && !editing.isNew && editing.projectId === projectId) setEditing(null);
  };

  const resetAll = async () => {
    if (
      !confirm(
        'Reset all settings? This clears every project→repo mapping (including tokens), the legacy single config, display preferences, and experimental settings.',
      )
    ) {
      return;
    }
    await Promise.all([
      clearProjectLinks(),
      clearLegacySingleConfig(),
      clearExperimentalConfig(),
      clearUIPreferences(),
    ]);
    setLinks({});
    setEditing(null);
    setExperimental(DEFAULT_EXPERIMENTAL_CONFIG);
    setExtText(DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS.join('\n'));
    setExpSave({ kind: 'idle' });
    setUiPrefs(DEFAULT_UI_PREFERENCES);
    setUiPrefsSaveError(null);
  };

  const saveExperimental = async () => {
    setExpSave({ kind: 'saving' });
    try {
      const exts = parseExtensions(extText);
      const next: ExperimentalConfig = {
        ...experimental,
        allowedWriteBackExtensions:
          exts.length > 0 ? exts : [...DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS],
      };
      await setExperimentalConfig(next);
      setExperimental(next);
      setExpSave({ kind: 'saved' });
      setTimeout(
        () => setExpSave((s) => (s.kind === 'saved' ? { kind: 'idle' } : s)),
        2000,
      );
    } catch (e) {
      setExpSave({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const entries = Object.entries(links);

  return (
    <div className="container">
      <header className="page-header">
        <h1>Overleaf GitHub Snapshot</h1>
        <p className="lead">
          Link each Overleaf project to its own GitHub repository and token.
          When you open a project, the popup automatically resolves its repo.
          Everything is stored locally in <code>chrome.storage.local</code> and
          only sent to <code>api.github.com</code>.
        </p>
      </header>

      <section aria-labelledby="sec-mappings">
        <h2 id="sec-mappings">Project → repository mappings</h2>

        {!loaded ? (
          <p className="lead">Loading…</p>
        ) : entries.length === 0 ? (
          <div className="banner info">
            No mappings yet. Open an Overleaf project tab and the popup will
            prompt you to link it, or add one manually below.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {entries.map(([projectId, link]) => (
              <MappingRow
                key={projectId}
                projectId={projectId}
                link={link}
                isEditing={
                  editing !== null && !editing.isNew && editing.projectId === projectId
                }
                onEdit={() => startEdit(projectId)}
                onRemove={() => removeMapping(projectId)}
              />
            ))}
          </div>
        )}

        {editing ? (
          <MappingEditor
            state={editing}
            error={editError}
            onChange={setEditing}
            onCancel={() => setEditing(null)}
            onSave={saveEdit}
          />
        ) : (
          <div className="actions" style={{ marginTop: 16 }}>
            <button type="button" className="button primary" onClick={startAdd}>
              Add mapping
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="sec-display">
        <h2 id="sec-display">Popup display</h2>
        <div className="checkbox-row">
          <input
            id="alwaysShowManualUpload"
            type="checkbox"
            checked={uiPrefs.alwaysShowManualUpload}
            onChange={(e) =>
              void updateUiPrefs({
                ...uiPrefs,
                alwaysShowManualUpload: e.target.checked,
              })
            }
          />
          <label htmlFor="alwaysShowManualUpload">
            Always show Manual ZIP upload
            <div className="hint">
              By default the popup hides the <em>Manual ZIP upload</em> section
              until <em>Fetch from current Overleaf project</em> fails. Turn
              this on to always show it.
            </div>
          </label>
        </div>
        {uiPrefsSaveError && (
          <div className="banner error" role="alert" style={{ marginTop: 10 }}>
            Save failed: {uiPrefsSaveError}
          </div>
        )}
      </section>

      <section aria-labelledby="sec-experimental" className="experimental-section">
        <h2 id="sec-experimental">Experimental Overleaf Live Sync</h2>
        <div className="banner info" style={{ marginBottom: 14 }}>
          <strong>Experimental.</strong> These features depend on Overleaf
          internals that are not officially documented and may break without
          warning. The stable workflow is the automatic ZIP snapshot. All
          experimental features are disabled by default. These settings are
          global (not per project).
        </div>

        <div className="checkbox-row">
          <input
            id="experimentalLiveSyncEnabled"
            type="checkbox"
            checked={experimental.experimentalLiveSyncEnabled}
            aria-controls="experimental-suboptions"
            aria-expanded={experimental.experimentalLiveSyncEnabled}
            onChange={(e) =>
              setExperimental({
                ...experimental,
                experimentalLiveSyncEnabled: e.target.checked,
              })
            }
          />
          <label htmlFor="experimentalLiveSyncEnabled">
            Enable experimental live sync
            <div className="hint">
              Master switch. When off, the experimental options below are
              hidden, no Live Sync UI is shown in the popup, and no live
              protocol code runs.
            </div>
          </label>
        </div>

        {experimental.experimentalLiveSyncEnabled && (
          <div id="experimental-suboptions" className="experimental-suboptions">
            <div className="checkbox-row" style={{ marginTop: 14 }}>
              <input
                id="liveReadOnlyPullEnabled"
                type="checkbox"
                checked={experimental.liveReadOnlyPullEnabled}
                onChange={(e) =>
                  setExperimental({
                    ...experimental,
                    liveReadOnlyPullEnabled: e.target.checked,
                  })
                }
              />
              <label htmlFor="liveReadOnlyPullEnabled">
                Enable live read-only pull (Overleaf → GitHub)
                <div className="hint">
                  Read every doc and file from Overleaf via the live session,
                  then commit to GitHub. Slower than the ZIP route on large
                  projects. Read-only — never modifies Overleaf. Independent
                  of the write-back toggle below — leave this off if you only
                  want <em>Pull from GitHub into Overleaf</em>.
                </div>
              </label>
            </div>

            <div className="checkbox-row" style={{ marginTop: 14 }}>
              <input
                id="overleafWriteBackEnabled"
                type="checkbox"
                checked={experimental.overleafWriteBackEnabled}
                onChange={(e) =>
                  setExperimental({
                    ...experimental,
                    overleafWriteBackEnabled: e.target.checked,
                  })
                }
              />
              <label htmlFor="overleafWriteBackEnabled">
                Enable Overleaf write-back (GitHub → Overleaf)
                <div className="hint">
                  Powers the <em>Pull from GitHub into Overleaf</em> section
                  in the popup, the Pull-from-GitHub dev panel, and the
                  single-doc developer write-back test below. Each write
                  goes through the conflict detector and OT verify path.
                  Independent of the read-only pull toggle above.
                </div>
              </label>
            </div>

            <div className="checkbox-row" style={{ marginTop: 14 }}>
              <input
                id="localReplicaEnabled"
                type="checkbox"
                checked={experimental.localReplicaEnabled}
                onChange={(e) =>
                  setExperimental({
                    ...experimental,
                    localReplicaEnabled: e.target.checked,
                  })
                }
              />
              <label htmlFor="localReplicaEnabled">
                Enable local replica prototype
                <div className="hint">
                  Choose a local folder to compare against Overleaf. Browser-only,
                  no background sync, no silent overwrites. Requires the File System
                  Access API.
                </div>
              </label>
            </div>

            <div className="checkbox-row" style={{ marginTop: 14 }}>
              <input
                id="requireZipBackupBeforeWriteBack"
                type="checkbox"
                disabled={!experimental.overleafWriteBackEnabled}
                checked={experimental.requireZipBackupBeforeWriteBack}
                onChange={(e) =>
                  setExperimental({
                    ...experimental,
                    requireZipBackupBeforeWriteBack: e.target.checked,
                  })
                }
              />
              <label htmlFor="requireZipBackupBeforeWriteBack">
                Require ZIP backup before write-back
                <div className="hint">
                  Fetch a fresh ZIP snapshot before writing any change to Overleaf.
                  Strongly recommended.
                </div>
              </label>
            </div>

            <div className="checkbox-row" style={{ marginTop: 14 }}>
              <input
                id="requireConfirmationBeforeWriteBack"
                type="checkbox"
                disabled={!experimental.overleafWriteBackEnabled}
                checked={experimental.requireConfirmationBeforeWriteBack}
                onChange={(e) =>
                  setExperimental({
                    ...experimental,
                    requireConfirmationBeforeWriteBack: e.target.checked,
                  })
                }
              />
              <label htmlFor="requireConfirmationBeforeWriteBack">
                Require confirmation before each write-back
                <div className="hint">
                  Show the changed file list and require explicit typed confirmation
                  before any write. Strongly recommended.
                </div>
              </label>
            </div>

            <div className="checkbox-row" style={{ marginTop: 14 }}>
              <input
                id="allowBinaryWriteBack"
                type="checkbox"
                disabled={!experimental.overleafWriteBackEnabled}
                checked={experimental.allowBinaryWriteBack}
                onChange={(e) =>
                  setExperimental({
                    ...experimental,
                    allowBinaryWriteBack: e.target.checked,
                  })
                }
              />
              <label htmlFor="allowBinaryWriteBack">
                Allow binary file write-back
                <div className="hint">
                  Off by default. Write-back is generally limited to text source
                  files. Binaries are riskier to overwrite.
                </div>
              </label>
            </div>

            <div className="field" style={{ marginTop: 18 }}>
              <label htmlFor="writeBackExts">Allowed write-back extensions</label>
              <textarea
                id="writeBackExts"
                value={extText}
                disabled={!experimental.overleafWriteBackEnabled}
                onChange={(e) => setExtText(e.target.value)}
                spellCheck={false}
                style={{ minHeight: 110 }}
              />
              <div className="hint">
                One extension per line. Defaults: <code>.tex</code>, <code>.bib</code>,{' '}
                <code>.cls</code>, <code>.sty</code>, <code>.bst</code>, <code>.md</code>,{' '}
                <code>.txt</code>.
              </div>
            </div>

            {experimental.overleafWriteBackEnabled && (
              <>
                <WriteBackDevPanel experimental={experimental} />
                <PullFromGitHubDevPanel
                  links={links}
                  experimental={experimental}
                />
              </>
            )}
          </div>
        )}

        <div className="actions" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="button primary"
            onClick={saveExperimental}
            disabled={expSave.kind === 'saving'}
            aria-busy={expSave.kind === 'saving'}
          >
            {expSave.kind === 'saving' ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Saving…
              </>
            ) : (
              'Save experimental settings'
            )}
          </button>
          <span
            className={
              expSave.kind === 'saved'
                ? 'save-status ok'
                : expSave.kind === 'error'
                  ? 'save-status err'
                  : 'save-status'
            }
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {expSave.kind === 'saved' && 'Saved.'}
            {expSave.kind === 'error' && `Save failed: ${expSave.message}`}
          </span>
        </div>
      </section>

      <div className="actions">
        <button type="button" className="button" onClick={resetAll}>
          Reset all settings
        </button>
      </div>
    </div>
  );
}

function MappingRow({
  projectId,
  link,
  isEditing,
  onEdit,
  onRemove,
}: {
  projectId: string;
  link: ProjectLink;
  isEditing: boolean;
  onEdit: () => void;
  onRemove: () => void;
}): React.ReactElement {
  const [test, setTest] = useState<
    { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; result: ConnectionTestResult }
  >({ kind: 'idle' });

  const runTest = async () => {
    setTest({ kind: 'running' });
    const result = await testConnection(link.token, link.repo);
    setTest({ kind: 'done', result });
  };

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '12px 14px',
        background: 'var(--bg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            <code>{link.repo.owner}/{link.repo.repo}</code>
          </div>
          <div className="hint" style={{ marginTop: 2 }}>
            Project <code>{projectId}</code> · branch <code>{link.repo.branch}</code>
            {link.repo.targetDir ? (
              <>
                {' '}· dir <code>{link.repo.targetDir}/</code>
              </>
            ) : null}{' '}
            · token {link.token.trim().length > 0 ? 'set' : <strong>missing</strong>}
          </div>
        </div>
        <div className="actions" style={{ paddingTop: 0 }}>
          <button
            type="button"
            className="button"
            onClick={runTest}
            disabled={test.kind === 'running'}
            aria-busy={test.kind === 'running'}
          >
            {test.kind === 'running' ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Testing…
              </>
            ) : (
              'Test'
            )}
          </button>
          <button type="button" className="button" onClick={onEdit} disabled={isEditing}>
            {isEditing ? 'Editing…' : 'Edit'}
          </button>
          <button type="button" className="button" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
      {test.kind === 'done' && (
        <div
          aria-live="polite"
          role={test.result.ok ? 'status' : 'alert'}
        >
          <TestResultView result={test.result} />
        </div>
      )}
    </div>
  );
}

function MappingEditor({
  state,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  state: EditorState;
  error: string | null;
  onChange: (s: EditorState) => void;
  onCancel: () => void;
  onSave: () => void;
}): React.ReactElement {
  const [showToken, setShowToken] = useState<boolean>(false);
  const setRepo = (patch: Partial<RepoConfig>) =>
    onChange({ ...state, repo: { ...state.repo, ...patch } });

  return (
    <div
      style={{
        border: '1px solid var(--accent)',
        borderRadius: 8,
        padding: '18px 18px',
        marginTop: 16,
        background: 'var(--bg)',
      }}
    >
      <h2 style={{ marginTop: 0 }}>
        {state.isNew ? 'Add a project mapping' : `Edit mapping`}
      </h2>

      {state.isNew && (
        <div className="field">
          <label htmlFor="ed-pid">
            Overleaf project ID or URL{' '}
            <span className="required" aria-hidden="true">*</span>
          </label>
          <input
            id="ed-pid"
            className="mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={state.projectId}
            placeholder="65ab… or https://www.overleaf.com/project/65ab…"
            onChange={(e) => onChange({ ...state, projectId: e.target.value })}
          />
          <div className="hint">
            Paste the project URL from your browser, or just the ID segment.
          </div>
        </div>
      )}

      {!state.isNew && (
        <div className="field">
          <label>Overleaf project</label>
          <div>
            <code>{state.projectId}</code>
          </div>
        </div>
      )}

      <div className="row">
        <div className="field">
          <label htmlFor="ed-owner">
            Owner <span className="required" aria-hidden="true">*</span>
          </label>
          <input
            id="ed-owner"
            className="mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={state.repo.owner}
            placeholder="username-or-org"
            onChange={(e) => setRepo({ owner: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="ed-repo">
            Repository <span className="required" aria-hidden="true">*</span>
          </label>
          <input
            id="ed-repo"
            className="mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={state.repo.repo}
            placeholder="repo-name"
            onChange={(e) => setRepo({ repo: e.target.value })}
          />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="ed-branch">Branch</label>
          <input
            id="ed-branch"
            className="mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={state.repo.branch}
            placeholder="main"
            onChange={(e) => setRepo({ branch: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="ed-dir">Target directory</label>
          <input
            id="ed-dir"
            className="mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={state.repo.targetDir ?? ''}
            placeholder="paper"
            onChange={(e) => setRepo({ targetDir: e.target.value })}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="ed-token">
          GitHub token <span className="required" aria-hidden="true">*</span>
        </label>
        <div className="token-row">
          <input
            id="ed-token"
            className="mono"
            type={showToken ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={state.token}
            placeholder="github_pat_…"
            onChange={(e) => onChange({ ...state, token: e.target.value })}
          />
          <button
            type="button"
            className="toggle"
            aria-pressed={showToken}
            aria-label={showToken ? 'Hide token' : 'Show token'}
            onClick={() => setShowToken((v) => !v)}
          >
            {showToken ? 'Hide' : 'Show'}
          </button>
        </div>
        <div className="hint">
          Use a <strong>fine-grained personal access token</strong> scoped to{' '}
          <em>only this repository</em>, with <code>Contents: Read and write</code>{' '}
          and <code>Metadata: Read</code> permissions.
        </div>
      </div>

      <div className="checkbox-row">
        <input
          id="ed-deletions"
          type="checkbox"
          checked={state.repo.includeDeletions}
          onChange={(e) => setRepo({ includeDeletions: e.target.checked })}
        />
        <label htmlFor="ed-deletions">
          Include deletions by default
          <div className="hint">
            When enabled, files present in the repo but missing from the source
            are removed (only inside the target directory). Toggleable per
            commit in the popup.
          </div>
        </label>
      </div>

      <div className="field" style={{ marginTop: 18 }}>
        <label htmlFor="ed-ignore">Ignore patterns (one per line)</label>
        <textarea
          id="ed-ignore"
          value={state.ignoreText}
          onChange={(e) => onChange({ ...state, ignoreText: e.target.value })}
          spellCheck={false}
        />
        <div className="hint">
          Glob-like patterns matched against source paths. <code>*</code> for any
          non-slash chars, <code>**</code> across slashes. <code>#</code> lines
          are comments.
        </div>
      </div>

      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}

      <div className="actions">
        <button type="button" className="button primary" onClick={onSave}>
          {state.isNew ? 'Add mapping' : 'Save changes'}
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Developer harness for the experimental write-back path. Picks a doc
// by path via the live bridge (LIVE_FETCH_PROJECT_METADATA -> doc id ->
// LIVE_READ_DOC), lets the user edit, then runs the full
// writeSelectedFilesBackToOverleaf orchestration so all the existing
// safety gates (ZIP backup, conflict detector, OT, verify-after-write)
// are exercised end-to-end. Honors the user's experimental config
// (allowed extensions, allowBinary, requireZipBackup). Manual confirmation
// is the click on "Write back" itself, so requireConfirmation is wired
// to false here regardless of the persisted toggle.
function WriteBackDevPanel({
  experimental,
}: {
  experimental: ExperimentalConfig;
}): React.ReactElement {
  const [projectId, setProjectId] = useState<string>('');
  const [docPath, setDocPath] = useState<string>('');
  const [baseText, setBaseText] = useState<string>('');
  const [newText, setNewText] = useState<string>('');
  const [haveBase, setHaveBase] = useState<boolean>(false);
  const [busy, setBusy] = useState<'idle' | 'reading' | 'writing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<WriteBackResult[] | null>(null);

  const trimmedProjectId = projectId.trim();
  const trimmedPath = docPath.trim();

  const onRead = async () => {
    setError(null);
    setResults(null);
    setBusy('reading');
    try {
      const md = await fetchProjectMetadataViaBridge(trimmedProjectId);
      if (!md.ok) {
        throw new Error(`metadata: ${md.message}`);
      }
      const entries = flattenProjectTree(md.data.rootFolder);
      const entry = entries.find((e) => e.path === trimmedPath && e.kind === 'doc');
      if (!entry || !entry.id) {
        const docs = entries.filter((e) => e.kind === 'doc').map((e) => e.path);
        const sample = docs.slice(0, 8).join(', ');
        throw new Error(
          `No doc at path "${trimmedPath}". First docs in this project: ${sample}${docs.length > 8 ? '…' : ''}`,
        );
      }
      const read = await readDocViaBridge(trimmedProjectId, entry.id);
      if (!read.ok) {
        throw new Error(`read: ${read.message}`);
      }
      setBaseText(read.data.text);
      setNewText(read.data.text);
      setHaveBase(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  };

  const onWrite = async () => {
    setError(null);
    setResults(null);
    setBusy('writing');
    try {
      const enc = new TextEncoder();
      const baseSha256 = await computeSha256(enc.encode(baseText));
      const out = await writeSelectedFilesBackToOverleaf(
        trimmedProjectId,
        [{ path: trimmedPath, oldText: baseText, newText, baseSha256 }],
        {
          requireZipBackup: experimental.requireZipBackupBeforeWriteBack,
          requireConfirmation: false,
          allowedExtensions: experimental.allowedWriteBackExtensions,
          allowBinary: experimental.allowBinaryWriteBack,
        },
      );
      setResults(out);
      // If the write succeeded, advance the base so the user can iterate.
      const written = out.find((r) => r.path === trimmedPath && r.status === 'written');
      if (written) setBaseText(newText);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  };

  const canRead =
    trimmedProjectId.length > 0 && trimmedPath.length > 0 && busy === 'idle';
  const canWrite = haveBase && newText !== baseText && busy === 'idle';

  return (
    <div
      style={{
        marginTop: 22,
        padding: '14px 14px 16px',
        border: '1px dashed var(--border)',
        borderRadius: 8,
      }}
    >
      <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>
        Developer write-back test
      </h3>
      <div className="hint" style={{ marginBottom: 12 }}>
        Manual validation harness for the live write-back path. Reads a
        single doc from Overleaf via the content-script bridge, lets you
        edit it, then writes it back through the full safety pipeline
        (ZIP backup, conflict detector, OT, verify-after-write). Honors
        the toggles above. Use against a throwaway project until you have
        confirmed the four outcomes behave correctly.
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="wb-pid">Overleaf project ID</label>
          <input
            id="wb-pid"
            className="mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. 65ab…"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="wb-path">Doc path</label>
          <input
            id="wb-path"
            className="mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="main.tex"
            value={docPath}
            onChange={(e) => setDocPath(e.target.value)}
          />
        </div>
      </div>

      <div className="actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="button"
          onClick={onRead}
          disabled={!canRead}
          aria-busy={busy === 'reading'}
        >
          {busy === 'reading' ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Reading…
            </>
          ) : (
            'Read current'
          )}
        </button>
      </div>

      {haveBase && (
        <>
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="wb-base">Base text (from Overleaf)</label>
            <textarea
              id="wb-base"
              value={baseText}
              readOnly
              spellCheck={false}
              style={{ minHeight: 120 }}
            />
          </div>
          <div className="field">
            <label htmlFor="wb-new">New text (your edits)</label>
            <textarea
              id="wb-new"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              spellCheck={false}
              style={{ minHeight: 160 }}
            />
          </div>
          <div className="actions">
            <button
              type="button"
              className="button primary"
              onClick={onWrite}
              disabled={!canWrite}
              aria-busy={busy === 'writing'}
            >
              {busy === 'writing' ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Writing…
                </>
              ) : (
                'Write back'
              )}
            </button>
          </div>
        </>
      )}

      {error && (
        <div className="banner error" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      {results && (
        <div style={{ marginTop: 10 }}>
          {results.map((r, i) => (
            <div
              key={i}
              className={`banner ${
                r.status === 'written'
                  ? 'success'
                  : r.status === 'conflict' || r.status === 'failed'
                    ? 'error'
                    : 'info'
              }`}
              role={r.status === 'written' ? 'status' : 'alert'}
              style={{ marginTop: 6 }}
            >
              <strong>{r.status}</strong> — <code>{r.path}</code>
              {r.message ? `: ${r.message}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// "Pull from GitHub" — reverse-direction sibling of WriteBackDevPanel.
//
// Reads the branch HEAD of the chosen project's linked repo, then
// loops every text file through the existing write-back orchestration:
//
//   GitHub tree (text blobs only, filtered to allowedExtensions later
//                in writeSelectedFilesBackToOverleaf)
//     -> resolve doc IDs via the live bridge
//     -> per-file: read current Overleaf as baseText (the popup's
//        re-read defends against TOCTOU between read and write)
//     -> writeSelectedFilesBackToOverleaf (ZIP backup if enabled,
//        conflict detector, OT diff, applyOtUpdate, verify-after-write)
//
// First-cut scope:
//   - Text files only.
//   - Files in GitHub with no matching Overleaf doc are reported as
//     skipped (new-file creation lives in a later phase).
//   - Files in Overleaf with no GitHub source are untouched.
//   - No preview; the existing per-file safety gates carry the load.
function PullFromGitHubDevPanel({
  links,
  experimental,
}: {
  links: ProjectLinkMap;
  experimental: ExperimentalConfig;
}): React.ReactElement {
  const entries = Object.entries(links);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    entries[0]?.[0] ?? '',
  );
  const [busy, setBusy] = useState<'idle' | 'pulling'>('idle');
  const [phase, setPhase] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<WriteBackResult[] | null>(null);
  const [createResults, setCreateResults] = useState<CreateResult[] | null>(null);
  const [noOverleafDocs, setNoOverleafDocs] = useState<string[]>([]);
  const [binarySkipped, setBinarySkipped] = useState<string[]>([]);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [createMissing, setCreateMissing] = useState<boolean>(false);

  const onPull = async () => {
    setError(null);
    setResults(null);
    setCreateResults(null);
    setNoOverleafDocs([]);
    setBinarySkipped([]);
    setCommitSha(null);
    setBusy('pulling');

    const link = links[selectedProjectId];
    if (!link) {
      setError(`No mapping found for ${selectedProjectId}.`);
      setBusy('idle');
      return;
    }

    try {
      // 1. Fetch the GitHub branch.
      setPhase('Fetching GitHub branch…');
      const snapshot = await sourceFromGitHubBranch(link.token, link.repo, {
        allowedExtensions: experimental.allowedWriteBackExtensions,
      });
      setCommitSha(snapshot.commitSha);
      setBinarySkipped(snapshot.skipped.map((s) => s.path));

      if (snapshot.files.length === 0) {
        setError(
          `GitHub branch ${link.repo.branch} contains no pullable text files${link.repo.targetDir ? ` under ${link.repo.targetDir}/` : ''}.`,
        );
        return;
      }

      // 2. Resolve Overleaf doc IDs by path.
      setPhase('Resolving Overleaf docs…');
      const md = await fetchProjectMetadataViaBridge(selectedProjectId);
      if (!md.ok) {
        throw new Error(`Overleaf metadata: ${md.message}`);
      }
      const overleafEntries = flattenProjectTree(md.data.rootFolder);
      const docIdByPath = new Map<string, string>();
      for (const entry of overleafEntries) {
        if (entry.kind === 'doc' && entry.id) docIdByPath.set(entry.path, entry.id);
      }

      // 3. Build candidates: read current Overleaf per matching path,
      //    use that as baseText so the in-pipeline TOCTOU conflict check
      //    has something meaningful to compare.
      const candidates: WriteBackCandidate[] = [];
      const toCreate: { path: string; content: string }[] = [];
      const enc = new TextEncoder();
      let i = 0;
      for (const file of snapshot.files) {
        i++;
        const docId = docIdByPath.get(file.path);
        if (!docId) {
          toCreate.push({ path: file.path, content: file.text ?? '' });
          continue;
        }
        setPhase(
          `Reading ${i}/${snapshot.files.length} from Overleaf: ${file.path}…`,
        );
        const read = await readDocViaBridge(selectedProjectId, docId);
        if (!read.ok) {
          // Surface as a failed result so the user can see the path that
          // tripped, rather than aborting the whole pull.
          candidates.push({
            path: file.path,
            oldText: '',
            newText: file.text ?? '',
            baseSha256: '',
          });
          continue;
        }
        const baseText = read.data.text;
        const baseSha256 = await computeSha256(enc.encode(baseText));
        candidates.push({
          path: file.path,
          oldText: baseText,
          newText: file.text ?? '',
          baseSha256,
        });
      }
      setNoOverleafDocs(toCreate.map((c) => c.path));

      if (candidates.length === 0 && !(createMissing && toCreate.length > 0)) {
        setError(
          `None of the GitHub files have a matching doc in Overleaf. ${toCreate.length} file(s) would need to be created — turn on "Also create new files" to add them.`,
        );
        return;
      }

      // 4. Run write-back orchestration with the existing safety gates.
      if (candidates.length > 0) {
        setPhase(`Writing ${candidates.length} file(s) back to Overleaf…`);
        const out = await writeSelectedFilesBackToOverleaf(
          selectedProjectId,
          candidates,
          {
            requireZipBackup: experimental.requireZipBackupBeforeWriteBack,
            requireConfirmation: false,
            allowedExtensions: experimental.allowedWriteBackExtensions,
            allowBinary: experimental.allowBinaryWriteBack,
          },
        );
        setResults(out);
      }

      // 5. Create missing files if opted in. Independent of write-back —
      //    a writeBack failure on file X doesn't block creating file Y.
      if (createMissing && toCreate.length > 0) {
        const created = await createMissingDocsForPull(
          selectedProjectId,
          toCreate,
          experimental.allowedWriteBackExtensions,
          setPhase,
        );
        setCreateResults(created);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
      setPhase('');
    }
  };

  if (entries.length === 0) {
    return (
      <div
        style={{
          marginTop: 22,
          padding: '14px 14px 16px',
          border: '1px dashed var(--border)',
          borderRadius: 8,
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>
          Pull from GitHub into Overleaf
        </h3>
        <div className="hint">
          Add a project → repo mapping above before you can pull from GitHub
          into Overleaf.
        </div>
      </div>
    );
  }

  const summary =
    results || createResults
      ? {
          written: results?.filter((r) => r.status === 'written').length ?? 0,
          skipped: results?.filter((r) => r.status === 'skipped').length ?? 0,
          conflict: results?.filter((r) => r.status === 'conflict').length ?? 0,
          failed: results?.filter((r) => r.status === 'failed').length ?? 0,
          created: createResults?.filter((r) => r.status === 'created').length ?? 0,
          createFailed: createResults?.filter((r) => r.status === 'failed').length ?? 0,
          createSkipped: createResults?.filter((r) => r.status === 'skipped').length ?? 0,
        }
      : null;

  return (
    <div
      style={{
        marginTop: 22,
        padding: '14px 14px 16px',
        border: '1px dashed var(--border)',
        borderRadius: 8,
      }}
    >
      <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>
        Pull from GitHub into Overleaf
      </h3>
      <div className="hint" style={{ marginBottom: 12 }}>
        Reverses the snapshot direction: reads the branch HEAD of the
        linked GitHub repo and writes every matching text file back to
        Overleaf via the live bridge. Text files only in this build;
        files present in GitHub but not in Overleaf are reported as
        skipped (new-file creation comes later). Each write goes through
        the same safety pipeline as the write-back test panel above.
      </div>

      <div className="field">
        <label htmlFor="pgh-pid">Linked project</label>
        <select
          id="pgh-pid"
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
        >
          {entries.map(([pid, link]) => (
            <option key={pid} value={pid}>
              {pid} → {link.repo.owner}/{link.repo.repo}@{link.repo.branch}
              {link.repo.targetDir ? ` (${link.repo.targetDir}/)` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="checkbox-row" style={{ marginTop: 8 }}>
        <input
          id="pgh-create-missing"
          type="checkbox"
          checked={createMissing}
          onChange={(e) => setCreateMissing(e.target.checked)}
        />
        <label htmlFor="pgh-create-missing">
          Also create new files in Overleaf
          <div className="hint">
            For each GitHub file with no matching Overleaf doc, create
            the doc (and any missing parent folders) and seed it with the
            GitHub content. Filtered by your allowed write-back
            extensions. Off by default — flip on intentionally.
          </div>
        </label>
      </div>

      <div className="actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="button primary"
          onClick={onPull}
          disabled={busy !== 'idle' || !selectedProjectId}
          aria-busy={busy === 'pulling'}
        >
          {busy === 'pulling' ? (
            <>
              <span className="spinner" aria-hidden="true" />
              {phase || 'Pulling…'}
            </>
          ) : (
            'Pull from GitHub into Overleaf'
          )}
        </button>
      </div>

      {error && (
        <div className="banner error" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      {commitSha && (
        <div className="hint" style={{ marginTop: 10 }}>
          GitHub HEAD: <code>{commitSha.substring(0, 7)}</code>
        </div>
      )}

      {summary && (
        <div
          className={`banner ${summary.failed + summary.conflict + summary.createFailed === 0 ? 'success' : 'info'}`}
          role="status"
          style={{ marginTop: 10 }}
        >
          <strong>Summary:</strong> {summary.written} written, {summary.skipped} skipped, {summary.conflict} conflict, {summary.failed} failed
          {(summary.created > 0 ||
            summary.createFailed > 0 ||
            summary.createSkipped > 0) && (
            <>
              , {summary.created} created, {summary.createFailed} create-failed
              {summary.createSkipped > 0 && <>, {summary.createSkipped} create-skipped</>}
            </>
          )}
          {noOverleafDocs.length > 0 && !createResults && (
            <>, {noOverleafDocs.length} file(s) not present in Overleaf</>
          )}
          {binarySkipped.length > 0 && (
            <>, {binarySkipped.length} binary/unknown file(s) in GitHub not pulled</>
          )}
        </div>
      )}

      {results && results.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Write results
          </div>
          {results.map((r, i) => (
            <div
              key={i}
              className={`banner ${
                r.status === 'written'
                  ? 'success'
                  : r.status === 'conflict' || r.status === 'failed'
                    ? 'error'
                    : 'info'
              }`}
              role={r.status === 'written' ? 'status' : 'alert'}
              style={{ marginTop: 6, fontSize: 12 }}
            >
              <strong>{r.status}</strong> — <code>{r.path}</code>
              {r.message ? `: ${r.message}` : ''}
            </div>
          ))}
        </div>
      )}

      {createResults && createResults.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Create results
          </div>
          {createResults.map((r, i) => (
            <div
              key={i}
              className={`banner ${
                r.status === 'created'
                  ? 'success'
                  : r.status === 'failed'
                    ? 'error'
                    : 'info'
              }`}
              role={r.status === 'created' ? 'status' : 'alert'}
              style={{ marginTop: 6, fontSize: 12 }}
            >
              <strong>{r.status}</strong> — <code>{r.path}</code>
              {r.message ? `: ${r.message}` : ''}
            </div>
          ))}
        </div>
      )}

      {(noOverleafDocs.length > 0 || binarySkipped.length > 0) && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12 }}>
            Show files not pulled (
            {noOverleafDocs.length + binarySkipped.length})
          </summary>
          <ul style={{ marginTop: 6, fontSize: 12 }}>
            {noOverleafDocs.map((p) => (
              <li key={`no-${p}`}>
                <code>{p}</code> — not present in Overleaf (would need
                file-creation, not yet supported)
              </li>
            ))}
            {binarySkipped.map((p) => (
              <li key={`bin-${p}`}>
                <code>{p}</code> — binary or unknown extension (text-only
                in this build)
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function TestResultView({ result }: { result: ConnectionTestResult }): React.ReactElement {
  return (
    <div className={`test-result ${result.ok ? 'ok' : 'fail'}`}>
      <div className={`headline ${result.ok ? 'ok' : 'fail'}`}>
        <StatusIcon ok={result.ok} />
        {result.ok ? 'Connection OK' : 'Connection failed'}
      </div>
      {result.user && (
        <div className="row-detail">
          <span className="label">Authenticated as</span>
          <code>{result.user.login}</code>
        </div>
      )}
      {typeof result.branchFound === 'boolean' && (
        <div className="row-detail">
          <span className="label">Branch found</span>
          <code>{result.branchFound ? 'yes' : 'no'}</code>
          {result.defaultBranch && (
            <>
              <span className="label" style={{ marginLeft: 6 }}>
                default
              </span>
              <code>{result.defaultBranch}</code>
            </>
          )}
        </div>
      )}
      {typeof result.contentsPermission === 'boolean' && (
        <div className="row-detail">
          <span className="label">Contents write permission</span>
          <code>{result.contentsPermission ? 'yes' : 'no'}</code>
        </div>
      )}
      {result.error && <div className="error-text">{result.error}</div>}
    </div>
  );
}

function StatusIcon({ ok }: { ok: boolean }): React.ReactElement {
  if (ok) {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function parseIgnorePatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function parseExtensions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0)
    .map((l) => (l.startsWith('.') ? l : `.${l}`));
}
