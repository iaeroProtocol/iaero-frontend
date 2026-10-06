// src/components/protocol/WalletConnection.tsx
//
// The header's wallet button, drawn like RainbowKit's own ConnectButton (light theme). The header's NetworkSwitcher
// handles networks, so there is no chain button: RainbowKit's chain menu would also list Ethereum and Arbitrum,
// which the wallet config carries only so Get iAERO can pay from them. RainbowKit's own button can't be used with
// its chain button hidden: on a chain the config doesn't list (e.g. Optimism) it drops the account button and shows
// only the (hidden) "Wrong network" one, leaving no address and no way to disconnect. Here the account button always
// stays, next to a "Wrong network" button that switches the wallet to Base. RainbowKit won't open its account modal
// on such a chain, so the account button then opens its chain modal, which offers the networks and Disconnect.

'use client';

import React, { useMemo } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useSwitchToBase, type ShowToast } from '@/components/SwitchToBase';

const FONT = 'SFRounded, ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const BUTTON = 'flex h-10 shrink-0 items-center rounded-xl text-[16px] font-bold shadow-[0px_4px_12px_rgba(0,0,0,0.1)] transition-transform duration-150 hover:scale-[1.025] active:scale-95 disabled:opacity-70';

// RainbowKit's default avatar, an emoji on a colour picked from the address, so the button looks as it always has.
const C = ['#FC5C54', '#FFD95A', '#E95D72', '#6A87C8', '#5FD0F3', '#75C06B', '#FFDD86', '#5FC6D4', '#FF949A', '#FF8024', '#9BA1A4', '#EC66FF',
  '#FF8CBC', '#FF9A23', '#C5DADB', '#A8CE63', '#71ABFF', '#FFE279', '#B6B1B6', '#FF6780', '#A575FF', '#4D82FF', '#FFB35A'];
const AVATARS: [string, string][] = [
  [C[0], '\u{1F336}'], [C[1], '\u{1F911}'], [C[2], '\u{1F419}'], [C[3], '\u{1FAD0}'], [C[4], '\u{1F433}'], [C[0], '\u{1F936}'],
  [C[5], '\u{1F332}'], [C[6], '\u{1F31E}'], [C[7], '\u{1F412}'], [C[8], '\u{1F435}'], [C[9], '\u{1F98A}'], [C[10], '\u{1F43C}'],
  [C[11], '\u{1F984}'], [C[12], '\u{1F437}'], [C[13], '\u{1F427}'], [C[8], '\u{1F9A9}'], [C[14], '\u{1F47D}'], [C[0], '\u{1F388}'],
  [C[8], '\u{1F349}'], [C[1], '\u{1F389}'], [C[15], '\u{1F432}'], [C[16], '\u{1F30E}'], [C[17], '\u{1F34A}'], [C[18], '\u{1F42D}'],
  [C[19], '\u{1F363}'], [C[1], '\u{1F425}'], [C[20], '\u{1F47E}'], [C[15], '\u{1F966}'], [C[0], '\u{1F479}'], [C[17], '\u{1F640}'],
  [C[4], '⛱'], [C[21], '⛵️'], [C[17], '\u{1F973}'], [C[8], '\u{1F92F}'], [C[22], '\u{1F920}'],
];
function emojiAvatar(address: string) {
  let hash = 0;
  for (const ch of address.toLowerCase()) { hash = (hash << 5) - hash + ch.charCodeAt(0); hash |= 0; }
  return AVATARS[Math.abs(hash % AVATARS.length)];
}

function Avatar({ address, imageUrl }: { address: string; imageUrl?: string }) {
  const [color, emoji] = useMemo(() => emojiAvatar(address), [address]);
  if (imageUrl) return <img src={imageUrl} alt="" aria-hidden className="h-6 w-6 shrink-0 rounded-full object-cover" />;
  return (
    <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full" style={{ backgroundColor: color }}>
      {emoji}
    </span>
  );
}

const Chevron = () => (
  <svg aria-hidden fill="none" height="7" width="14" className="shrink-0">
    <path d="M12.75 1.54001L8.51647 5.0038C7.77974 5.60658 6.72026 5.60658 5.98352 5.0038L1.75 1.54001" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
  </svg>
);

export default function WalletConnection({ showToast }: { showToast?: ShowToast }) {
  const { switchToBase, isPending } = useSwitchToBase(showToast);
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, authenticationStatus, openAccountModal, openChainModal, openConnectModal }) => {
        const ready = mounted && authenticationStatus !== 'loading';
        const connected = ready && account && chain && (!authenticationStatus || authenticationStatus === 'authenticated');
        return (
          <div
            className="flex flex-wrap items-center gap-2 md:justify-end"
            style={{ fontFamily: FONT, ...(!ready && { opacity: 0, pointerEvents: 'none', userSelect: 'none' }) }}
            aria-hidden={!ready || undefined}
          >
            {!connected ? (
              <button type="button" data-testid="rk-connect-button" onClick={openConnectModal} className={`${BUTTON} bg-[#0E76FD] px-3.5 text-white`}>
                Connect Wallet
              </button>
            ) : (
              <>
                {chain.unsupported && (
                  <button
                    type="button" data-testid="rk-wrong-network-button" onClick={switchToBase} disabled={isPending}
                    title="iAERO runs on Base: switch your wallet to Base" className={`${BUTTON} gap-1.5 bg-[#FF494A] px-3 text-white`}
                  >
                    {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
                    Wrong network
                  </button>
                )}
                <button
                  type="button" data-testid="rk-account-button" onClick={chain.unsupported ? openChainModal : openAccountModal}
                  title={chain.unsupported ? 'Switch networks or disconnect' : undefined}
                  className={`${BUTTON} gap-1.5 border-2 border-white bg-white px-2 text-[#25292E]`}
                >
                  <Avatar address={account.address} imageUrl={account.ensAvatar} />
                  {account.displayName}
                  <Chevron />
                </button>
              </>
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
