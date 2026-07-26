import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

/** Last-resort catch: a render crash shows an error message instead of a
 * blank window — and offers a way out of it.
 *
 * It used to log nothing and offer nothing, so any render error meant
 * restarting the app, and the one artifact that would have explained the
 * crash (the component stack) was thrown away. Both are cheap to keep. */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; stack: string | null }
> {
  state: { error: Error | null; stack: string | null } = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is the only thing that says WHERE it broke, and it
    // exists only here — getDerivedStateFromError never sees it.
    console.error("[ui] render error:", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  /** Clear the error and re-render the tree. Most render crashes come from
   * one bad piece of state, so retrying usually works — and when it doesn't,
   * the user is no worse off than the dead end they had before. */
  private retry = (): void => {
    this.setState({ error: null, stack: null });
  };

  private reload = (): void => {
    window.location.reload();
  };

  private copyDetails = (): void => {
    const { error, stack } = this.state;
    void navigator.clipboard.writeText(
      [error?.message, error?.stack, stack].filter(Boolean).join("\n\n"),
    );
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="banner error error-boundary" role="alert">
          <p>{t("errors.somethingWrong", { message: this.state.error.message })}</p>
          <div className="error-boundary-actions">
            <button className="btn-outline" onClick={this.retry}>
              {t("errors.tryAgain")}
            </button>
            <button className="btn-ghost" onClick={this.reload}>
              {t("errors.reloadApp")}
            </button>
            <button className="btn-ghost" onClick={this.copyDetails}>
              {t("errors.copyDetails")}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
