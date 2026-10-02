// src/lib/rift/timing.ts
//
// Timing expectations and progress for a Rift order. Rift's API reports only coarse states
// (awaiting_deposit -> funded -> executing -> delivered) and no ETAs, so the step list comes from the
// quote's route and the durations from each network's and venue's usual behaviour. These are starting
// estimates: every order's real timings are recorded (storage.ts) so they can be tuned.
// Pure, with no imports, so `node --test` can run it (tests/rift/).

export type StepKind = 'deposit' | 'bridge' | 'swap' | 'deliver';

export interface StepEstimate {
  key: string;
  kind: StepKind;
  label: string;
  detail?: string;
  /** Usual duration, and a "taking longer than usual" threshold, in seconds. */
  typicalSec: number;
  slowSec: number;
}

export interface RouteEstimate {
  steps: StepEstimate[];
  typicalSec: number;
  slowSec: number;
}

export interface RouteLike { venue: string; from: string; to: string }

const CHAIN_NAMES: Record<string, string> = {
  ethereum: 'Ethereum', arbitrum: 'Arbitrum', base: 'Base', bitcoin: 'Bitcoin',
  hyperliquid: 'Hyperliquid', ink: 'Ink', robinhood: 'Robinhood',
};

const chainOf = (id: string) => (id.includes('.') ? id.slice(0, id.indexOf('.')).toLowerCase() : '');
export const chainName = (chainKey: string) =>
  CHAIN_NAMES[chainKey] ?? (chainKey ? chainKey[0].toUpperCase() + chainKey.slice(1) : 'unknown chain');

/** `base.usdc` -> USDC; `base.0x8103...` -> a known symbol or a short address. */
export function symbolOf(asset: string, known: Record<string, string> = {}): string {
  const hit = known[asset] ?? known[asset.toLowerCase()];
  if (hit) return hit;
  const id = asset.includes('.') ? asset.slice(asset.indexOf('.') + 1) : asset;
  if (/^0x[0-9a-fA-F]{40}$/.test(id)) return `${id.slice(0, 6)}…${id.slice(-4)}`;
  return id.toUpperCase();
}

// Seconds as [typical, slow]. Deposit: until Rift has seen the payment (inclusion plus confirmations).
// Typical values for Arbitrum and Base, Across and same-chain swaps follow the first real order
// (2026-10-02: mPendle on Arbitrum -> USDC -> Across -> iAERO on Base, delivered 54 s after the order
// was created, wallet confirmation included). The slow thresholds are unchanged.
export const DEPOSIT_TIMING: Record<string, [number, number]> = {
  base: [8, 90],
  arbitrum: [10, 120],
  ethereum: [60, 300],
  bitcoin: [20 * 60, 60 * 60],
  // A HyperCore transfer is final when Hyperliquid accepts it; Rift sees it within seconds.
  hyperliquid: [5, 60],
};

export const VENUE_TIMING: Record<string, [number, number]> = {
  across: [15, 240],
  relay: [30, 180],
  cctp_fast: [60, 300],
  cctp_hyperliquid_fast: [60, 300],
  cctp_standard: [17 * 60, 35 * 60],
  cctp_hyperliquid_standard: [17 * 60, 35 * 60],
  unit: [25 * 60, 75 * 60],
  hyperliquid_spot: [10, 60],
  chainflip: [5 * 60, 20 * 60],
  mayan: [2 * 60, 10 * 60],
  near_intents: [2 * 60, 10 * 60],
  transit: [2 * 60, 10 * 60],
  lifi_fast: [60, 5 * 60],
  lifi_standard: [5 * 60, 20 * 60],
};
const SWAP_TIMING: [number, number] = [10, 120];
const UNKNOWN_BRIDGE_TIMING: [number, number] = [3 * 60, 15 * 60];
const DELIVERY_TIMING: [number, number] = [5, 45];

const VENUE_NAMES: Record<string, string> = {
  across: 'Across', relay: 'Relay', cctp_fast: 'CCTP fast transfer', cctp_standard: 'CCTP',
  cctp_hyperliquid_fast: 'CCTP fast transfer', cctp_hyperliquid_standard: 'CCTP', unit: 'Unit',
  hyperliquid_spot: 'Hyperliquid', chainflip: 'Chainflip', mayan: 'Mayan', near_intents: 'NEAR Intents',
  transit: 'Transit', lifi_fast: 'LI.FI', lifi_standard: 'LI.FI', kyberswap: 'KyberSwap', velora: 'Velora',
  okx: 'OKX', flytrade: 'Fly', aave: 'Aave', morpho: 'Morpho', nordstern: 'Nordstern', uniswap: 'Uniswap',
};
export const venueName = (venue: string) => VENUE_NAMES[venue] ?? venue;

