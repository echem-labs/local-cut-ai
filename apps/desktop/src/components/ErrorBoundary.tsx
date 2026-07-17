import { Component, type ReactNode } from "react";

/** Last-resort catch: a render crash shows an error message instead of a
 * blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="banner error" role="alert">
          Something went wrong: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}
