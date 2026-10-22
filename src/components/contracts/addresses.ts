// src/contracts/addresses.ts

export type SupportedChainId = 84532 | 8453; // Base Sepolia | Base Mainnet

export type ContractName =
  | "PermalockVault"
  | "VotingManager"
  | "VOTER"
  | "iAERO"
  | "LIQ"
  | "LIQStakingDistributor" 
  | "LIQLinearVester"
  | "StakingDistributor"
  | "RewardsHarvester"
  | "AERO"
  | "MockVeAERO"
  | "PoolFactory"
  | "TreasuryDistributor"
  | "MultiSig"
  | "Router"
  | "VeAERO"
  | "MockVoter"
  | "treasury"
  | "stiAERO"
  | "EpochStakingDistributor"
  | "AutoUSDCVault"
  | "WETH"
  | "USDC"
  | "USDbC" 
  | "cbETH"   
  | "cbBTC" 
  | "RewardsSugar"
  // Aero (live since 2026-10-22) and the retired Aerodrome token the legacy vault still takes
  | "AERO_LEGACY"
  | "AeroVoter"
  | "AeroVotingEscrow"
  | "AeroFactoryRegistry"
  | "AeroVolatilePoolFactory"
  | "AeroStablePoolFactory"
  | "AeroCLFactory"
  | "AeroMetarouter"
  | "iAERO_AERO_Pool"
  | "iAERO_AERO_CLPool"
  | "LIQ_USDC_Pool"
  | "AERO_USDC_Pool";

export type Address = `0x${string}`;

export type NetworkAddresses = Partial<Record<ContractName, Address>>;

