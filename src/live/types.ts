import type {Address,EIP1193Provider,Hash} from 'viem';
import type {ActionKind,Activity,DemoWallet,RewardLeg} from '../domain';
import type {PendingTransaction} from '../protocol/pendingTransaction';
import type {SweepPreview,SweepResult,SweepHooks} from './sweep';
import type {RewardValuation} from './reward-value';
import type {TokenFilter} from './token-filter';
import type {ProtocolMarketMetrics} from '../../server/protocol-metrics';

export type WalletField=Exclude<keyof DemoWallet,'checkpoint'>;
export type WalletChoice={id:string;name:string;rdns:string;provider:EIP1193Provider};
export type LegacyReward=RewardLeg;
export type BaseRegistry={chainId:8453;network:string;explorer:string;legacy:Record<'iAERO'|'LIQ'|'USDC'|'WETH'|'epochDistributor'|'stiAERO'|'autoVault'|'harvester',Address>;aero:{token:Address;votingEscrow:Address;voter:Address;protocolNft:string};forwarder:Address;newStack:{status:string;svault:Address|null;streamingDistributor:Address|null;streamAutoVault:Address|null;rewardForwarder:Address|null;revenueConverter:Address|null};marketData:{liqUsdcPool:Address;liqCirculation:{treasurySourceVault:Address;vesting:Address;streamIds:string[]}};knownLegacyRewardTokens:{address:Address;symbol:string;decimals:number}[];sweep:SweepConfig;liqStaking?:{distributor:Address;source?:string}};
export type SweepConfig={swapper:Address;tokenRegistry:Address;metarouter:Address;aeroUsdcPool:Address;aeroIaeroPool:Address;aeroIaeroClPool:Address;metaquoter:Address;multicall3:Address;quoteEndpoint:string};
export type Bootstrap={readCoverage?:import('../protocol-data/read-coverage').ReadCoverage;rewardTokenAddresses?:Address[];rewardRegistryError?:string;tokenFilter?:TokenFilter;sweepReady?:boolean;marketRouteReady?:boolean;aeroCompoundReady?:boolean;registry:BaseRegistry;verifiedAt:string;snapshot:{block:string;hash:Hash;timestamp:number;independentProviders:number};contracts:Record<string,{address:Address;deployed:boolean;codeHash:Hash|null}>;legacyReady:boolean;legacyPaused?:boolean;oldAutoReady:boolean;newStack?:import('../../server/new-stack').NewStackConnection;liqStakingReady?:boolean;newStackReady:boolean;newStackReason:string;serviceErrors?:Record<string,string>;metrics:{liqStaking?:{totalStaked:string;paused:boolean};allocations?:{chainId:string;amount:string}[];market?:ProtocolMarketMetrics;backingAero?:string;permanent?:boolean;protocolNftOwner?:Address;legacyTotalStaked?:string}};
export type LiveState={
  boot?:Bootstrap;address?:Address;chainId?:number;walletName?:string;wallets:WalletChoice[];connecting:boolean;loading:boolean;
  error?:string;known:Partial<Record<WalletField,boolean>>;errors:string[];ethBalance?:bigint;legacyReceipts?:bigint;legacyPaused?:boolean;
  oldAutoShares?:bigint;oldAutoEarned?:bigint;oldAutoEpochs:bigint[];rewards:LegacyReward[];rewardReadErrors:number;rewardTokenCount?:number;
  selectedDate:string;customToken:string;rewardSelectionError?:string;pending:PendingTransaction|null;lastHash?:Hash;readAt?:number;progress?:string;confirmedHashes?:Hash[];
  liqPosition?:import('./liq').LiqPosition;newPosition?:import('./new-stack').NewPosition;rewardValuation?:RewardValuation;historyMode?:'recent'|'all';legacyDiscovery?:import('./legacy-history').LegacyDiscovery;
};
export type LiveControls={
  activeProvider:()=>EIP1193Provider|undefined;connectMobile:()=>Promise<void>;connectWallet:(id:string)=>Promise<void>;switchToBase:()=>Promise<void>;refresh:()=>Promise<void>;
  loadAllLegacy:()=>Promise<void>;loadLegacy:(date:string,customToken?:string)=>Promise<void>;reviewPending:(attest?:boolean)=>Promise<void>;
  approve:(kind:ActionKind,amount:bigint)=>Promise<void>;
  sweep:(preview:SweepPreview,hooks?:SweepHooks)=>Promise<SweepResult>;
  refreshRewardValues:()=>void;
};

export function emptyWallet():DemoWallet{return {aero:0n,iaero:0n,staked:0n,autoStaked:0n,usdc:0n,earned:0n,autoEarned:0n,legacyStake:0n,legacyRewards:0n,liq:0n,checkpoint:0};}
export function initialLiveState():LiveState{return {wallets:[],connecting:false,loading:false,known:{},errors:[],oldAutoEpochs:[],rewards:[],rewardReadErrors:0,selectedDate:'',customToken:'',pending:null};}
export function liveReason(kind:ActionKind,state:LiveState,connected:boolean):string|undefined{
  if(!state.boot)return 'Waiting for verified Base contract reads.';
  if(kind==='buy')return 'The market-buy route is not connected in this local contract-testing app.';
  if(['stake','unstake','claim','autoStake','autoUnstake','autoClaim','mint','nft','collateralWrap','collateralRedeem','collateralClaim'].includes(kind)&&!state.boot.newStackReady)return state.boot.newStackReason;
  if(!connected||!state.address)return 'Connect your wallet first.';
  if(state.chainId!==8453)return 'Switch your wallet to Base before continuing.';
  if(state.error)return 'Refresh Base contract data successfully before starting a transaction.';
  if(state.pending)return 'Resolve the pending wallet request before starting another.';
  if(kind==='legacyWithdraw'&&(!state.boot.legacyReady||state.legacyPaused!==false||!state.known.legacyStake||state.legacyReceipts===undefined))return 'The legacy principal or receipt checks are not available.';
  if((kind==='legacyClaim'||kind==='legacyClaimMany')&&(!state.boot.legacyReady||state.legacyPaused!==false))return 'The legacy reward contract is not available for claims.';
  if((kind==='oldAutoClaim'||kind==='oldAutoWithdraw')&&!state.boot.oldAutoReady)return 'The old AutoVault is not verified on Base.';
  if(['autoStake','autoUnstake','autoClaim'].includes(kind)&&!state.boot.newStack?.addresses?.streamAutoVault)return 'The replacement AutoVault has no verified deployment.';
  if(kind.startsWith('collateral')&&!state.boot.newStack?.addresses?.stakedCollateral)return 'The collateral wrapper has no verified deployment.';
  if(kind.startsWith('liq')&&!state.boot.liqStakingReady)return 'The LIQ staking contract and token link could not be verified.';
  if(kind==='oldAutoWithdraw'&&(!state.boot.legacyReady||state.legacyPaused!==false))return 'The underlying previous staking withdrawal route is paused or could not be read.';
}
