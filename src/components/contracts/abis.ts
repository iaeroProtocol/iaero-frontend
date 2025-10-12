// src/contracts/abis.ts
import type { Abi } from 'viem';

import VaultArtifact from "./abi-json/PermalockVault.sol/PermalockVault.json";
import LIQDistributorArtifact from "./abi-json/LIQStakingDistributor.sol/LIQStakingDistributor.json";
import HarvesterArtifact from "./abi-json/RewardsHarvester.sol/RewardsHarvester.json";
import VotingManagerArtifact from "./abi-json/VotingManager.sol/VotingManager.json";
import IAEROArtifact from "./abi-json/iAEROToken.sol/iAEROToken.json";
import LIQArtifact from "./abi-json/LIQToken.sol/LIQToken.json";
import VeAEROArtifact from "./abi-json/veAERO.sol/VeAERO.json";
import VOTERArtifact from "./abi-json/VOTER.sol/VOTER.json";
import RouterArtifact from "./abi-json/Router.sol/Router.json";
import TreasuryDistributorArtifact from "./abi-json/TreasuryDistributor.sol/TreasuryDistributor.json";
import PoolFactoryArtifact from "./abi-json/PoolFactory.sol/PoolFactory.json";
import StiAEROArtifact from "./abi-json/StiAERO.sol/StiAERO.json";
import EpochStakingDistributorArtifact from "./abi-json/EpochStakingDistributor.sol/EpochStakingDistributor.json";

// -------- Minimal ERC20 --------
export const ERC20_ABI = [
  { "inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}], "name":"approve", "outputs":[{"type":"bool"}], "stateMutability":"nonpayable", "type":"function" },
  { "inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}], "name":"allowance", "outputs":[{"type":"uint256"}], "stateMutability":"view", "type":"function" },
  { "inputs":[{"name":"account","type":"address"}], "name":"balanceOf", "outputs":[{"type":"uint256"}], "stateMutability":"view", "type":"function" },
  { "inputs":[], "name":"decimals", "outputs":[{"type":"uint8"}], "stateMutability":"view", "type":"function" },
  { "inputs":[], "name":"symbol", "outputs":[{"type":"string"}], "stateMutability":"view", "type":"function" },
  { "inputs":[], "name":"name", "outputs":[{"type":"string"}], "stateMutability":"view", "type":"function" },
  { "inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}], "name":"transfer", "outputs":[{"type":"bool"}], "stateMutability":"nonpayable", "type":"function" },
  { "inputs":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"amount","type":"uint256"}], "name":"transferFrom", "outputs":[{"type":"bool"}], "stateMutability":"nonpayable", "type":"function" }
] as const;

// -------- Typed ABI constants (compile-time only; no runtime change) --------
export const PermalockVault          = VaultArtifact.abi as const satisfies Abi;
export const LIQStakingDistributor   = LIQDistributorArtifact.abi as const satisfies Abi;
export const RewardsHarvester        = HarvesterArtifact.abi as const satisfies Abi;
export const VotingManager           = VotingManagerArtifact.abi as const satisfies Abi;
export const iAERO                   = IAEROArtifact.abi as const satisfies Abi;
export const LIQ                     = LIQArtifact.abi as const satisfies Abi;
export const VeAERO                  = (VeAEROArtifact as any).abi
  ? ((VeAEROArtifact as any).abi as const satisfies Abi)
  : (VeAEROArtifact as unknown as Abi);
export const VOTER                   = VOTERArtifact.abi as const satisfies Abi;
export const Router                  = RouterArtifact.abi as const satisfies Abi;
export const TreasuryDistributor     = TreasuryDistributorArtifact.abi as const satisfies Abi;
export const PoolFactory             = PoolFactoryArtifact.abi as const satisfies Abi;
export const stiAERO                 = StiAEROArtifact.abi as const satisfies Abi;
export const EpochStakingDistributor = EpochStakingDistributorArtifact.abi as const satisfies Abi;

// -------- Public map used across the app --------
// IMPORTANT: Keys must match names used in getContractAddress(...)
export const ABIS = {
  // Core protocol
  PermalockVault,
  StakingDistributor: EpochStakingDistributor, // alias
  LIQStakingDistributor,
  RewardsHarvester,
  VotingManager,

  // New Epoch-based contracts
  EpochStakingDistributor,
  stiAERO,

  // Tokens
  iAERO,
  LIQ,
  AERO: ERC20_ABI, // generic ERC20

  // ve/Voter/DEX infra
  VeAERO,
  MockVeAERO: VeAERO,
  VOTER,
  MockVoter: VOTER,
  Router,
  PoolFactory,
  TreasuryDistributor,

  // Generic
  ERC20: ERC20_ABI,

  // App-specific helper ABI (ok to leave as-is)
  RewardsSugar: [
    {
      "inputs": [
        { "internalType": "uint256", "name": "limit",  "type": "uint256" },
        { "internalType": "uint256", "name": "offset", "type": "uint256" }
      ],
      "name": "epochsLatest",
      "outputs": [{
        "components": [
          { "internalType": "uint256", "name": "epochStart", "type": "uint256" },
          { "internalType": "uint256", "name": "epochEnd",   "type": "uint256" },
          {
            "components": [
              { "internalType": "address", "name": "token",  "type": "address" },
              { "internalType": "uint256", "name": "amount", "type": "uint256" }
            ],
            "internalType": "struct TokenAmount[]",
            "name": "bribes",
            "type": "tuple[]"
          },
          {
            "components": [
              { "internalType": "address", "name": "token",  "type": "address" },
              { "internalType": "uint256", "name": "amount", "type": "uint256" }
            ],
            "internalType": "struct TokenAmount[]",
            "name": "fees",
            "type": "tuple[]"
          }
        ],
        "internalType": "struct EpochRow[]",
        "name": "",
        "type": "tuple[]"
      }],
      "stateMutability": "view",
      "type": "function"
    }
  ],
} as const;

export type AbiMap = typeof ABIS;
