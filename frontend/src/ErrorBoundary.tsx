import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

// Catches render-time exceptions anywhere in the subtree and shows a readable
// panel instead of a blank white screen. Without this, an uncaught render
// error unmounts the whole React tree and the WebView goes blank — making
// bugs like a mismatched enum `kind` tag impossible to see.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Render crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash">
          <h2>界面渲染出错</h2>
          <pre>{this.state.error.message}</pre>
          <p>已记录到控制台（open devtools / 终端日志）。请重试或联系开发者。</p>
          <button onClick={() => this.setState({ error: null })}>重置界面</button>
        </div>
      );
    }
    return this.props.children;
  }
}
