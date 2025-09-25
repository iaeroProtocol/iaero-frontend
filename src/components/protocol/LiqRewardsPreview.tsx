// components/LiqRewardsPreview.tsx
import { useState, useEffect } from 'react';
import { useVault } from '../contracts/hooks/useVault';

export const LiqRewardsPreview: React.FC<{ aeroAmount: string }> = ({ aeroAmount }) => {
  const { calculateLiqRewards } = useVault();
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    if (!aeroAmount || parseFloat(aeroAmount) <= 0) {
      setPreview(null);
      return;
    }
    
    const fetchPreview = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await calculateLiqRewards(aeroAmount);
        setPreview(result);
        
        // Warn if approaching halving
        const untilHalving = parseFloat(result.nextHalvingIn);
        const userGets = parseFloat(result.liqToUser);
        
        if (userGets > untilHalving * 0.9) {
          setError("⚠️ Your deposit may trigger a halving, reducing rewards by 50%");
        } else if (userGets > untilHalving * 0.5) {
          setError("ℹ️ Approaching next halving threshold");
        }
      } catch (err) {
        setError("Failed to calculate preview");
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    
    // Debounce the preview
    const timer = setTimeout(fetchPreview, 300);
    return () => clearTimeout(timer);
  }, [aeroAmount, calculateLiqRewards]);
  
  if (!aeroAmount || loading) return null;
  
  return (
    <div className="preview-box">
      {preview && (
        <>
          <div className="preview-row">
            <span>You will receive:</span>
            <strong>{parseFloat(preview.liqToUser).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            })} LIQ</strong>
          </div>
          <div className="preview-row">
            <span>Current rate:</span>
            <span>{preview.effectiveRate} LIQ per iAERO</span>
          </div>
          <div className="preview-row">
            <span>Until next halving:</span>
            <span>
              {parseFloat(preview.nextHalvingIn).toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0
              })} LIQ
            </span>
          </div>
          {error && <div className="preview-warning">{error}</div>}
        </>
      )}
    </div>
  );
};