export const CONTRACTS: Record<SupportedChainId, NetworkAddresses> = {
  84532: {
    // Base Sepolia
    PermalockVault: "0xA06168b01c77415E6F71c5Da326240f3f8fA692e",
    VotingManager: "0xB8bf18F116c58faBaBCc4E2456e647B79B2F4752",
    iAERO: "0x85346ac7a7ADF371DA8369BF91c99d09550bE2b2",
    LIQ: "0x62a1F9CcF4E0de0898B97bE9a80Fd1CDa0Cad453",
    LIQStakingDistributor: "0x99200E8fAd87e60f004227df9eDcf3Cedc8a0408",
    StakingDistributor: "0xFA33380C97E1267161686b4F25C1c75d324Ce565",
    RewardsHarvester: "0xb1d7848984715cF8cA64808210B67640EFce2b4c",
    AERO: "0xedB772Cf675D080BDfe96Fc519AA82dcd9887a79",
    MockVeAERO: "0xeE76a1030a36850d3b2B0A61D9124eFb04c9E5eC",
    MockVoter: "0xf7DD8d324ac01282721ef0d13a264e3683018F9a",
    treasury: "0x7cBF6aAaF0aB3E85FAA498f9CAad90fd859d9561",
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  8453: {
    // Aero: AERO token, contracts and the pools iAERO/LIQ moved to on 2026-10-22
    AERO: "0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee",
    AeroVoter: "0x49d7d4f17Ec56Ef8fA04E464AF5D1A4942CC31e6",
    AeroVotingEscrow: "0xBF7977E1521e9a3032bf7243Ee4712f311f13915",
    AeroFactoryRegistry: "0x7b2A2c12dC5Ea2a31455952a05031C3E4BB28F3E",
    AeroVolatilePoolFactory: "0x8E6a9FCd1d638CC760Ffba397605Fe3355dE76D2",
    AeroStablePoolFactory: "0x78589E876edcEbdce72ee3436ab3c9AD3a7cEF2D",
    AeroCLFactory: "0x9CB220581b91b0C83223012FE69688b92aD07a76",
    AeroMetarouter: "0x0fEf9e88A7b76BCDBF451780C6774FE32965Ee98",
    iAERO_AERO_Pool: "0x72Decb30DFE4F6Cf7Db3ba1D58411dDda5ed903b",
    iAERO_AERO_CLPool: "0x361D728c97E591Ef47A68CAe2DC5C8ef475608EB",
    LIQ_USDC_Pool: "0xE4553d8d7284192ab84346A9C9FFdb69dCE30C71",
    AERO_USDC_Pool: "0xF634058dC94e6BF8e828E27621320C423bC8B18E",
    // Aerodrome (retired 2026-10-22): the legacy PermalockVault still takes old AERO and veAERO NFTs
    AERO_LEGACY: "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
    VOTER: "0x16613524E02ad97EDfEF371Bc883F2F5D6c480A5",
    VeAERO: "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4",
    Router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    PoolFactory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
    iAERO: "0x81034Fb34009115F215f5d5F564AAc9FfA46a1Dc",
    MultiSig: "0x1039CB48254a3150fC604d4B9ea08F66f4739D37",
    LIQ: "0x7ee8964160126081cebC443a42482E95e393e6A8",
    PermalockVault: "0x180DAB53968e599Dd43CF431E27CB01AA5C37909",
    StakingDistributor: "0x781A80fA817b5a146C440F03EF8643f4aca6588A",
    RewardsHarvester: "0x77f90d2dDB15Ffe28fa322aDA351d11da3B8bFe5",
    VotingManager: "0xA0EBbdeD0E201a9C37F4Bffbb831CB8Db9FEd0B8",
    LIQStakingDistributor: "0xb81efc6be6622Bf4086566210a6aD134cd0CDdA4",
    LIQLinearVester: "0xF1d25F4ee64988Afad0f1612cc3d540725F319Db",
    TreasuryDistributor: "0xD36b84EeFd1F481a737595C8212c43A9cD76C8e0",
    stiAERO: "0x72C135B8eEBC57A3823f0920233e1A90FF4D683D",
    EpochStakingDistributor: "0x781A80fA817b5a146C440F03EF8643f4aca6588A",
    AutoUSDCVault: "0xFE5c929677D97723dc822C86c93c7e2D1B59c774",
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    RewardsSugar: "0xD4aD2EeeB3314d54212A92f4cBBE684195dEfe3E",

    // Base mainnet — fill in during mainnet deployment
  },
};

export interface NetworkConfig {
  chainId: string;  // Changed to string for hex format
  chainIdNumber: SupportedChainId;
  name: string;
  rpcUrl: string;
  blockExplorer: string;  // Changed from explorer
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

export const NETWORK_CONFIG: Record<SupportedChainId, NetworkConfig> = {
  84532: {
    chainId: "0x14a34",  // Hex format for MetaMask
    chainIdNumber: 84532,
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    blockExplorer: "https://sepolia.basescan.org",
    nativeCurrency: {
      name: "ETH",
      symbol: "ETH",
      decimals: 18,
    },
  },
  8453: {
    chainId: "0x2105",  // Hex format for MetaMask
    chainIdNumber: 8453,
    name: "Base",
    rpcUrl: "https://mainnet.base.org",
    blockExplorer: "https://basescan.org",
    nativeCurrency: {
      name: "ETH",
      symbol: "ETH",
      decimals: 18,
    },
  },
};

export function isSupportedNetwork(chainId?: number): chainId is SupportedChainId {
  return chainId === 84532 || chainId === 8453;
}

export function getNetworkConfig(chainId: number): NetworkConfig {
  if (!isSupportedNetwork(chainId)) {
    throw new Error(`Unsupported chainId: ${chainId}`);
  }
  return NETWORK_CONFIG[chainId];
}

// Add this function that ProtocolContext is trying to use
export function getContractAddress(
  name: ContractName,
  chainId: number
): Address {
  if (!isSupportedNetwork(chainId)) {
    throw new Error(`Unsupported chainId: ${chainId}`);
  }
  const addr = CONTRACTS[chainId][name];
  if (!addr) {
    throw new Error(`Address for "${name}" missing on chain ${chainId}`);
  }
  return addr;
}

// Keep the original getAddress for backward compatibility
export function getAddress(
  chainId: number,
  name: ContractName
): Address {
  return getContractAddress(name, chainId);
}

export function getExplorerTxUrl(chainId: number, txHash: string) {
  const { blockExplorer } = getNetworkConfig(chainId);
  return `${blockExplorer}/tx/${txHash}`;
}

export function getExplorerAddressUrl(chainId: number, address: string) {
  const { blockExplorer } = getNetworkConfig(chainId);
  return `${blockExplorer}/address/${address}`;
}