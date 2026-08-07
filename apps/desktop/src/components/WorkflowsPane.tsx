import { Boxes, FileJson, Plus, Trash2, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { NodePack, WorkflowReview } from "../api/types";
import { plural, t } from "../i18n";
import { useApp } from "../store";
import { Alert } from "./Alert";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";

/**
 * Settings → Workflows: the ComfyUI half of the engine, which has had a
 * complete API since Phase 3 and no client at all.
 *
 * Two sections, and the separation is the point — it is the engine's own,
 * and collapsing it would make enabling third-party code a side effect of
 * importing a file. A **node pack** is a machine-level trust decision:
 * third-party Python that runs inside ComfyUI with access to the models,
 * the files and the network. A **workflow** is a document judged against
 * whatever has been granted.
 *
 * So the enable action is the one thing here that is deliberately slow: a
 * dialog, the engine's own warning shown verbatim, and a version string
 * the operator has to type because only they know what is installed.
 */
export function WorkflowsPane() {
  const nodePacks = useApp((state) => state.nodePacks);
  const workflows = useApp((state) => state.workflows);
  const refreshComfy = useApp((state) => state.refreshComfy);
  const [error, setError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState<NodePack | null>(null);

  useEffect(() => {
    void refreshComfy().then(setError);
  }, [refreshComfy]);

  return (
    <section>
      <h2>
        <Workflow {...ICON} />
        {t("settings.tabs.workflows")}
      </h2>
      <p className="hint">{t("settings.workflows.hint")}</p>
      {error && <Alert message={error} onDismiss={() => setError(null)} />}

      <div className="setting-row">
        <div className="st">
          <Boxes {...ICON_SM} />
          {t("settings.workflows.packsHeading")}
        </div>
        <div className="sd">{t("settings.workflows.packsHint")}</div>
        {nodePacks?.packs.length ? (
          <div className="pack-list">
            {nodePacks.packs.map((pack) => (
              <PackRow
                key={pack.id}
                pack={pack}
                onEnable={() => setEnabling(pack)}
                onError={setError}
              />
            ))}
          </div>
        ) : (
          <p className="sd">{t("settings.workflows.noPacks")}</p>
        )}
      </div>

      <WorkflowList onError={setError} count={workflows.length} />

      {enabling && nodePacks && (
        <EnablePackDialog
          pack={enabling}
          // Verbatim, from the response that offered the action. Every
          // client gets this sentence from the engine for the same reason
          // the grant lives there: a UI that paraphrases it is a UI that
          // can soften it.
          warning={nodePacks.warning}
          onClose={() => setEnabling(null)}
          onError={setError}
        />
      )}
    </section>
  );
}

const ICON = { size: 15, strokeWidth: 1.8 } as const;
const ICON_SM = { size: 13, strokeWidth: 1.8 } as const;

/** One catalog pack: what it is, where it came from, and its grant. */
function PackRow({
  pack,
  onEnable,
  onError,
}: {
  pack: NodePack;
  onEnable: () => void;
  onError: (message: string | null) => void;
}) {
  const disableNodePack = useApp((state) => state.disableNodePack);
  const [busy, setBusy] = useState(false);

  const disable = () => {
    setBusy(true);
    void disableNodePack(pack.id)
      .then(onError)
      .finally(() => setBusy(false));
  };

  return (
    <div className={`pack-row${pack.enabled ? " on" : ""}`}>
      <div className="pack-id">
        <div className="pack-name">
          {pack.name}
          {pack.enabled && (
            <span className="badge">
              {t("settings.workflows.enabledAt", { version: pack.version ?? "" })}
            </span>
          )}
        </div>
        <RepoLink url={pack.repo} />
        {pack.summary && <div className="sd">{pack.summary}</div>}
        <div className="sd">
          {plural("settings.workflows.packNodes", pack.nodes.length, { count: pack.nodes.length })}
        </div>
      </div>
      {pack.enabled ? (
        <button className="btn-ghost" disabled={busy} onClick={disable}>
          {t("settings.workflows.disable")}
        </button>
      ) : (
        <button className="btn-ghost" onClick={onEnable}>
          {t("settings.workflows.enable")}
        </button>
      )}
    </div>
  );
}

/**
 * Where the pack came from, as somewhere you can actually go.
 *
 * It was text in both places it appears, and that is worst exactly where it
 * matters most: the grant dialog asks the operator to vouch for third-party
 * Python that will run with the models, the files and the network, and it
 * printed the address of that code as something to retype into a browser.
 *
 * The click leaves for the system browser through the main process's window
 * open handler, which opens http(s) and denies every other scheme. Nothing
 * here re-checks that, and nothing here should — a second answer to the same
 * question is how the two drift apart.
 */
function RepoLink({ url }: { url: string }) {
  return (
    <a className="pack-repo" href={url} target="_blank" rel="noreferrer">
      {url}
    </a>
  );
}

/**
 * The grant dialog.
 *
 * Two things have to be true before the button works, and neither is a
 * default: the operator typed the version installed on this machine (the
 * engine refuses to guess it — a pin to a guessed version pins nothing),
 * and they ticked an acknowledgement whose label is the warning itself.
 */
function EnablePackDialog({
  pack,
  warning,
  onClose,
  onError,
}: {
  pack: NodePack;
  warning: string;
  onClose: () => void;
  onError: (message: string | null) => void;
}) {
  const enableNodePack = useApp((state) => state.enableNodePack);
  const [version, setVersion] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const submit = () => {
    setBusy(true);
    setFailure(null);
    void enableNodePack(pack.id, version.trim(), acknowledged)
      .then((message) => {
        if (message) return setFailure(message);
        onError(null);
        closeRef.current();
      })
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      title={t("settings.workflows.enableTitle", { name: pack.name })}
      subtitle={<RepoLink url={pack.repo} />}
      size="m"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={() => closeRef.current()}>
            {t("common.cancel")}
          </button>
          {/* Both conditions, checked here AND by the engine. This gate is
              a courtesy to the operator; the engine's is the real one. */}
          <button
            className="btn-primary"
            disabled={busy || !acknowledged || version.trim() === ""}
            onClick={submit}
          >
            {busy ? t("settings.workflows.enabling") : t("settings.workflows.enableConfirm")}
          </button>
        </>
      }
    >
      {/* The engine's wording, not ours. role=alert so it is announced
          rather than read only by whoever happens to look down. */}
      <p className="banner warning" role="alert">
        {warning}
      </p>

      <label className="field">
        <span>{t("settings.workflows.versionLabel")}</span>
        <input
          value={version}
          placeholder={t("settings.workflows.versionPlaceholder")}
          aria-label={t("settings.workflows.versionLabel")}
          onChange={(event) => setVersion(event.target.value)}
        />
      </label>
      <p className="hint">{t("settings.workflows.versionHint")}</p>

      <label className="ack-row">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>{t("settings.workflows.acknowledge")}</span>
      </label>

      {failure && <Alert message={failure} onDismiss={() => setFailure(null)} />}
    </Modal>
  );
}

/** Imported workflow documents, and the file picker that adds one. */
function WorkflowList({
  onError,
  count,
}: {
  onError: (message: string | null) => void;
  count: number;
}) {
  const workflows = useApp((state) => state.workflows);
  const importWorkflow = useApp((state) => state.importWorkflow);
  const deleteWorkflow = useApp((state) => state.deleteWorkflow);
  const client = useApp((state) => state.client);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ name: string; verdict: WorkflowReview } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  /**
   * Reviewed before it is stored — the engine's own dry run.
   *
   * `/review` and the import are separate routes for the same reason the
   * composer previews an edit: a workflow that needs a pack the operator
   * has not granted is a refusal they can act on, and finding that out
   * from a stored-then-broken file is worse than being told first.
   */
  const pick = async (file: File) => {
    onError(null);
    setReview(null);
    setBusy(true);
    try {
      const name = file.name.replace(/\.json$/i, "").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const workflow = JSON.parse(await file.text()) as unknown;
      if (!client) return onError(t("errors.engineUnavailable"));
      const verdict = await client.reviewWorkflow(name, workflow);
      setReview({ name, verdict });
      const message = await importWorkflow(name, workflow);
      if (message) onError(message);
    } catch (err) {
      // A file that is not JSON never reaches the engine — the parse
      // failure names the file, which is more use than a 422 about a
      // document the engine could not read either.
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="setting-row">
      <div className="st">
        <FileJson {...ICON_SM} />
        {t("settings.workflows.filesHeading")}
      </div>
      <div className="sd">{t("settings.workflows.filesHint")}</div>

      {count > 0 && (
        <div className="workflow-list">
          {workflows.map((row) => (
            <div className="workflow-row" key={row.name}>
              <div>
                <div className="workflow-name">
                  {row.name}
                  {!row.readable && (
                    <span className="badge warn">{t("settings.workflows.unreadable")}</span>
                  )}
                </div>
                <div className="sd">
                  {plural("settings.workflows.nodeCount", row.nodes, { count: row.nodes })}
                  {row.placeholders.length > 0 &&
                    ` · ${t("settings.workflows.slots", { slots: row.placeholders.join(", ") })}`}
                  {/* Said plainly: a workflow with no slots renders the
                      same thing every time, which looks like a broken
                      model rather than a workflow that ignores its
                      prompt. */}
                  {row.readable && row.placeholders.length === 0 && ` · ${t("settings.workflows.noSlots")}`}
                </div>
              </div>
              <button
                className="icon-btn"
                aria-label={t("settings.workflows.removeAria", { name: row.name })}
                onClick={() => setConfirmDelete(row.name)}
              >
                <Trash2 size={14} strokeWidth={1.8} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="sc">
        <button className="btn-ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Plus {...ICON_SM} aria-hidden="true" />
          {busy ? t("settings.workflows.importing") : t("settings.workflows.import")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void pick(file);
          }}
        />
      </div>

      {/* What the engine said about the document it just accepted. Shown
          after the fact because a clean import is the common case and a
          dialog for it would be a click to dismiss good news — but the
          warnings and the placeholder list are worth seeing. */}
      {review && review.verdict.warnings.length > 0 && (
        <div className="banner warning" role="status">
          {review.verdict.warnings.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t("settings.workflows.removeTitle", { name: confirmDelete })}
          message={t("settings.workflows.removeMessage")}
          confirmLabel={t("common.delete")}
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const name = confirmDelete;
            setConfirmDelete(null);
            void deleteWorkflow(name).then(onError);
          }}
        />
      )}
    </div>
  );
}
