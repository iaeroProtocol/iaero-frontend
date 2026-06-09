// src/components/lib/ethereum.ts
import { getNetworkConfig, isSupportedNetwork, type SupportedChainId } from "../contracts/addresses";

// ============================================================================
// FORMATTING UTILITIES
// ============================================================================

/**
 * Format an Ethereum address for display
 * @example formatAddress("0x1234...5678") => "0x1234...5678"
 */
export const formatAddress = (address: string, chars = 4): string => {
  if (!address) return "";
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
};

/**
 * Format token amount for display
 * @param amount - Amount as string, bigint, or number
 * @param decimals - Token decimals (default 18)
 * @param displayDecimals - How many decimals to show (default 2)
 */
export const formatTokenAmount = (
  amount: string | bigint | number,
  decimals = 18,
  displayDecimals = 2
): string => {
  if (amount == null) return "0";
  
  let num: number;
  
  if (typeof amount === "bigint") {
    num = Number(amount) / Math.pow(10, decimals);
  } else if (typeof amount === "number") {
    num = amount;
  } else {
    // String input
    try {
      if (amount.includes('.')) {
        // Already formatted
        num = parseFloat(amount);
      } else {
        // Wei/raw amount
        num = Number(amount) / Math.pow(10, decimals);
      }
    } catch {
      return "0";
    }
  }
  
  if (num === 0) return "0";
  if (num < 0.01 && num > 0) return "< 0.01";
  
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: displayDecimals
  });
};

/**
 * Parse token amount from user input to bigint (wei)
 * @param amount - User input as string or number
 * @param decimals - Token decimals (default 18)
 */
export const parseTokenAmount = (amount: string | number | bigint, decimals = 18): bigint => {
  if (amount === "" || amount == null) return 0n;
  if (typeof amount === "bigint") return amount;
  
  try {
    const amountStr = String(amount);
    const [whole, fraction = ""] = amountStr.split(".");
    
    // Pad or trim fraction to match decimals
    const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
    
    // Combine whole and fraction parts
    const combined = whole + paddedFraction;
    return BigInt(combined);
  } catch (error) {
    console.warn("Failed to parse token amount:", amount, error);
    return 0n;
  }
};

// ============================================================================
// NETWORK UTILITIES
// ============================================================================

/**
 * Get network configuration by chain ID
 */
export { getNetworkConfig, isSupportedNetwork };

/**
 * Get block explorer transaction URL
 */
export const getExplorerTxUrl = (chainId: number, txHash: string): string => {
  const { blockExplorer } = getNetworkConfig(chainId);
  return `${blockExplorer}/tx/${txHash}`;
};

/**
 * Get block explorer address URL
 */
export const getExplorerAddressUrl = (chainId: number, address: string): string => {
  const { blockExplorer } = getNetworkConfig(chainId);
  return `${blockExplorer}/address/${address}`;
};

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Validate if a string is a valid Ethereum address
 */
export const isValidAddress = (address: string): boolean => {
  if (!address) return false;
  
  // Check if it's a valid hex string with correct length
  const validFormat = /^0x[0-9a-fA-F]{40}$/;
  if (!validFormat.test(address)) return false;
  
  // Optional: Add checksum validation if needed
  return true;
};

/**
 * Validate token amount against balance
 */
export const validateTokenAmount = (
  input: string,
  balance: bigint,
  decimals: number = 18,
  minAmount?: bigint
): {
  valid: boolean;
  error?: string;
  amount?: bigint;
} => {
  if (!input || input === '') {
    return { valid: false, error: 'Enter an amount' };
  }

  let amount: bigint;
  try {
    amount = parseTokenAmount(input, decimals);
  } catch {
    return { valid: false, error: 'Invalid amount' };
  }

  if (amount === 0n) {
    return { valid: false, error: 'Amount must be greater than 0' };
  }

  if (amount > balance) {
    return { valid: false, error: 'Insufficient balance' };
  }

  if (minAmount && amount < minAmount) {
    const minFormatted = formatTokenAmount(minAmount, decimals, 4);
    return { valid: false, error: `Minimum amount is ${minFormatted}` };
  }

  return { valid: true, amount };
};

