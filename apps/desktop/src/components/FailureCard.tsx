import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import type { ModelRow, NodeState } from "../api/types";
import { t } from "../i18n";
import { modelThatFailed, nextResolutionScale, smallerModelFor } from "../lib/oom";
import { useApp } from "../store";
import { Alert } from "./Alert";
import { Tip } from "./Tooltip";

/**
 * What the engine suggested doing about a render that ran out of memory.
 *
 * The scheduler has published `suggestions` alongside `job.failed` since the
 * OOM ladder was written — with the comment "the UI renders this as choices,
 * not an error code" — and until now nothing rendered them at all. The user
 * got "out of memory after 2 fallback attempts" and no way forward except
 * pressing the same button again.
 *
 * Each chip does the thing it names, through the ordinary `/patch` door, and
 * says in its hint what it will cost. A chip that cannot act says so instead
 * of failing when pressed: the two answers a machine can honestly give here
 * are "here is a smaller model you already have" and "you have none".
 */
export function FailureCard({ node }: { node: NodeState }) {
  const failure = useApp((state) => state.nodeFailures[node.node_id]);
  const models = useApp((state) => state.models);
  const jobs = useApp((state) => state.jobs);
  const applyOomSuggestion = useApp((state) => state.applyOomSuggestion);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // No advice: the node still failed, and the message is the whole story.
  // Ordinary failures (a backend that threw, an undecodable input) carry no
  // suggestions, so this is the common path.
  if (!failure || failure.suggestions.length === 0) {
    return node.error ? <Alert message={node.error} /> : null;
  }

  const smaller = smallerModelFor(
    node.node_id,
    models,
    modelThatFailed(node.node_id, jobs, node),
  );
  const nextScale = nextResolutionScale(node.params.resolution_scale);

  /** The chip's label and hint, plus whether it can act at all. A suggestion
   * the engine offers but this machine cannot honour stays visible and
   * disabled — hiding it would leave the card claiming fewer ways out than
   * the engine believes exist. */
  const describe = (code: string): { label: string; hint: string; ready: boolean } => {
    if (code === "lower_resolution") {
      return {
        label: t("failure.suggestion.lower_resolution"),
        hint:
          nextScale === null
            ? t("failure.alreadySmallest")
            : t("failure.suggestionHint.lower_resolution", {
                pct: `${Math.round(nextScale * 100)}%`,
              }),
        ready: nextScale !== null,
      };
    }
    if (code === "smaller_model") {
      const was = failedVram(node, jobs, models);
      return {
        // Named when there is one to name: a chip reading "use a smaller
        // model" asks the user to trust an unnamed swap, and which model it
        // would pick is knowable. Only the disabled case stays generic.
        label: smaller
          ? t("failure.suggestion.smaller_model", { model: smaller.id })
          : t("failure.suggestion.smaller_model_none"),
        hint: smaller
          ? t("failure.suggestionHint.smaller_model", {
              vram: String(smaller.requirements.vram_gb),
              was: was === null ? "?" : String(was),
            })
          : t("failure.noSmallerModel"),
        ready: smaller !== null,
      };
    }
    if (code === "cloud") {
      return {
        label: t("failure.suggestion.cloud"),
        hint: t("failure.suggestionHint.cloud"),
        ready: true,
      };
    }
    // A code this build has no arm for — a newer engine offering a way out
    // this app predates. Shown and disabled for the same reason an unservable
    // chip is: the engine believes a way out exists. Labelled as unknown
    // rather than as whichever arm happens to be last, which is what the
    // fallthrough used to do — a chip reading "Set up a cloud provider" that
    // answered "this build does not know how to act on that suggestion".
    return {
      label: t("failure.suggestion.unknown"),
      hint: t("failure.unknownSuggestion"),
      ready: false,
    };
  };

  return (
    <div className="failure-card" role="group" aria-label={t("failure.title")}>
      <p className="failure-head">
        <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
        {t("failure.title")}
      </p>
      <p className="failure-why">{t("failure.outOfMemoryHint")}</p>
      <div className="chip-row">
        {failure.suggestions.map((code) => {
          const { label, hint, ready } = describe(code);
          return (
            <Tip key={code} label={label} hint={hint}>
              <button
                type="button"
                className="chip"
                disabled={!ready || busy !== null}
                onClick={() => {
                  setError(null);
                  setBusy(code);
                  void applyOomSuggestion(node.node_id, code)
                    .then(setError)
                    .finally(() => setBusy(null));
                }}
              >
                {label}
              </button>
            </Tip>
          );
        })}
      </div>
      {error && <Alert message={error} onDismiss={() => setError(null)} />}
    </div>
  );
}

/** VRAM the model that failed wanted, for the "instead of N GB" half of the
 * smaller-model hint. Null when it has no manifest row (external, or since
 * removed) — the hint then says what the new one needs and nothing more. */
function failedVram(
  node: NodeState,
  jobs: ReturnType<typeof useApp.getState>["jobs"],
  models: ModelRow[],
): number | null {
  const id = modelThatFailed(node.node_id, jobs, node);
  const row = id ? models.find((model) => model.id === id) : undefined;
  return row?.requirements.vram_gb ?? null;
}
