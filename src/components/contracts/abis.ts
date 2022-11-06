// src/contracts/abis.ts

import VaultArtifact from "./abi-json/PermalockVault.sol/PermalockVault.json";
import DistributorArtifact from "./abi-json/StakingDistributor.sol/StakingDistributor.json";
import LIQDistributorArtifact from "./abi-json/LIQStakingDistributor.sol/LIQStakingDistributor.json";
import HarvesterArtifact from "./abi-json/RewardsHarvester.sol/RewardsHarvester.json";
import VotingManagerArtifact from "./abi-json/VotingManager.sol/VotingManager.json";
import IAEROArtifact from "./abi-json/iAEROToken.sol/iAEROToken.json";
import LIQArtifact from "./abi-json/LIQToken.sol/LIQToken.json";
import VeAEROArtifact from "./abi-json/veAERO.sol/VeAERO.json";
import VOTERArtifact from "./abi-json/VOTER.sol/VOTER.json";
import RouterArtifact from "./abi-json/Router.sol/Router.json";
import TreasuryDistributorArtifact from "./abi-json/TreasuryDistributor.sol/TreasuryDistributor.json";
import StiAEROArtifact from "./abi-json/StiAERO.sol/StiAERO.json";
import EpochStakingDistributorArtifact from "./abi-json/EpochStakingDistributor.sol/EpochStakingDistributor.json";
import PoolFactoryArtifact from "./abi-json/PoolFactory.sol/PoolFactory.json";

// If you don't have a dedicated IERC20 artifact in out/, use the minimal ERC20 ABI below.
// import IERC20Artifact from "../../../../out/IERC20.sol/IERC20.json";

// Minimal ERC20 ABI (approve/allowance/balanceOf/decimals/symbol/name/transfer/transferFrom)
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

// IMPORTANT: Keys here should EXACTLY match the names you use in getContractAddress(...) / ContractName
export const ABIS = {
  // Core protocol
  PermalockVault: VaultArtifact.abi,
  StakingDistributor: DistributorArtifact.abi,
  LIQStakingDistributor: LIQDistributorArtifact.abi,
  RewardsHarvester: HarvesterArtifact.abi,
  VotingManager: VotingManagerArtifact.abi,
  EpochStakingDistributor: EpochStakingDistributorArtifact.abi,

  // Tokens
  iAERO: IAEROArtifact.abi,
  LIQ: LIQArtifact.abi,
  AERO: ERC20_ABI, // safer generic ERC20 (use a specific artifact only if you rely on custom funcs)
  stiAERO: StiAEROArtifact.abi,

  // ve/Voter/DEX infra
  VeAERO: (VeAEROArtifact as any).abi ?? VeAEROArtifact,  // supports either {abi:[...]} or raw array
  MockVeAERO: VeAEROArtifact.abi,
  VOTER: VOTERArtifact.abi,
  MockVoter: VOTERArtifact.abi,
  Router: RouterArtifact.abi,
  PoolFactory: PoolFactoryArtifact.abi,
  TreasuryDistributor: TreasuryDistributorArtifact.abi,

  // Generic
  ERC20: ERC20_ABI,
} as const;

export type AbiMap = typeof ABIS;
