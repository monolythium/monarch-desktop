// Route-level error boundary. A crashed view renders a glass card with
// the error text, a copy-diagnostics button, and a reload link instead
// of white-screening the whole shell. `resetKey` (the current pathname)
// clears the error when the operator navigates to a different route.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { rpcEndpoint } from "../sdk/client";
import "../styles/livedata.css";

type Props = {
  children: ReactNode;
  /** Changing this key (e.g. on navigation) clears a held error. */
  resetKey?: string;
};

type State = {
  error: Error | null;
  componentStack: string | null;
  copied: boolean;
};

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(_error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
  }

  override componentDidUpdate(prevProps: Props): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null, componentStack: null, copied: false });
    }
  }

  private copyDiagnostics = (): void => {
    const { error, componentStack } = this.state;
    const diagnostics = {
      app: "monarch-desktop",
      at: new Date().toISOString(),
      route: typeof window !== "undefined" ? window.location.pathname : null,
      endpoint: rpcEndpoint,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      error: error ? `${error.name}: ${error.message}` : null,
      stack: error?.stack ?? null,
      componentStack,
    };
    void navigator.clipboard
      ?.writeText(JSON.stringify(diagnostics, null, 2))
      .then(() => {
        this.setState({ copied: true });
        window.setTimeout(() => this.setState({ copied: false }), 1600);
      });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="view fade-in">
        <div className="lv-crash" role="alert">
          <h2>This view crashed</h2>
          <div className="lv-crash__message">
            {error.name}: {error.message}
          </div>
          <div className="lv-crash__actions">
            <button type="button" className="btn btn--primary btn--sm" onClick={this.copyDiagnostics}>
              {this.state.copied ? "Copied ✓" : "Copy diagnostics"}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => window.location.reload()}
            >
              Reload app
            </button>
            <a className="btn btn--ghost btn--sm" href="/home">
              Back to Home
            </a>
          </div>
          <div className="lv-crash__hint">
            The rest of Monarch keeps running — only this route failed. Copy the
            diagnostics before reloading if you want to report the crash.
          </div>
        </div>
      </section>
    );
  }
}
