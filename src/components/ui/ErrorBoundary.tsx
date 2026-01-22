import { Component, ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary component for catching React component errors
 * Provides graceful error handling and user feedback
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Error caught by boundary:', error, errorInfo);

    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
    });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          padding: 'var(--space-8)',
          textAlign: 'center',
          maxWidth: '600px',
          margin: '0 auto'
        }}>
          <div style={{
            fontSize: '48px',
            marginBottom: 'var(--space-4)'
          }}>
            ⚠️
          </div>
          <h2 className="text-xl" style={{ marginBottom: 'var(--space-4)' }}>
            Something went wrong
          </h2>
          <p className="text-sm text-secondary" style={{ marginBottom: 'var(--space-6)' }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <details style={{
            textAlign: 'left',
            marginBottom: 'var(--space-6)',
            padding: 'var(--space-4)',
            background: 'var(--bg-secondary)',
            borderRadius: '8px'
          }}>
            <summary className="text-xs text-tertiary" style={{ cursor: 'pointer' }}>
              Error Details
            </summary>
            <pre className="text-xs" style={{
              marginTop: 'var(--space-2)',
              overflow: 'auto',
              maxHeight: '200px'
            }}>
              {this.state.error?.stack}
            </pre>
          </details>
          <button
            onClick={this.handleReset}
            className="btn-primary"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
