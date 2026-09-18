import { StrictMode, Component, ErrorInfo, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './src/App';
import { ApiKeyGate } from './src/components/ApiKeyGate';
import './src/index.css';

class ErrorBoundary extends Component<{children: ReactNode}, {error: Error | null}> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: 'red', padding: '20px', backgroundColor: 'white', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 }}>
          <h1>Something went wrong.</h1>
          <pre>{(this.state.error as any).toString()}</pre>
          <pre>{(this.state.error as any).stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ApiKeyGate>
        <App />
      </ApiKeyGate>
    </ErrorBoundary>
  </StrictMode>,
);
