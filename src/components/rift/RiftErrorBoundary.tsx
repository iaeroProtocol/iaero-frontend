// src/components/rift/RiftErrorBoundary.tsx
//
// Keeps an error inside "Get iAERO" (for example a malformed saved order) from taking the rest of the page down.

'use client';

import React from 'react';

interface State { error: Error | null }

export default class RiftErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('Get iAERO error', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="space-y-3 rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-200">
        <div className="font-medium text-white">Get iAERO hit an error</div>
        <div>Your orders and funds are not affected. Try again, or reload the page.</div>
        <button type="button" onClick={() => this.setState({ error: null })} className="rounded-lg border border-red-400/40 px-3 py-1.5 text-red-100 hover:border-red-300">Try again</button>
      </div>
    );
  }
}
