import React, { useEffect, useState } from 'react';
import type {
  ConnectionTestResult,
  ExperimentalConfig,
  ProjectLink,
  ProjectLinkMap,
  RepoConfig,
} from '../shared/types';
import {
  DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS,
  DEFAULT_EXPERIMENTAL_CONFIG,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_REPO_CONFIG,
} from '../shared/constants';
import {
  clearExperimentalConfig,
  clearLegacySingleConfig,
  clearProjectLinks,
  getExperimentalConfig,
  getProjectLinkMap,
  isConfigured,
  removeProjectLink,
  setExperimentalConfig,
  setProjectLink,
} from '../storage/extensionStorage';
import { testConnection } from '../github/githubClient';
import { normalizeOverleafProjectId } from '../overleaf/overleafContext';

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

  const reload = async () => {
    const map = await getProjectLinkMap();
    setLinks(map);
  };

  useEffect(() => {
    void (async () => {
      const [map, e] = await Promise.all([
        getProjectLinkMap(),
        getExperimentalConfig(),
      ]);
      setLinks(map);
      setExperimental(e);
      setExtText(
        (e.allowedWriteBackExtensions ?? DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS).join('\n'),
      );
      setLoaded(true);
    })();
  }, []);

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
        'Reset all settings? This clears every project→repo mapping (including tokens), the legacy single config, and experimental settings.',
      )
    ) {
      return;
    }
    await Promise.all([
      clearProjectLinks(),
      clearLegacySingleConfig(),
      clearExperimentalConfig(),
    ]);
    setLinks({});
    setEditing(null);
    setExperimental(DEFAULT_EXPERIMENTAL_CONFIG);
    setExtText(DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS.join('\n'));
    setExpSave({ kind: 'idle' });
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
                Enable read-only live pull
                <div className="hint">
                  Read Overleaf project files via the live session instead of the
                  ZIP export. Read-only — never modifies Overleaf.
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
                Enable explicit Overleaf write-back
                <div className="hint">
                  Allow pushing selected text files back to Overleaf with a typed
                  confirmation. Disabled by default. Conflicts are always blocked.
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
