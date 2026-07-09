/**
 * UI Module - Error Boundary
 *
 * React error boundary with persistent error logging and recovery UI.
 */

import React from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Error Logging
// ============================================================================

interface ErrorBoundaryProps {
  children: React.ReactNode;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: string;
}

/**
 * Log error to persistent file for debugging
 */
export function logErrorToFile(error: Error | null, componentStack: string): void {
  try {
    const errorLogPath = path.join(
      process.env.HOME || process.env.USERPROFILE || '/tmp',
      '.calliope-cli',
      'errors.log'
    );
    const errorLogDir = path.dirname(errorLogPath);

    // Ensure directory exists
    if (!fs.existsSync(errorLogDir)) {
      fs.mkdirSync(errorLogDir, { recursive: true });
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      error: error?.message || 'Unknown error',
      stack: error?.stack || '',
      componentStack,
      nodeVersion: process.version,
      platform: process.platform,
    };

    const logLine = JSON.stringify(logEntry) + '\n';

    // Append to log file (create if doesn't exist)
    fs.appendFileSync(errorLogPath, logLine, 'utf-8');

    // Rotate log if too large (> 1MB)
    const stats = fs.statSync(errorLogPath);
    if (stats.size > 1024 * 1024) {
      const backupPath = errorLogPath + '.old';
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
      fs.renameSync(errorLogPath, backupPath);
    }
  } catch {
    // Silently fail if we can't write to log file
  }
}

// ============================================================================
// Error Boundary Component
// ============================================================================

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: '' };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log error details
    const info = errorInfo.componentStack || '';
    this.setState({ errorInfo: info });

    // Log to console
    console.error('Calliope Error:', error);
    console.error('Component Stack:', info);

    // Log to persistent file for debugging
    logErrorToFile(error, info);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: '' });
    this.props.onReset?.();
  };

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback
        error={this.state.error}
        errorInfo={this.state.errorInfo}
        onRetry={this.handleRetry}
      />;
    }
    return this.props.children;
  }
}

// ============================================================================
// Error Fallback UI
// ============================================================================

export function ErrorFallback({
  error,
  errorInfo,
  onRetry
}: {
  error: Error | null;
  errorInfo: string;
  onRetry: () => void;
}) {
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'r' || input === 'R') {
      onRetry();
    } else if (input === 'q' || input === 'Q' || key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="red" bold>⚠️  Calliope encountered an error</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">{error?.message || 'Unknown error'}</Text>
        {error?.name && error.name !== 'Error' && (
          <Text dimColor>Type: {error.name}</Text>
        )}
      </Box>

      {errorInfo && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Component trace:</Text>
          <Text dimColor>{errorInfo.split('\n').slice(0, 5).join('\n')}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text>
          <Text color="cyan">[R]</Text>
          <Text>etry  </Text>
          <Text color="cyan">[Q]</Text>
          <Text>uit</Text>
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>If this persists, try: calliope --legacy</Text>
      </Box>
    </Box>
  );
}
