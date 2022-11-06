import { ethers } from "ethers";
import { getNetworkConfig, isSupportedNetwork } from "../contracts/addresses";

// ---- Types / globals -------------------------------------------------------

declare global {
  interface Window {
    ethereum?: any; // You can replace 'any' with ethers.Eip1193Provider if desired
  }
}

let cachedProvider: ethers.BrowserProvider | ethers.JsonRpcProvider | null = null;
let cachedSigner: ethers.Signer | null = null;

// ---- Provider / Signer helpers --------------------------------------------

/** Returns a cached provider. BrowserProvider if wallet present, otherwise RPC. */
export const getProvider = (chainId: number = 8453) => {
  // Client + wallet: prefer BrowserProvider
  if (typeof window !== "undefined" && window.ethereum) {
    if (!(cachedProvider instanceof ethers.BrowserProvider)) {
      cachedProvider = new ethers.BrowserProvider(window.ethereum);
    }
    return cachedProvider;
  }

  // SSR or no wallet: fall back to static RPC
  const cfg = getNetworkConfig(chainId);
  if (!(cachedProvider instanceof ethers.JsonRpcProvider)) {
    cachedProvider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  }
  return cachedProvider;
};

export const getSigner = async () => {
  const p = getProvider();
  if (!("getSigner" in p)) {
    throw new Error("No browser wallet available to obtain a signer");
  }
  if (!cachedSigner) {
    cachedSigner = await (p as ethers.BrowserProvider).getSigner();
  }
  return cachedSigner!;
};

// ---- Network switching -----------------------------------------------------

export const switchToNetwork = async (chainId: number) => {
  if (!window.ethereum) {
    throw new Error("No wallet detected");
  }

  const cfg = getNetworkConfig(chainId);
  const chainIdHex = cfg.chainId; // already hex in NETWORK_CONFIG

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (switchError: any) {
    // Chain not added yet
    if (switchError?.code === 4902 || switchError?.message?.includes("Unrecognized chain ID")) {
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: chainIdHex,
              chainName: cfg.name,
              nativeCurrency: cfg.nativeCurrency,
              rpcUrls: [cfg.rpcUrl],
              blockExplorerUrls: [cfg.blockExplorer],
            },
          ],
        });
      } catch (addError: any) {
        throw new Error(`Failed to add network: ${addError?.message || addError}`);
      }
    } else {
      throw new Error(`Failed to switch network: ${switchError?.message || switchError}`);
    }
  }
};

export const switchToBaseSepolia = () => switchToNetwork(84532);
export const switchToBase = () => switchToNetwork(8453);

// ---- Wallet connection -----------------------------------------------------

export const connectWallet = async () => {

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  
  if (!window.ethereum && isMobile) {
    // Redirect to MetaMask mobile browser
    const currentUrl = window.location.href;
    window.location.href = `https://metamask.app.link/dapp/${currentUrl.replace('https://', '')}`;
    return;
  }

  if (!window.ethereum) throw new Error('Please install MetaMask or another Web3 wallet');

  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (accounts.length === 0) throw new Error('No accounts found');

    // Check current network
    const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
    let chainId = parseInt(currentChainId, 16);

    // Auto-switch to Base mainnet if not on a supported network
    if (!isSupportedNetwork(chainId)) {
      const BASE_MAINNET_ID = 8453;
      
      try {
        // Try to switch to Base mainnet
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x2105' }], // 8453 in hex
        });
        chainId = BASE_MAINNET_ID;
      } catch (switchError: any) {
        if (switchError.code === 4902) {
          // Base not in wallet, add it
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0x2105',
              chainName: 'Base',
              nativeCurrency: {
                name: 'Ethereum',
                symbol: 'ETH',
                decimals: 18
              },
              rpcUrls: ['https://mainnet.base.org'],
              blockExplorerUrls: ['https://basescan.org']
            }],
          });
          chainId = BASE_MAINNET_ID;
        } else {
          throw new Error('Failed to switch to Base network');
        }
      }
    }

    return { account: accounts[0], chainId };
  } catch (error: any) {
    console.error('Connection error:', error);
    throw new Error(`Connection failed: ${error.message}`);
  }
};

// ---- Misc helpers ----------------------------------------------------------

export const getNetworkInfo = async () => {
  try {
    const prov = getProvider();
    const net = await prov.getNetwork();
    const chainId = Number(net.chainId);

    return {
      chainId,
      name: net.name,
      supported: isSupportedNetwork(chainId),
      config: isSupportedNetwork(chainId) ? getNetworkConfig(chainId) : null,
    };
  } catch {
    return { chainId: null, name: "Unknown", supported: false, config: null };
  }
};

export const formatAddress = (address: string, chars = 4) => {
  if (!address) return "";
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
};

export const formatTokenAmount = (
  amount: string | bigint | number,
  decimals = 18,
  displayDecimals = 2
) => {
  if (amount == null) return "0";
  const asBig = typeof amount === "bigint" ? amount : ethers.parseUnits(String(amount), decimals);
  const num = parseFloat(ethers.formatUnits(asBig, decimals));
  if (num === 0) return "0";
  if (num < 0.01) return "< 0.01";
  return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: displayDecimals });
};

export const parseTokenAmount = (amount: string | number | bigint, decimals = 18): bigint => {
  if (amount === "" || amount == null) return ethers.parseUnits("0", decimals);
  if (typeof amount === "bigint") return amount;
  return ethers.parseUnits(String(amount), decimals);
};

// ---- Wallet event listeners ------------------------------------------------

if (typeof window !== "undefined" && window.ethereum?.on) {
  window.ethereum.on("accountsChanged", (accounts: string[]) => {
    if (!accounts?.length) {
      // User disconnected wallet
      cachedProvider = null;
      cachedSigner = null;
    } else {
      // Switch account
      cachedSigner = null;
    }
  });

  window.ethereum.on("chainChanged", (_chainId: string) => {
    // Reset caches so new chain is respected everywhere
    cachedProvider = null;
    cachedSigner = null;

    // Optional, but keeps app state sane without complex global wiring
    window.location.reload();
  });
}
