'use client';

import { PauseCircle } from 'lucide-react';
import { OFFICIAL_DISCORD_URL } from '@/lib/community';
import { useVaultDepositsPaused } from '@/components/contracts/hooks/useVaultDepositsPaused';

/** Site-wide notice while the vault refuses deposits for the Aero migration. */
export default function VaultPauseBanner() {
  const paused = useVaultDepositsPaused();
  if (!paused) return null;
  return (
    <aside
      aria-label="Minting paused"
      className="relative z-20 border-b border-sky-400/40 bg-sky-950 text-sky-50"
    >
      <div className="mx-auto flex w-full max-w-[1600px] items-start gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <PauseCircle
          aria-hidden="true"
          className="mt-0.5 h-5 w-5 shrink-0 text-sky-300"
        />
        <p className="text-[0.875rem] leading-6 sm:text-[0.9375rem]">
          <strong className="font-semibold">Minting is paused for the Aero upgrade.</strong>{' '}
          New AERO and veAERO deposits are closed while iAERO moves to Aero. Holding, trading, staking and claiming
          work as normal. Updates on{' '}
          <a
            href={OFFICIAL_DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm font-semibold text-white underline decoration-sky-300 underline-offset-4 hover:text-sky-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-200"
          >
            Discord
          </a>
          .
        </p>
      </div>
    </aside>
  );
}
