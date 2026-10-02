// src/components/rift/RiftErrorBoundary.tsx
//
// Keeps an error inside "Get iAERO" (for example a malformed saved order) from taking the rest of the page
// down. Used around the whole section, around each order card (so one bad record cannot hide the others), and
// around the background order watcher (which then renders nothing).

'use client';

import React from 'react';

interface Props {
  children: React.ReactNode;
  /** What to show instead; `reset` tries rendering the children again. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  onError?: (error: Error) => void;
}
interface State { error: Error | null }

export default class RiftErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('Get iAERO error', error);
    this.props.onError?.(error);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div role="alert" className="space-y-3 rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-200">
        <div className="font-medium text-white">Get iAERO hit an error</div>
        <div>Your orders and funds are not affected, and orders keep being tracked. Try again, or reload the page.</div>
        <button type="button" onClick={this.reset} className="rounded-lg border border-red-400/40 px-3 py-1.5 text-red-100 hover:border-red-300">Try again</button>
      </div>
    );
  }
}
