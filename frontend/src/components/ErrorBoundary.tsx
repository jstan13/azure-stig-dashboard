import { Component, ErrorInfo, ReactNode } from 'react';
import { MessageBar, MessageBarType, PrimaryButton, Stack, Text } from '@fluentui/react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Keeps one page's render error from blanking the whole app. React unmounts the
 * entire tree on an uncaught render throw, so without this a single bad API
 * payload takes the navigation down with it and leaves a white screen.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <Stack tokens={{ childrenGap: 12 }} style={{ padding: 24 }}>
        <MessageBar messageBarType={MessageBarType.error}>
          This page hit an unexpected error and could not be displayed.
        </MessageBar>
        <Text variant="small" style={{ color: '#605e5c', fontFamily: 'monospace' }}>
          {error.message}
        </Text>
        <Stack horizontal tokens={{ childrenGap: 8 }}>
          <PrimaryButton text="Reload" onClick={() => window.location.reload()} />
        </Stack>
      </Stack>
    );
  }
}
