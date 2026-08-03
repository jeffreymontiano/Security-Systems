import { Component } from "react";

/**
 * Catches render-time crashes so one broken component shows a message instead
 * of unmounting the whole app to a blank white page — which gives the user
 * nothing to report and no way back except a manual refresh.
 *
 * Scoped around the module area rather than the whole shell, so the sidebar
 * stays usable and you can navigate to another module without reloading.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the stack in the console for diagnosis; the UI stays non-technical.
    console.error("[ui] Component crashed:", error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // Navigating elsewhere should clear the error so the app recovers without
    // a page reload.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="module-view">
        <div className="section-card" style={{ margin: 32, padding: 24 }}>
          <h2 style={{ marginTop: 0, color: "var(--navy)" }}>Something went wrong on this page</h2>
          <p style={{ fontSize: 13.5, color: "var(--text-mute)" }}>
            This section failed to display. Your data hasn't been changed — nothing was saved or deleted.
            Try another module from the sidebar, or reload the page.
          </p>
          <p style={{ fontSize: 12, color: "var(--text-mute)" }}>
            If it keeps happening, report this message: <code>{String(this.state.error?.message || this.state.error)}</code>
          </p>
          <button className="btn btn-gold" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </div>
    );
  }
}