export function describeStep(step: RouteLike, known: Record<string, string> = {}): { kind: 'bridge' | 'swap'; label: string; detail: string } {
  const from = chainOf(step.from), to = chainOf(step.to);
  const a = symbolOf(step.from, known), b = symbolOf(step.to, known);
  const detail = `via ${venueName(step.venue)}`;
  if (from !== to) {
    const label = a === b
      ? `Move ${a} from ${chainName(from)} to ${chainName(to)}`
      : `Swap ${a} for ${b}, ${chainName(from)} to ${chainName(to)}`;
    return { kind: 'bridge', label, detail };
  }
  return { kind: 'swap', label: `Swap ${a} for ${b} on ${chainName(from)}`, detail };
}

export function estimateRoute(sourceChain: string, route: RouteLike[], known: Record<string, string> = {}): RouteEstimate {
  const [depT, depS] = DEPOSIT_TIMING[sourceChain] ?? [60, 300];
  const steps: StepEstimate[] = [{
    key: 'deposit', kind: 'deposit', label: `Your payment confirms on ${chainName(sourceChain)}`,
    detail: sourceChain === 'bitcoin' ? 'Bitcoin blocks come about every 10 minutes' : undefined,
    typicalSec: depT, slowSec: depS,
  }];
  route.forEach((s, i) => {
    const d = describeStep(s, known);
    const [t, w] = VENUE_TIMING[s.venue] ?? (d.kind === 'swap' ? SWAP_TIMING : UNKNOWN_BRIDGE_TIMING);
    steps.push({ key: `step-${i}`, kind: d.kind, label: d.label, detail: d.detail, typicalSec: t, slowSec: w });
  });
  steps.push({
    key: 'deliver', kind: 'deliver', label: 'iAERO arrives in your wallet on Base',
    typicalSec: DELIVERY_TIMING[0], slowSec: DELIVERY_TIMING[1],
  });
  return {
    steps,
    typicalSec: steps.reduce((n, s) => n + s.typicalSec, 0),
    slowSec: steps.reduce((n, s) => n + s.slowSec, 0),
  };
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${Math.max(5, Math.round(s / 5) * 5)} sec`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m === 60 ? `${h + 1} h` : m ? `${h} h ${m} min` : `${h} h`;
}

/** "about 45 sec", "2–6 min", "40 min – 2 h 15 min". */
export function formatRange(typicalSec: number, slowSec: number): string {
  if (slowSec <= typicalSec * 1.2) return `about ${formatDuration(typicalSec)}`;
  if (typicalSec >= 60 && slowSec < 3600) return `${Math.max(1, Math.round(typicalSec / 60))}–${Math.round(slowSec / 60)} min`;
  return `${formatDuration(typicalSec)} – ${formatDuration(slowSec)}`;
}

/** Stopwatch: "0:45", "12:03", "1:02:03". */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export type Phase =
  | 'pay' | 'confirming' | 'detecting' | 'executing'
  | 'delivered' | 'refunded' | 'expired' | 'frozen' | 'underfunded';

export interface ProgressInput {
  status: string;
  sourceKind: 'evm' | 'bitcoin' | 'hypercore';
  createdAt: number;
  depositSentAt?: number;
  depositConfirmedAt?: number;
  btcSeenAt?: number;
  fundedAt?: number;
  finishedAt?: number;
  now: number;
  estimate: RouteEstimate;
}

export interface Progress {
  phase: Phase;
  /** Index into estimate.steps of the step in progress; steps.length once everything is done. */
  activeIndex: number;
  fraction: number;
  elapsedSec: number;
  remainingSec: number;
  /** Expected completion time (ms), while the order is still moving. */
  expectedDoneAt?: number;
  /** True once the current phase has run past its "slow" threshold. */
  slow: boolean;
  /** Past the usual time: "usually done by now". */
  overrun?: boolean;
  /** Worst case still to go (seconds), from the remaining "slow" thresholds; undefined once past all of them
   *  (there is then no honest figure to give). */
  upToSec?: number;
}

export function phaseOf(p: Pick<ProgressInput, 'status' | 'sourceKind' | 'depositSentAt' | 'depositConfirmedAt' | 'btcSeenAt'>): Phase {
  switch (p.status) {
    case 'delivered': case 'refunded': case 'expired': case 'frozen': case 'underfunded':
      return p.status;
    case 'funded': case 'executing':
      return 'executing';
  }
  if (p.sourceKind === 'bitcoin') return p.btcSeenAt ? 'confirming' : 'pay';
  if (!p.depositSentAt) return 'pay';
  return p.depositConfirmedAt ? 'detecting' : 'confirming';
}

export function computeProgress(p: ProgressInput): Progress {
  const { estimate: est, now } = p;
  const phase = phaseOf(p);
  const steps = est.steps, last = steps.length - 1;
  const started = p.depositSentAt ?? p.btcSeenAt ?? p.fundedAt;
  // Clocks can be adjusted and saved times can come from another tab: never negative.
  const elapsedSec = started ? Math.max(0, ((p.finishedAt ?? now) - started) / 1000) : 0;
  const total = Math.max(1, est.typicalSec);
  const clamp = (f: number) => Math.min(Math.max(f, 0), 0.97);
  const slowAfter = (from: number) => steps.slice(from).reduce((n, s) => n + s.slowSec, 0);
  const typicalAfter = (from: number) => steps.slice(from).reduce((n, s) => n + s.typicalSec, 0);

  if (phase === 'delivered') return { phase, activeIndex: steps.length, fraction: 1, elapsedSec, remainingSec: 0, slow: false };
  if (phase === 'refunded' || phase === 'expired' || phase === 'frozen' || phase === 'underfunded') {
    return { phase, activeIndex: phase === 'expired' ? 0 : 1, fraction: 0, elapsedSec, remainingSec: 0, slow: false };
  }
  if (phase === 'pay') return { phase, activeIndex: 0, fraction: 0, elapsedSec: 0, remainingSec: est.typicalSec, slow: false };

  if (phase === 'confirming' || phase === 'detecting') {
    const inStep = started ? Math.max(0, (now - started) / 1000) : 0;
    const dep = steps[0];
    const remainingSec = Math.max(0, dep.typicalSec - inStep) + typicalAfter(1);
    return {
      phase, activeIndex: 0, elapsedSec,
      fraction: clamp((Math.min(inStep / dep.typicalSec, 0.9) * dep.typicalSec) / total),
      remainingSec, expectedDoneAt: now + remainingSec * 1000, slow: inStep > dep.slowSec,
      overrun: inStep > dep.typicalSec, upToSec: inStep > dep.slowSec ? undefined : dep.slowSec - inStep + slowAfter(1),
    };
  }

  // executing: Rift does not say which hop is running, so the step shown follows the clock (time past every
  // hop's usual duration stays on the last hop). Slowness is judged on the route as a whole, since which hop is
  // late is a guess: slow once past the usual total plus the largest single hop's allowance for running long.
  const fundedAt = p.fundedAt ?? now;
  const t = Math.max(0, (now - fundedAt) / 1000);
  let acc = 0, activeIndex = last - 1 >= 1 ? last - 1 : last, inStep = 0;
  for (let i = 1; i < last; i++) {
    if (t < acc + steps[i].typicalSec) { activeIndex = i; inStep = t - acc; break; }
    acc += steps[i].typicalSec;
    inStep = t - (acc - steps[i].typicalSec);
  }
  const doneBefore = steps.slice(0, activeIndex).reduce((n, s) => n + s.typicalSec, 0);
  const active = steps[activeIndex];
  const within = Math.min(inStep / Math.max(1, active.typicalSec), 0.95);
  const routeTypical = typicalAfter(1), routeWorst = slowAfter(1);
  const slowAt = routeTypical + Math.max(0, ...steps.slice(1).map(s => s.slowSec - s.typicalSec));
  const remainingSec = Math.max(0, routeTypical - t);
  return {
    phase, activeIndex, elapsedSec,
    fraction: clamp((doneBefore + within * active.typicalSec) / total),
    remainingSec, expectedDoneAt: now + remainingSec * 1000,
    slow: t > slowAt,
    overrun: t > routeTypical,
    upToSec: t < routeWorst ? routeWorst - t : undefined,
  };
}
