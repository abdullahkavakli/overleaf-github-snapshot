import React, { useEffect, useState } from 'react';
import type {
  ConnectionTestResult,
  ExperimentalConfig,
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
  clearRepoConfig,
  getExperimentalConfig,
  getRepoConfig,
  setExperimentalConfig,
  setRepoConfig,
} from '../storage/extensionStorage';
import { clearToken, getToken, setToken } from '../github/auth';
import { testConnection } from '../github/githubClient';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: ConnectionTestResult };

export function Options(): React.ReactElement {
  const [config, setConfig] = useState<RepoConfig>(DEFAULT_REPO_CONFIG);
  const [token, setTokenState] = useState<string>('');
  const [showToken, setShowToken] = useState<boolean>(false);
  const [ignoreText, setIgnoreText] = useState<string>(DEFAULT_IGNORE_PATTERNS.join('\n'));
  const [experimental, setExperimental] = useState<ExperimentalConfig>(
    DEFAULT_EXPERIMENTAL_CONFIG,
  );
  const [extText, setExtText] = useState<string>(
    DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS.join('\n'),
  );
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  useEffect(() => {
    void (async () => {
      const [c, t, e] = await Promise.all([
        getRepoConfig(),
        getToken(),
        getExperimentalConfig(),
      ]);
      setConfig(c);
      setTokenState(t ?? '');
      setIgnoreText((c.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS).join('\n'));
      setExperimental(e);
      setExtText(
        (e.allowedWriteBackExtensions ?? DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS).join('\n'),
      );
    })();
  }, []);

  const onSave = async () => {
    setSave({ kind: 'saving' });
    try {
      const trimmedToken = token.trim();
      if (trimmedToken) {
        await setToken(trimmedToken);
      } else {
        await clearToken();
      }
      const patterns = parseIgnorePatterns(ignoreText);
      const next: RepoConfig = {
        owner: config.owner.trim(),
        repo: config.repo.trim(),
        branch: config.branch.trim() || 'main',
        targetDir: (config.targetDir ?? '').trim(),
        includeDeletions: config.includeDeletions,
        ignorePatterns: patterns.length > 0 ? patterns : [...DEFAULT_IGNORE_PATTERNS],
      };
      await setRepoConfig(next);
      setConfig(next);

      const exts = parseExtensions(extText);
      const nextExperimental: ExperimentalConfig = {
        ...experimental,
        allowedWriteBackExtensions:
          exts.length > 0 ? exts : [...DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS],
      };
      await setExperimentalConfig(nextExperimental);
      setExperimental(nextExperimental);

      setSave({ kind: 'saved' });
      setTimeout(() => setSave((s) => (s.kind === 'saved' ? { kind: 'idle' } : s)), 2000);
    } catch (e) {
      setSave({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onReset = async () => {
    if (!confirm('Reset all settings? This clears the token and repo configuration.')) return;
    await clearToken();
    await clearRepoConfig();
    await clearExperimentalConfig();
    setConfig(DEFAULT_REPO_CONFIG);
    setTokenState('');
    setIgnoreText(DEFAULT_IGNORE_PATTERNS.join('\n'));
    setExperimental(DEFAULT_EXPERIMENTAL_CONFIG);
    setExtText(DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS.join('\n'));
    setSave({ kind: 'idle' });
    setTest({ kind: 'idle' });
  };

  const onTest = async () => {
    setTest({ kind: 'running' });
    const candidate: RepoConfig = {
      ...config,
      owner: config.owner.trim(),
      repo: config.repo.trim(),
      branch: config.branch.trim() || 'main',
    };
    const result = await testConnection(token.trim(), candidate);
    setTest({ kind: 'done', result });
  };

  return (
    <div className="container">
      <header className="page-header">
        <h1>Overleaf Snapshot to GitHub</h1>
        <p className="lead">
          Configure the GitHub repository and token used to commit Overleaf source ZIP snapshots.
          Settings are stored locally in <code>chrome.storage.local</code> and only sent to{' '}
          <code>api.github.com</code>.
        </p>
      </header>

      <section aria-labelledby="sec-auth">
        <h2 id="sec-auth">GitHub authentication</h2>
        <div className="field">
          <label htmlFor="token">
            Personal access token <span className="required" aria-hidden="true">*</span>
          </label>
          <div className="token-row">
            <input
              id="token"
              className="mono"
              type={showToken ? 'text' : 'password'}
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder="github_pat_..."
              aria-describedby="token-hint"
              aria-required="true"
              onChange={(e) => setTokenState(e.target.value)}
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
          <div id="token-hint" className="hint">
            Use a <strong>fine-grained personal access token</strong> scoped to{' '}
            <em>only this repository</em>, with <code>Contents: Read and write</code> and{' '}
            <code>Metadata: Read</code> permissions.
          </div>
        </div>
      </section>

      <section aria-labelledby="sec-repo">
        <h2 id="sec-repo">Repository</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="owner">
              Owner <span className="required" aria-hidden="true">*</span>
            </label>
            <input
              id="owner"
              className="mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={config.owner}
              aria-describedby="owner-hint"
              aria-required="true"
              onChange={(e) => setConfig({ ...config, owner: e.target.value })}
              placeholder="username-or-org"
            />
            <div id="owner-hint" className="hint">
              The GitHub user or organization that owns the repo.
            </div>
          </div>
          <div className="field">
            <label htmlFor="repo">
              Repository <span className="required" aria-hidden="true">*</span>
            </label>
            <input
              id="repo"
              className="mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={config.repo}
              aria-required="true"
              onChange={(e) => setConfig({ ...config, repo: e.target.value })}
              placeholder="repo-name"
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="branch">Branch</label>
            <input
              id="branch"
              className="mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={config.branch}
              aria-describedby="branch-hint"
              onChange={(e) => setConfig({ ...config, branch: e.target.value })}
              placeholder="main"
            />
            <div id="branch-hint" className="hint">
              Must already exist on GitHub with at least one commit.
            </div>
          </div>
          <div className="field">
            <label htmlFor="targetDir">Target directory</label>
            <input
              id="targetDir"
              className="mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={config.targetDir ?? ''}
              aria-describedby="targetDir-hint"
              onChange={(e) => setConfig({ ...config, targetDir: e.target.value })}
              placeholder="paper"
            />
            <div id="targetDir-hint" className="hint">
              Optional. ZIP contents are placed under this directory in the repo and deletions are
              scoped to it.
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="sec-behavior">
        <h2 id="sec-behavior">Commit behavior</h2>
        <div className="checkbox-row">
          <input
            id="includeDeletions"
            type="checkbox"
            checked={config.includeDeletions}
            aria-describedby="deletions-hint"
            onChange={(e) => setConfig({ ...config, includeDeletions: e.target.checked })}
          />
          <label htmlFor="includeDeletions">
            Include deletions by default
            <div id="deletions-hint" className="hint">
              When enabled, files present in the repo but missing from the ZIP will be removed
              (only inside the target directory). You can toggle this per commit in the popup.
            </div>
          </label>
        </div>
      </section>

      <section aria-labelledby="sec-ignore">
        <h2 id="sec-ignore">Ignore patterns</h2>
        <div className="field">
          <label htmlFor="ignore">One pattern per line</label>
          <textarea
            id="ignore"
            value={ignoreText}
            aria-describedby="ignore-hint"
            onChange={(e) => setIgnoreText(e.target.value)}
            spellCheck={false}
          />
          <div id="ignore-hint" className="hint">
            Glob-like patterns matched against ZIP paths. Use <code>*</code> for any non-slash
            chars, <code>**</code> across slashes. Lines starting with <code>#</code> are
            comments.
          </div>
        </div>
      </section>

      <section aria-labelledby="sec-experimental" className="experimental-section">
        <h2 id="sec-experimental">Experimental Overleaf Live Sync</h2>
        <div className="banner info" style={{ marginBottom: 14 }}>
          <strong>Experimental.</strong> These features depend on Overleaf
          internals that are not officially documented and may break without
          warning. The stable workflow is the automatic ZIP snapshot. All
          experimental features are disabled by default.
        </div>

        <div className="checkbox-row">
          <input
            id="experimentalLiveSyncEnabled"
            type="checkbox"
            checked={experimental.experimentalLiveSyncEnabled}
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
              Master switch. When off, no experimental UI is shown in the popup
              and no live protocol code runs.
            </div>
          </label>
        </div>

        <div className="checkbox-row" style={{ marginTop: 14 }}>
          <input
            id="liveReadOnlyPullEnabled"
            type="checkbox"
            disabled={!experimental.experimentalLiveSyncEnabled}
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
            disabled={!experimental.experimentalLiveSyncEnabled}
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
            disabled={!experimental.experimentalLiveSyncEnabled}
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
            disabled={
              !experimental.experimentalLiveSyncEnabled ||
              !experimental.overleafWriteBackEnabled
            }
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
            disabled={
              !experimental.experimentalLiveSyncEnabled ||
              !experimental.overleafWriteBackEnabled
            }
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
            disabled={
              !experimental.experimentalLiveSyncEnabled ||
              !experimental.overleafWriteBackEnabled
            }
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
            disabled={
              !experimental.experimentalLiveSyncEnabled ||
              !experimental.overleafWriteBackEnabled
            }
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
      </section>

      <section aria-labelledby="sec-test">
        <h2 id="sec-test">Test connection</h2>
        <div className="actions">
          <button
            type="button"
            className="button"
            onClick={onTest}
            disabled={test.kind === 'running'}
            aria-busy={test.kind === 'running'}
          >
            {test.kind === 'running' ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Testing…
              </>
            ) : (
              'Test GitHub connection'
            )}
          </button>
        </div>
        <div
          aria-live="polite"
          aria-atomic="true"
          role={test.kind === 'done' && !test.result.ok ? 'alert' : 'status'}
        >
          {test.kind === 'done' && <TestResultView result={test.result} />}
        </div>
      </section>

      <div className="actions">
        <button
          type="button"
          className="button primary"
          onClick={onSave}
          disabled={save.kind === 'saving'}
          aria-busy={save.kind === 'saving'}
        >
          {save.kind === 'saving' ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Save settings'
          )}
        </button>
        <button type="button" className="button" onClick={onReset}>
          Reset to defaults
        </button>
        <span
          className={
            save.kind === 'saved'
              ? 'save-status ok'
              : save.kind === 'error'
                ? 'save-status err'
                : 'save-status'
          }
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {save.kind === 'saved' && 'Saved.'}
          {save.kind === 'error' && `Save failed: ${save.message}`}
        </span>
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
