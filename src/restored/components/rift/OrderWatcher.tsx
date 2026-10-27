// src/components/rift/OrderWatcher.tsx
//
// Tracks every unfinished Get iAERO order in this browser in the background (watch.ts), on every tab of the
// page. Kept separate from the Get iAERO section, which loads only when that tab is first opened, so that an
// error there cannot stop tracking and other visitors do not download it.

'use client';

import { useStoredOrders } from '@/lib/rift/storage';
import { useOrderWatcher } from '@/lib/rift/watch';

export default function OrderWatcher({ showToast }: { showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void }) {
  const orders = useStoredOrders();
  useOrderWatcher(orders, showToast);
  return null;
}
