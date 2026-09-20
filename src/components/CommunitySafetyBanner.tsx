import { ShieldAlert } from 'lucide-react';
import { OFFICIAL_DISCORD_URL } from '@/lib/community';

export default function CommunitySafetyBanner() {
  return (
    <aside
      aria-label="Scam warning"
      className="relative z-20 border-b border-amber-400/40 bg-amber-950 text-amber-50"
    >
      <div className="mx-auto flex w-full max-w-[1600px] items-start gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <ShieldAlert
          aria-hidden="true"
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-300"
        />
        <p className="text-[0.875rem] leading-6 sm:text-[0.9375rem]">
          <strong className="font-semibold">iAERO has no Telegram group.</strong>{' '}
          Our only official community is on{' '}
          <a
            href={OFFICIAL_DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm font-semibold text-white underline decoration-amber-300 underline-offset-4 hover:text-amber-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200"
          >
            Discord
          </a>
          . Any Telegram group claiming to be iAERO is a scam.
        </p>
      </div>
    </aside>
  );
}
