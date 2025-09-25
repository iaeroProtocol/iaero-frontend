// src/components/protocol/RewardsDisplay.tsx
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Gift, Loader2, Coins } from 'lucide-react';
import { useRewardTokens } from '@/components/contracts/hooks/useRewardTokens';
import { useStaking } from '@/components/contracts/hooks/useStaking';
import { useProtocol } from '@/components/contexts/ProtocolContext';

interface RewardsDisplayProps {
  showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;
  formatNumber: (value: string | number) => string;
}

export default function RewardsDisplay({ showToast, formatNumber }: RewardsDisplayProps) {
  const { connected, networkSupported, dispatch } = useProtocol();
  const { rewardTokens, loading: loadingRewards, refresh } = useRewardTokens();
  const { claimAllRewards } = useStaking();
  const [claiming, setClaiming] = React.useState(false);

  // Calculate total USD value
  const totalValueUSD = React.useMemo(() => {
    return rewardTokens.reduce((sum, token) => sum + (token.valueUSD || 0), 0);
  }, [rewardTokens]);

  // Filter tokens with pending rewards
  const tokensWithRewards = React.useMemo(() => {
    return rewardTokens.filter(token => parseFloat(token.pendingAmount) > 0);
  }, [rewardTokens]);

  const handleClaimAll = async () => {
    if (!connected || !networkSupported) return;
    
    const txId = 'claimAllRewards';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    setClaiming(true);
    
    try {
      showToast('Claiming all rewards...', 'info');
      
      await claimAllRewards(
        async (receipt: any) => {
          showToast(`Successfully claimed all rewards!`, 'success');
          await refresh();
        },
        (error: any) => {
          const msg = error?.message || 'Failed to claim rewards';
          showToast(msg, 'error');
        },
        (progress: string) => {
          console.log('Claim progress:', progress);
        }
      );
    } catch (error: any) {
      console.error('Claim error:', error);
      showToast(error?.message || 'Failed to claim rewards', 'error');
    } finally {
      setClaiming(false);
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  };

  if (!connected || !networkSupported) {
    return null;
  }

  return (
    <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-white flex items-center space-x-2">
            <Gift className="w-5 h-5 text-yellow-400" />
            <span>Pending Rewards</span>
          </CardTitle>
          <Button
            onClick={refresh}
            variant="ghost"
            size="sm"
            disabled={loadingRewards}
            className="text-slate-400 hover:text-white"
          >
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadingRewards ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        ) : tokensWithRewards.length === 0 ? (
          <div className="text-center py-8">
            <Coins className="w-12 h-12 text-slate-500 mx-auto mb-3" />
            <p className="text-slate-400">No pending rewards</p>
            <p className="text-slate-500 text-sm mt-1">Stake iAERO to earn rewards</p>
          </div>
        ) : (
          <>
            {/* Total Value */}
            <div className="bg-gradient-to-r from-yellow-900/20 to-amber-900/20 rounded-lg p-4 border border-yellow-700/30">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm text-slate-400">Total Claimable Value</p>
                  <p className="text-2xl font-bold text-white">
                    ${formatNumber(totalValueUSD)}
                  </p>
                </div>
                <Button
                  onClick={handleClaimAll}
                  disabled={claiming || tokensWithRewards.length === 0}
                  className="bg-gradient-to-r from-yellow-600 to-amber-600 hover:from-yellow-700 hover:to-amber-700"
                >
                  {claiming ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      Claiming...
                    </>
                  ) : (
                    <>
                      <Gift className="w-4 h-4 mr-2" />
                      Claim All ({tokensWithRewards.length} tokens)
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* Individual Tokens */}
            <div className="space-y-2">
              <p className="text-sm text-slate-400 mb-2">Breakdown by token:</p>
              {tokensWithRewards.map((token) => (
                <div
                  key={token.address}
                  className="flex items-center justify-between bg-slate-900/50 rounded-lg p-3 border border-slate-700/30"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 bg-slate-700 rounded-full flex items-center justify-center">
                      <span className="text-xs font-bold text-white">
                        {token.symbol.slice(0, 2)}
                      </span>
                    </div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-white font-medium">{token.symbol}</span>
                        {token.valueUSD === 0 && (
                          <Badge variant="outline" className="text-xs border-slate-600 text-slate-400">
                            No price
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-slate-500">
                        {token.pendingAmount} {token.symbol}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-white font-medium">
                      ${formatNumber(token.valueUSD)}
                    </p>
                    {token.balance && parseFloat(token.balance) > 0 && (
                      <p className="text-xs text-slate-500">
                        Balance: {formatNumber(parseFloat(token.balance))}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Info */}
            <div className="bg-slate-700/30 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-blue-400 mt-0.5" />
                <div className="text-xs text-slate-400">
                  <p>Claims include rewards from the previous and current epochs.</p>
                  <p className="mt-1">Rewards are distributed weekly based on protocol fees.</p>
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}