import { EngineTimeoutError } from "../api/client";
import { t } from "../i18n";

/**
 * One thrown thing, in words a person can act on.
 *
 * The house rule is that anything reporting a rejection routes through here
 * rather than through an inline `instanceof Error` ternary — two of the
 * three cases below are exactly the ones such a ternary gets wrong, because
 * the platform's own message names neither the actor nor a next step.
 *
 * It lived inside `store.ts` as a private const, which made the rule
 * unfollowable outside the store: a component reaching for it had to either
 * import from the store module or write the ternary the rule forbids.
 */
export const messageOf = (err: unknown): string => {
  // fetch's network-level failure is a TypeError whose message ("Failed to
  // fetch") names neither the engine nor a next step — say what it means
  // here, the one place every action's error passes through.
  if (err instanceof TypeError) return t("errors.engineUnreachable", { detail: err.message });
  // The platform's own wording for an aborted fetch is "signal timed out",
  // which names no actor and no next step. Say which side gave up, and that
  // the work may not have been wasted — the engine is still going.
  if (err instanceof EngineTimeoutError)
    return t("errors.engineTimeout", { seconds: Math.round(err.timeoutMs / 1000) });
  return err instanceof Error ? err.message : String(err);
};
