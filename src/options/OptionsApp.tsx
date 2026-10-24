import React, { useEffect, useRef, useState } from 'react';
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
  SYMLINK_SKIPPED_REASON_PREFIX,
  buildTokenCreationUrl,
  writeBackExtensionsFor,
} from '../shared/constants';
import {
  clearExperimentalConfig,
  clearLegacySingleConfig,
  clearProjectLinks,
  clearUIPreferences,
  getExperimentalConfig,
  getMirrorMatchEnabled,
  getProjectLinkMap,
  getUIPreferences,
  isConfigured,
  removeProjectLink,
  setExperimentalConfig,
  setMirrorMatchEnabled,
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
import type { WriteBackResult } from '../overleaf/live/types';
import { computeSha256 } from '../diff/fileHasher';
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
      setEditError('Owner and repository are required.');
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
    if (
      !confirm(
        `Remove the mapping for project ${projectId}? Its saved GitHub token is removed from this extension too (it is not revoked on GitHub). Nothing on GitHub changes.`,
      )
    ) {
      return;
    }
    await removeProjectLink(projectId);
    await reload();
    if (editing && !editing.isNew && editing.projectId === projectId) setEditing(null);
  };

  const resetAll = async () => {
    if (
      !confirm(
        'Reset all settings? This removes every linked project and saved GitHub token and resets display and live sync settings. Nothing on GitHub or Overleaf is changed.',
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
          Link each Overleaf project to a GitHub repository. Tokens stay in
          this browser and go only to GitHub.
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
            id="manualZipUploadEnabled"
            type="checkbox"
            checked={uiPrefs.manualZipUploadEnabled}
            aria-controls="manual-zip-suboptions"
            aria-expanded={uiPrefs.manualZipUploadEnabled}
            onChange={(e) =>
              void updateUiPrefs({
                ...uiPrefs,
                manualZipUploadEnabled: e.target.checked,
              })
            }
          />
          <label htmlFor="manualZipUploadEnabled">
            Enable manual ZIP upload
            <div className="hint">
              Lets you upload a source ZIP you downloaded from Overleaf (File →
              Download → Download as source (.zip)) when the automatic download
              doesn't work.
            </div>
          </label>
        </div>
        {uiPrefs.manualZipUploadEnabled && (
          <div id="manual-zip-suboptions" className="display-suboptions">
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
                  By default the popup hides the <em>Manual ZIP upload</em>{' '}
                  section until <em>Fetch from current Overleaf project</em>{' '}
                  fails or no Overleaf tab is open. Turn this on to always
                  show it.
                </div>
              </label>
            </div>
          </div>
        )}
        {uiPrefsSaveError && (
          <div className="banner error" role="alert" style={{ marginTop: 10 }}>
            Save failed: {uiPrefsSaveError}
          </div>
        )}
      </section>

      <section aria-labelledby="sec-experimental" className="experimental-section">
        <h2 id="sec-experimental">Overleaf Live Sync</h2>

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
            Enable live sync
            <div className="hint">
              Shows the features below, each with its own switch.
              Overleaf write-back starts on; the others start off. When this
              is off, none of them run.
            </div>
          </label>
        </div>

        {experimental.experimentalLiveSyncEnabled && (
          <div id="experimental-suboptions" className="experimental-suboptions">

            <div className="experimental-feature-card">
              <h3 className="experimental-feature-heading">
                Read from the open Overleaf tab (Overleaf → GitHub)
              </h3>
              <div className="checkbox-row">
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
                  Enable reading from the Overleaf tab
                  <div className="hint">
                    Adds a popup button that reads your project from the open
                    Overleaf tab instead of downloading a ZIP, then shows the
                    changes to commit. Slower on large projects. Never changes
                    your Overleaf project.
                  </div>
                </label>
              </div>
            </div>

            <div className="experimental-feature-card">
              <h3 className="experimental-feature-heading">
                Overleaf write-back (GitHub → Overleaf)
              </h3>
              <div className="checkbox-row">
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
                  Enable Overleaf write-back
                  <div className="hint">
                    Adds <em>Pull from GitHub into Overleaf</em> to the
                    popup, plus two developer test tools below. Before writing
                    a file, the extension checks it hasn't changed in Overleaf
                    since it was read, then reads it again to confirm the
                    write.
                  </div>
                </label>
              </div>

              {experimental.overleafWriteBackEnabled && (
                <>
                  <div className="checkbox-row" style={{ marginTop: 14 }}>
                    <input
                      id="requireZipBackupBeforeWriteBack"
                      type="checkbox"
                      checked={experimental.requireZipBackupBeforeWriteBack}
                      onChange={(e) =>
                        setExperimental({
                          ...experimental,
                          requireZipBackupBeforeWriteBack: e.target.checked,
                        })
                      }
                    />
                    <label htmlFor="requireZipBackupBeforeWriteBack">
                      Check that Overleaf can export the project before writing
                      <div className="hint">
                        Before anything is written, downloads the project's ZIP
                        from Overleaf and stops if that fails. The ZIP is not
                        saved: to keep a copy you can restore, download the
                        project yourself (<em>File → Download → Download as
                        source (.zip)</em>). To undo a pull, use Overleaf's
                        History.
                      </div>
                    </label>
                  </div>

                  <div className="checkbox-row" style={{ marginTop: 14 }}>
                    <input
                      id="requireConfirmationBeforeWriteBack"
                      type="checkbox"
                      checked={experimental.requireConfirmationBeforeWriteBack}
                      onChange={(e) =>
                        setExperimental({
                          ...experimental,
                          requireConfirmationBeforeWriteBack: e.target.checked,
                        })
                      }
                    />
                    <label htmlFor="requireConfirmationBeforeWriteBack">
                      Ask me to confirm before replacing files in Overleaf
                      <div className="hint">
                        Shows the files a pull would replace and asks you to
                        type 'replace' before anything is written.
                      </div>
                    </label>
                  </div>

                  <div className="checkbox-row" style={{ marginTop: 14 }}>
                    <input
                      id="allowBinaryWriteBack"
                      type="checkbox"
                      checked={experimental.allowBinaryWriteBack}
                      onChange={(e) =>
                        setExperimental({
                          ...experimental,
                          allowBinaryWriteBack: e.target.checked,
                        })
                      }
                    />
                    <label htmlFor="allowBinaryWriteBack">
                      Allow uploading new images and other non-text files
                      <div className="hint">
                        Images, PDFs and other non-text files that are on GitHub
                        but not in Overleaf are uploaded when <em>Also create new
                        files in Overleaf</em> is ticked. Files already in
                        Overleaf are never replaced.
                      </div>
                    </label>
                  </div>

                  <div className="checkbox-row" style={{ marginTop: 14 }}>
                    <input
                      id="includeAllFileTypes"
                      type="checkbox"
                      checked={experimental.includeAllFileTypes}
                      onChange={(e) =>
                        setExperimental({
                          ...experimental,
                          includeAllFileTypes: e.target.checked,
                        })
                      }
                    />
                    <label htmlFor="includeAllFileTypes">
                      Include all file types
                      <div className="hint">
                        The pull copies every text file, whatever its type, and the
                        list below is not used.
                      </div>
                    </label>
                  </div>

                  <div className="field" style={{ marginTop: 18 }}>
                    <label htmlFor="writeBackExts">Allowed write-back extensions</label>
                    <textarea
                      id="writeBackExts"
                      value={extText}
                      onChange={(e) => setExtText(e.target.value)}
                      disabled={experimental.includeAllFileTypes}
                      spellCheck={false}
                      style={{ minHeight: 110 }}
                    />
                    <div className="hint">
                      One extension per line. Defaults: <code>.tex</code>,{' '}
                      <code>.bib</code>, <code>.cls</code>, <code>.sty</code>,{' '}
                      <code>.bst</code>, <code>.md</code>, <code>.txt</code>.
                    </div>
                  </div>

                  <WriteBackDevPanel experimental={experimental} />
                  <PullFromGitHubDevPanel links={links} experimental={experimental} />
                </>
              )}
            </div>

            <div className="experimental-feature-card">
              <h3 className="experimental-feature-heading">
                Local replica
              </h3>
              <div className="checkbox-row">
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
                    Local folder comparison isn't available yet. This setting
                    does nothing for now.
                  </div>
                </label>
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
              'Save live sync settings'
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
                {' '}· target directory <code>{link.repo.targetDir}/</code>
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
            Paste the project URL from your browser, or just the ID (the part
            after <code>/project/</code>).
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
          <div className="hint">
            Optional. The folder in the repository that holds the Overleaf
            files. Leave empty for the top level.
          </div>
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
          <a href={buildTokenCreationUrl(state.repo)} target="_blank" rel="noreferrer">
            Create a token on GitHub ↗
          </a>{' '}
          — opens with <code>Contents: Read and write</code> and{' '}
          <code>Metadata: Read-only</code> pre-selected. Under{' '}
          <strong>Repository access</strong>, choose <em>Only select repositories</em>{' '}
          and pick this repo, then click <strong>Generate token</strong> and paste it here.
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
            When on, files in the GitHub repository that aren't in your
            Overleaf project (or uploaded ZIP) are deleted from GitHub when you
            commit. Only inside the target directory; files matching the ignore
            patterns are kept. You can change this for each commit in the
            popup.
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
          Matching files are never committed to GitHub, e.g.{' '}
          <code>*.aux</code>. <code>*</code> matches any part of a name,{' '}
          <code>**</code> any number of folders. Lines starting with{' '}
          <code>#</code> are notes.
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

// Developer harness for the write-back path. Picks a doc
// by path via the live bridge (LIVE_FETCH_PROJECT_METADATA -> doc id ->
// LIVE_READ_DOC), lets the user edit, then runs the full
// writeSelectedFilesBackToOverleaf orchestration so all the existing
// safety gates (ZIP backup, conflict detector, OT, verify-after-write)
// are exercised end-to-end. Honors the user's live sync config
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
        throw new Error(`Could not read the project's file list. Details: ${md.message}`);
      }
      const entries = flattenProjectTree(md.data.rootFolder);
      const entry = entries.find((e) => e.path === trimmedPath && e.kind === 'doc');
      if (!entry || !entry.id) {
        const docs = entries.filter((e) => e.kind === 'doc').map((e) => e.path);
        const sample = docs.slice(0, 8).join(', ');
        throw new Error(
          `No editable text file at "${trimmedPath}". Text files in this project include: ${sample}${docs.length > 8 ? '…' : ''}`,
        );
      }
      const read = await readDocViaBridge(trimmedProjectId, entry.id);
      if (!read.ok) {
        throw new Error(`Could not read the file. Details: ${read.message}`);
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
          allowedExtensions: writeBackExtensionsFor(experimental),
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
        For testing write-back by hand. Reads one text file, lets you edit
        it, then writes it back with the same checks as Pull from GitHub
        (export check if on, conflict check, verify after write). The
        confirmation setting doesn't apply here. Use a throwaway project.
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
          <label htmlFor="wb-path">File path</label>
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
// Reads the branch HEAD of the chosen project's linked repo, then runs
// the same two steps as the popup, on one Overleaf bridge session:
//
//   GitHub tree (text blobs, plus binaries if enabled)
//     -> planPullIntoOverleaf: resolve doc IDs, ZIP backup if enabled,
//        read current Overleaf text. Writes nothing; the result is the
//        preview (files to replace, create, upload).
//     -> applyPullPlan, after the user confirms: writes only the planned
//        files through writeSelectedFilesBackToOverleaf (fresh re-read,
//        conflict check against the preview's text, OT diff,
//        applyOtUpdate, verify-after-write), then creates and uploads.
//
// Files in Overleaf with no GitHub source are untouched, unless "Make
// Overleaf match GitHub exactly" is ticked: then the preview also lists the
// files it would delete and the uploaded files it would replace, and the
// confirm asks for `delete` (or `delete N` for a large deletion).
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
  const [busy, setBusy] = useState<'idle' | 'planning' | 'applying'>('idle');
  const [plan, setPlan] = useState<PullPlan | null>(null);
  const [typedConfirmation, setTypedConfirmation] = useState<string>('');
  const [phase, setPhase] = useState<string>('');
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
  // "Make Overleaf match GitHub exactly" is remembered per project, as soon
  // as it is clicked (apart from the Save button of the settings above). It
  // is off until the stored choice for the selected project has been read.
  const [mirror, setMirror] = useState<boolean>(false);
  const [mirrorLoaded, setMirrorLoaded] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    setMirror(false);
    setMirrorLoaded(false);
    void (async () => {
      try {
        if (selectedProjectId) {
          const remembered = await getMirrorMatchEnabled(selectedProjectId);
          if (!cancelled) setMirror(remembered);
        }
      } catch {
        // Unreadable: it stays off.
      }
      if (!cancelled) setMirrorLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);
  const changeMirror = (value: boolean) => {
    setMirror(value);
    void setMirrorMatchEnabled(selectedProjectId, value).catch(() => {
      // The choice still applies to pulls started from this page.
    });
  };

  // A plan keeps its Overleaf session open until it is applied or
  // discarded; discard it if the panel goes away with a preview open.
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

  const showError = (e: unknown) => {
    // Same text as the popup shows.
    const described = describePullError(e);
    setError(described.message);
    setErrorRecovery(described.recovery);
  };

  // Step 1: work out what the pull would change. Writes nothing.
  const onPreview = async () => {
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

    const link = links[selectedProjectId];
    if (!link) {
      setError(`No mapping found for ${selectedProjectId}.`);
      return;
    }
    setBusy('planning');

    try {
      setPhase('Fetching GitHub branch…');
      const snapshot = await sourceFromGitHubBranch(
        link.token,
        link.repo,
        pullSourceOptions(experimental, mirror),
      );
      setCommitSha(snapshot.commitSha);
      setSourceSkipped(snapshot.skipped);

      if (snapshot.files.length === 0) {
        setError(
          describeNothingOnGitHub(
            link.repo.branch,
            link.repo.targetDir,
            snapshot.skipped.length,
            mirror,
          ),
        );
        return;
      }

      const next = await planPullIntoOverleaf({
        projectId: selectedProjectId,
        files: snapshot.files,
        skippedOnGitHub: snapshot.skipped,
        experimental,
        createMissing,
        ...(mirror ? { mirror: mirrorInputFromSnapshot(snapshot, link.repo) } : {}),
        onProgress: setPhase,
      });
      setNoOverleafDocs(next.missingInOverleaf);
      holdPlan(next);
    } catch (e) {
      showError(e);
    } finally {
      setBusy('idle');
      setPhase('');
    }
  };

  // Step 2, after the user confirmed: write exactly what the preview listed.
  const onApply = async () => {
    const confirmed = planRef.current;
    if (!confirmed) return;
    holdPlan(null);
    setBusy('applying');
    try {
      const outcome = await applyPullPlan(confirmed, setPhase, typedConfirmation);
      setResults(outcome.results);
      setCreateResults(outcome.createResults);
      setBinaryResults(outcome.binaryResults);
      setFileReplaceResults(outcome.fileReplaceResults ?? null);
      setDeleteResults(outcome.deleteResults ?? null);
    } catch (e) {
      showError(e);
    } finally {
      setBusy('idle');
      setPhase('');
    }
  };

  // Cancel, or OK on a preview with nothing to pull. Nothing is written.
  const onDiscard = () => {
    if (planRef.current) void discardPullPlan(planRef.current);
    holdPlan(null);
    setTypedConfirmation('');
    setCommitSha(null);
    setNoOverleafDocs([]);
    setSourceSkipped([]);
  };

  const previewText = plan ? describePullPlan(plan) : null;
  // The word to type (`replace`, `delete` or `delete N`), or null.
  const confirmationWord = plan ? pullConfirmationWord(plan) : null;
  const canConfirm =
    plan !== null &&
    pullPlanChangeCount(plan) > 0 &&
    (confirmationWord === null || isPullConfirmationTyped(typedConfirmation, plan));

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
          Developer pull test (GitHub → Overleaf)
        </h3>
        <div className="hint">
          Add a project → repo mapping above before you can pull from GitHub
          into Overleaf.
        </div>
      </div>
    );
  }

  const summary =
    results || createResults || binaryResults || fileReplaceResults || deleteResults
      ? describePullOutcome({
          results,
          createResults,
          binaryResults,
          fileReplaceResults,
          deleteResults,
        }).join(', ')
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
  // Created files are in the create results, not "not pulled".
  const notInOverleaf = createResults ? [] : noOverleafDocs;

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
        Developer pull test (GitHub → Overleaf)
      </h3>
      <div className="hint" style={{ marginBottom: 12 }}>
        Copies the linked GitHub branch into the chosen project, like the
        popup. You see every change before anything is written. The project
        must be open in an Overleaf tab.
      </div>

      <div className="field">
        <label htmlFor="pgh-pid">Linked project</label>
        <select
          id="pgh-pid"
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
          disabled={busy !== 'idle' || plan !== null}
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
          checked={createMissing || mirror}
          onChange={(e) => setCreateMissing(e.target.checked)}
          disabled={busy !== 'idle' || plan !== null || mirror}
        />
        <label htmlFor="pgh-create-missing">
          Also create new files in Overleaf
          <div className="hint">
            {mirror
              ? 'Always on while matching GitHub, for every file type.'
              : 'Adds files that are only on GitHub, of the allowed types.'}
          </div>
        </label>
      </div>

      <div className="checkbox-row" style={{ marginTop: 8 }}>
        <input
          id="pgh-mirror"
          type="checkbox"
          checked={mirror}
          onChange={(e) => changeMirror(e.target.checked)}
          disabled={busy !== 'idle' || plan !== null || !mirrorLoaded}
        />
        <label htmlFor="pgh-mirror">
          Make Overleaf match GitHub exactly
          <div className="hint">
            Also deletes files not on GitHub and replaces uploaded files that
            differ. You&apos;ll type <strong>delete</strong> to confirm.
          </div>
        </label>
      </div>

      <div className="actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className={mirror ? 'button danger' : 'button primary'}
          onClick={onPreview}
          disabled={busy !== 'idle' || plan !== null || !selectedProjectId || !mirrorLoaded}
          aria-busy={busy !== 'idle'}
        >
          {busy !== 'idle' ? (
            <>
              <span className="spinner" aria-hidden="true" />
              {phase || (busy === 'planning' ? 'Checking what would change…' : 'Pulling…')}
            </>
          ) : mirror ? (
            'Pull and match GitHub'
          ) : (
            'Pull from GitHub into Overleaf'
          )}
        </button>
      </div>

      {error && (
        <div className="banner error" role="alert" style={{ marginTop: 10 }}>
          {error}
          {errorRecovery && <div style={{ marginTop: 6 }}>What to try: {errorRecovery}</div>}
        </div>
      )}

      {commitSha && (
        <div className="hint" style={{ marginTop: 10 }}>
          GitHub version: <code>{commitSha.substring(0, 7)}</code>
        </div>
      )}

      {plan && previewText && (
        <div style={{ marginTop: 10 }}>
          {previewText.nothingToPull && (
            <div
              className={`banner ${plan.notPulled.length === 0 ? 'success' : 'info'}`}
              role="status"
            >
              {previewText.nothingToPull}
            </div>
          )}
          {previewText.replace && (
            <div className="banner info" role="alert">
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
            <div className="banner info" role="alert">
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
            <div className="banner error" role="alert">
              <strong>{previewText.mirror.largeDeletionWarning}</strong>
            </div>
          )}
          {previewText.mirror?.rootDocWarning && (
            <div className="banner error" role="alert">
              <strong>{previewText.mirror.rootDocWarning}</strong>
            </div>
          )}
          {previewText.mirror?.deleteTitle && plan.mirror && (
            <div className="banner info" role="alert">
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
            <div className="hint" style={{ marginTop: 8 }}>
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
            <div className="actions" style={{ marginTop: 10 }}>
              <button type="button" className="button" onClick={onDiscard}>
                OK
              </button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (canConfirm) void onApply();
              }}
              style={{ marginTop: 10 }}
            >
              {confirmationWord !== null && (
                <div className="field">
                  <label htmlFor="pgh-confirm-word">
                    To confirm, type <strong>{confirmationWord}</strong>
                  </label>
                  <input
                    id="pgh-confirm-word"
                    type="text"
                    value={typedConfirmation}
                    onChange={(e) => setTypedConfirmation(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              )}
              <div className="actions">
                <button type="submit" className="button primary" disabled={!canConfirm}>
                  {previewText.confirmLabel}
                </button>
                <button type="button" className="button" onClick={onDiscard}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {summary && (
        <div
          className={`banner ${anyProblem ? 'info' : 'success'}`}
          role="status"
          style={{ marginTop: 10 }}
        >
          <strong>Summary:</strong> {summary}
        </div>
      )}

      {results && results.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Text files already in Overleaf
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
              <strong>{pullResultLabel('doc', r.status)}</strong> — <code>{r.path}</code>
              {rowMessage('doc', r)}
            </div>
          ))}
        </div>
      )}

      {createResults && createResults.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            New text files
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
              <strong>{pullResultLabel('create', r.status)}</strong> — <code>{r.path}</code>
              {rowMessage('create', r)}
            </div>
          ))}
        </div>
      )}

      {binaryResults && binaryResults.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Images, PDFs and other non-text files
          </div>
          {binaryResults.map((r, i) => (
            <div
              key={i}
              className={`banner ${
                r.status === 'uploaded'
                  ? 'success'
                  : r.status === 'failed'
                    ? 'error'
                    : 'info'
              }`}
              role={r.status === 'uploaded' ? 'status' : 'alert'}
              style={{ marginTop: 6, fontSize: 12 }}
            >
              <strong>{pullResultLabel('upload', r.status)}</strong> — <code>{r.path}</code>
              {rowMessage('upload', r)}
            </div>
          ))}
        </div>
      )}

      {fileReplaceResults && fileReplaceResults.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Uploaded files replaced with the GitHub version
          </div>
          {fileReplaceResults.map((r, i) => (
            <div
              key={i}
              className={`banner ${
                r.status === 'replaced' ? 'success' : r.status === 'failed' ? 'error' : 'info'
              }`}
              role={r.status === 'replaced' ? 'status' : 'alert'}
              style={{ marginTop: 6, fontSize: 12 }}
            >
              <strong>{pullResultLabel('replaceFile', r.status)}</strong> — <code>{r.path}</code>
              {rowMessage('replaceFile', r)}
            </div>
          ))}
        </div>
      )}

      {deleteResults && deleteResults.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Files deleted from Overleaf
          </div>
          {deleteResults.map((r, i) => (
            <div
              key={i}
              className={`banner ${
                r.status === 'deleted' ? 'success' : r.status === 'failed' ? 'error' : 'info'
              }`}
              role={r.status === 'deleted' ? 'status' : 'alert'}
              style={{ marginTop: 6, fontSize: 12 }}
            >
              <strong>{pullResultLabel('delete', r.status)}</strong> —{' '}
              <code>{r.kind === 'folder' ? `${r.path}/` : r.path}</code>
              {rowMessage('delete', r)}
            </div>
          ))}
        </div>
      )}

      {!plan && (notInOverleaf.length > 0 || sourceSkipped.length > 0) && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12 }}>
            Show files not pulled (
            {notInOverleaf.length + sourceSkipped.length})
          </summary>
          <ul style={{ marginTop: 6, fontSize: 12 }}>
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
                to upload new ones)
              </li>
            ))}
            {extFilteredItems.map((s) => (
              <li key={`ext-${s.path}`}>
                <code>{s.path}</code> — extension not in allowed write-back
                list (add the extension under <em>Allowed write-back
                extensions</em> above to include)
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
    </div>
  );
}

// ": message" after a result row's label, without repeating the label.
function rowMessage(
  kind: 'doc' | 'create' | 'upload' | 'replaceFile' | 'delete',
  r: WriteBackResult | CreateResult | BinaryResult | FileReplaceResult | DeleteResult,
): string {
  const message = pullRowMessage(pullResultLabel(kind, r.status), r.message);
  return message ? `: ${message}` : '';
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
    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, overflowWrap: 'anywhere' }}>
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
    <details style={{ marginTop: 8 }} open={open}>
      <summary style={{ cursor: 'pointer', fontSize: 12 }}>
        {summary ?? `Show all ${items.length} files`}
      </summary>
      {list}
    </details>
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
                default branch
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