// ============================================================================
// BIGINT UTILITIES
// ============================================================================

/**
 * Safely format bigint to decimal string
 */
export const formatBigInt = (value: bigint | undefined, decimals = 18): string => {
  if (!value) return "0";
  return (Number(value) / Math.pow(10, decimals)).toString();
};

/**
 * Compare two bigints
 */
export const compareBigInt = (a: bigint, b: bigint): -1 | 0 | 1 => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/**
 * Calculate percentage of bigint
 * @param value - The base value
 * @param percentage - Percentage as number (e.g., 5.5 for 5.5%)
 */
export const calculatePercentage = (value: bigint, percentage: number): bigint => {
  const basisPoints = BigInt(Math.floor(percentage * 100));
  return (value * basisPoints) / 10000n;
};

// ============================================================================
// FORMATTING CONSTANTS
// ============================================================================

/**
 * Common token decimals
 */
export const TOKEN_DECIMALS = {
  ETH: 18,
  WETH: 18,
  USDC: 6,
  USDT: 6,
  DAI: 18,
  AERO: 18,
  iAERO: 18,
  LIQ: 18,
} as const;

/**
 * Zero addresses for different purposes
 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Check if error is user rejection
 */
export const isUserRejection = (error: any): boolean => {
  return (
    error?.name === 'UserRejectedRequestError' ||
    error?.code === 4001 ||
    error?.code === 'ACTION_REJECTED' ||
    error?.message?.toLowerCase?.().includes('user rejected') ||
    error?.message?.toLowerCase?.().includes('user denied')
  );
};

/**
 * Extract user-friendly error message
 */
export const getErrorMessage = (error: any, fallback = "Transaction failed"): string => {
  if (isUserRejection(error)) {
    return "Transaction rejected by user";
  }
  
  const message = error?.message || error?.reason || "";
  const lowerMessage = message.toLowerCase();
  
  if (lowerMessage.includes("insufficient funds")) {
    return "Insufficient funds for transaction";
  }
  
  if (lowerMessage.includes("insufficient balance")) {
    return "Insufficient token balance";
  }
  
  if (lowerMessage.includes("execution reverted")) {
    // Try to extract revert reason
    const match = message.match(/execution reverted: (.+)/i);
    if (match) return match[1];
    return "Transaction would fail";
  }
  
  if (lowerMessage.includes("nonce")) {
    return "Transaction nonce issue - please try again";
  }
  
  if (lowerMessage.includes("gas")) {
    return "Gas estimation failed - transaction may fail";
  }
  
  // Return shortened message if available
  if (message && message.length < 100) {
    return message;
  }
  
  return fallback;
};

// ============================================================================
// LEGACY EXPORTS (for backwards compatibility during migration)
// ============================================================================

/**
 * @deprecated Use wagmi's usePublicClient instead
 * This is kept for backwards compatibility during migration
 */
export const getProvider = () => {
  console.warn('getProvider() is deprecated. Use wagmi usePublicClient() instead.');
  throw new Error('getProvider() removed - use wagmi hooks');
};

/**
 * @deprecated Use wagmi's useAccount and useWalletClient instead
 * This is kept for backwards compatibility during migration
 */
export const getSigner = () => {
  console.warn('getSigner() is deprecated. Use wagmi useWalletClient() instead.');
  throw new Error('getSigner() removed - use wagmi hooks');
};

/**
 * @deprecated Use RainbowKit's ConnectButton instead
 * This is kept for backwards compatibility during migration
 */
export const connectWallet = () => {
  console.warn('connectWallet() is deprecated. Use RainbowKit ConnectButton instead.');
  throw new Error('connectWallet() removed - use RainbowKit');
};

/**
 * @deprecated Use wagmi's useSwitchChain hook instead
 * This is kept for backwards compatibility during migration
 */
export const switchToNetwork = () => {
  console.warn('switchToNetwork() is deprecated. Use wagmi useSwitchChain instead.');
  throw new Error('switchToNetwork() removed - use wagmi hooks');
};

export const switchToBaseSepolia = switchToNetwork;
export const switchToBase = switchToNetwork;

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type { SupportedChainId };