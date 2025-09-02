// src/lib/defi-utils.ts
import { ethers } from 'ethers';
import { useEffect, useState, useRef, useCallback } from 'react';

// ============================================
// BIGNUMBER UTILITIES
// ============================================

/**
 * Safely parse user input to BigInt
 * Handles edge cases like ".", "0.", empty strings
 */
export const parseInputToBigNumber = (
    input: string,
    decimals: number = 18
  ): bigint => {
    if (!input) return 0n;

    try {
      // strip commas/spaces then sanitize (handles multiple dots, leading dot, etc.)
      let clean = input.replace(/,/g, "").trim();
      clean = sanitizeDecimalInput(clean);

      if (!clean) return 0n;

      // If user leaves a trailing dot, make it parseable (e.g. "1." -> "1.0")
      if (clean.endsWith(".")) clean += "0";

      return ethers.parseUnits(clean, decimals);
    } catch (error) {
      console.warn("Failed to parse input to BigInt:", input, error);
      return 0n;
    }
  };

  // --- replace sanitizeDecimalInput with this version ---
  export const sanitizeDecimalInput = (value: string): string => {
    if (!value) return "";

    // Keep only digits and a dot
    let sanitized = value.replace(/[^0-9.]/g, "");

    // Collapse multiple dots into a single dot by joining the tail
    const parts1 = sanitized.split(".");
    if (parts1.length > 2) {
      sanitized = parts1[0] + "." + parts1.slice(1).join("");
    }

    // Prevent leading dot
    if (sanitized.startsWith(".")) {
      sanitized = "0" + sanitized;
    }

    // Recompute parts AFTER mutations and clamp decimals to 18
    const parts2 = sanitized.split(".");
    if (parts2.length === 2 && parts2[1].length > 18) {
      sanitized = parts2[0] + "." + parts2[1].slice(0, 18);
    }

    return sanitized;
  };

/**
 * Format BigInt for display with proper decimals
 */
export const formatBigNumber = (
  value: bigint,
  decimals: number = 18,
  displayDecimals: number = 2,
  compact: boolean = false
): string => {
  const formatted = ethers.formatUnits(value, decimals);
  const num = parseFloat(formatted);
  
  if (num === 0) return '0';
  if (num < 0.01 && num > 0) return '< 0.01';
  
  if (compact) {
    if (num < 1000) return num.toFixed(displayDecimals);
    if (num < 1000000) return `${(num / 1000).toFixed(1)}K`;
    if (num < 1000000000) return `${(num / 1000000).toFixed(2)}M`;
    return `${(num / 1000000000).toFixed(2)}B`;
  }
  
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: displayDecimals
  });
};

/**
 * Compare two BigInts safely
 */
export const compareBigNumbers = (
  a: bigint,
  b: bigint
): -1 | 0 | 1 => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/**
 * Calculate percentage of BigInt
 */
export const calculatePercentage = (
  value: bigint,
  percentage: number,
  decimals: number = 18
): bigint => {
  // Convert percentage to basis points (e.g., 5.5% = 550)
  const basisPoints = BigInt(Math.floor(percentage * 100));
  return (value * basisPoints) / 10000n;
};

// ============================================
// INPUT SANITIZATION
// ============================================

/**
 * Sanitize integer input (for voting, etc.)
 */
export const sanitizeIntegerInput = (value: string, min: number = 0, max: number = 100): string => {
  // Remove non-numeric characters
  let sanitized = value.replace(/[^0-9]/g, '');
  
  // Parse and clamp
  if (sanitized === '') return '';
  
  const num = parseInt(sanitized, 10);
  if (isNaN(num)) return '';
  
  const clamped = Math.max(min, Math.min(max, num));
  return clamped.toString();
};

// ============================================
// HOOKS
// ============================================

/**
 * Debounce hook for values
 */
export const useDebounce = <T>(value: T, delay: number): T => {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
};

/**
 * Format token amount with proper decimal handling
 */
export const formatTokenAmount = (
  amount: string | bigint,
  decimals: number = 18,
  displayDecimals: number = 2
): string => {
  if (typeof amount === 'string') {
    const bn = parseInputToBigNumber(amount, decimals);
    return formatBigNumber(bn, decimals, displayDecimals);
  }
  return formatBigNumber(amount, decimals, displayDecimals);
};

/**
 * Calculate USD value from token amount
 */
export const calculateUSDValue = (
  amount: bigint,
  price: number,
  decimals: number = 18
): string => {
  const tokenAmount = parseFloat(ethers.formatUnits(amount, decimals));
  const usdValue = tokenAmount * price;
  
  if (usdValue === 0) return '$0';
  if (usdValue < 0.01) return '< $0.01';
  
  return `$${usdValue.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
};

/**
 * Validate Ethereum address
 */
export const isValidAddress = (address: string): boolean => {
  try {
    ethers.getAddress(address);
    return true;
  } catch {
    return false;
  }
};

/**
 * Calculate slippage-adjusted amount
 */
export const calculateSlippageAmount = (
  amount: bigint,
  slippagePercent: number = 0.5,
  isMin: boolean = true
): bigint => {
  const slippageBasisPoints = BigInt(Math.floor(slippagePercent * 100));
  const slippageAmount = (amount * slippageBasisPoints) / 10000n;
  
  return isMin 
    ? amount - slippageAmount // Minimum received
    : amount + slippageAmount; // Maximum sent
};

/**
 * Validate token amount input
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
    amount = parseInputToBigNumber(input, decimals);
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
    const minFormatted = formatBigNumber(minAmount, decimals, 4);
    return { valid: false, error: `Minimum amount is ${minFormatted}` };
  }

  return { valid: true, amount };
};

// Export all utilities as a namespace for convenience
export const DeFiUtils = {
  // BigNumber
  parseInputToBigNumber,
  formatBigNumber,
  compareBigNumbers,
  calculatePercentage,
  
  // Input
  sanitizeDecimalInput,
  sanitizeIntegerInput,
  
  // Formatting
  formatTokenAmount,
  calculateUSDValue,
  
  // Validation
  isValidAddress,
  validateTokenAmount,
  
  // Calculations
  calculateSlippageAmount,
};

export const calculateYield = (
    principal: bigint,
    apr: number,
    days: number,
    decimals: number = 18
  ): bigint => {
    // APR is a percentage (e.g., 10 for 10%)
    // Calculate daily yield: principal * (apr/100) * (days/365)
    // To maintain precision, multiply first then divide
    
    // Convert APR to basis points for better precision (10% = 1000 BP)
    const aprBasisPoints = BigInt(Math.floor(apr * 100));
    
    // Calculate: principal * aprBasisPoints * days / (10000 * 365)
    const numerator = principal * aprBasisPoints * BigInt(days);
    const denominator = 10000n * 365n;
    
    return numerator / denominator;
  };
