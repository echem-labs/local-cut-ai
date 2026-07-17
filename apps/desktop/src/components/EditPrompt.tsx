import { useState } from "react";
import type { EditResult } from "../api/types";
import { useApp } from "../store";

/** Natural-language edit box — one instruction in, a graph patch out.
 * Mounted at project scope (above the scene board) and at scene scope
 * (inside the inspector); result feedback stays local to whichever box
 * submitted the edit. */
export function EditPrompt({ scope, placeholder }: { scope: string; placeholder: string }) {
  const { edit, editBusy } = useApp();
  const [text, setText] = useState("");
  const [result, setResult] = useState<EditResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const instruction = text.trim();
    if (!instruction || editBusy) return;
    setError(null);
    setResult(null);
    try {
      const res = await edit(instruction, scope);
      if (res) {
        setResult(res);
        if (res.ops > 0) setText("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const feedback = (res: EditResult): string => {
    const skipped =
      res.warnings.length > 0 ? ` (${res.warnings.length} part(s) didn't apply)` : "";
    if (res.ops === 0) {
      return `No changes made${res.summary ? ` — ${res.summary}` : ""}${skipped}`;
    }
    return `${res.summary || "Edit applied"} — re-rendering ${res.dirty.length} node(s)${skipped}`;
  };

  return (
    <div className="edit-prompt">
      <div className="edit-prompt-row">
        <input
          value={text}
          placeholder={placeholder}
          aria-label="Edit with a prompt"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
          disabled={editBusy}
        />
        <button
          className="btn-primary"
          onClick={() => void submit()}
          disabled={editBusy || !text.trim()}
        >
          {editBusy ? "Thinking…" : "Edit"}
        </button>
      </div>
      {result && <div className="hint">{feedback(result)}</div>}
      {error && <div className="banner error">{error}</div>}
    </div>
  );
}
