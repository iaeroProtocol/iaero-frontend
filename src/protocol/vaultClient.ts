// [VERIFIED: SVault.sol deposit/_intakeSToken/aggregationStatus; upstream 0d75da9 VPM]
// Preview helpers live in the client; previewDeposit/vaultStatus are not SVault selectors.
import {encodeAbiParameters,parseAbi,type Address} from 'viem';
import type {SaeroAddresses} from './saeroAddresses';
import {STAKING_ERC20_ABI,walletSender,type ReadClient,type StakingWriter} from './streamingClient';

export const VAULT_ABI=parseAbi([
  'function AERO() view returns(address)', 'function iAERO() view returns(address)',
  'function escrow() view returns(address)', 'function voter() view returns(address)',
  'function owner() view returns(address)', 'function tokenId() view returns(uint256)',
  'function paused() view returns(bool)', 'function migrationFinalized() view returns(bool)',
  'function isCustodied() view returns(bool)', 'function depositsOpen() view returns(bool open,uint256 enabledAt)',
  'function MIN_DEPOSIT() view returns(uint256)', 'function MAX_SINGLE_DEPOSIT() view returns(uint256)',
  'function PROTOCOL_FEE_BPS() view returns(uint256)', 'function BPS() view returns(uint256)',
  'function aggregationStatus() view returns(bool vpmSet,bool vpmAuthorized,bool restricted,bool registered,uint128 ratePips)',
  'function deposit(uint256)',
]);
export const INTAKE_ESCROW_ABI=parseAbi([
  'function ownerOf(uint256) view returns(address)',
  'function staked(uint256) view returns((uint128 amount,uint48 end,bool isPermanent))',
  'function safeTransferFrom(address,address,uint256,bytes)',
]);
const VOTER_ABI=parseAbi(['function allocationChainAmounts(uint256,uint256) view returns(uint128)']);
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export type VaultSnapshot={
  block:bigint;timestamp:number;aero:Address;escrow:Address;voter:Address;owner:Address;tokenId:bigint;
  paused:boolean;finalized:boolean;custodied:boolean;tokenTransfersOpen:boolean;enabledAt:number;
  minDeposit:bigint;maxDeposit:bigint;feeBps:bigint;bps:bigint;
  aggregation?:{set:boolean;authorized:boolean;restricted:boolean;registered:boolean;ratePips:bigint};
};
export type StokenQuote={snapshot:VaultSnapshot;tokenId:bigint;gross:bigint;netBacking:bigint;vpmFee:bigint;protocolFee:bigint;iAeroOut:bigint};

export async function readVault(client:ReadClient,c:SaeroAddresses):Promise<VaultSnapshot>{
  if(await client.getChainId()!==c.chainId)throw Error('Wrong network.');
  const block=await client.getBlock();
  const read=(functionName:string)=>client.readContract({address:c.svault,abi:VAULT_ABI,functionName,blockNumber:block.number});
  const [aero,iaero,escrow,voter,owner,tokenId,paused,finalized,custodied,gate,minDeposit,maxDeposit,feeBps,bps,aggregation]=await Promise.all([
    ...['AERO','iAERO','escrow','voter','owner','tokenId','paused','migrationFinalized','isCustodied','depositsOpen','MIN_DEPOSIT','MAX_SINGLE_DEPOSIT','PROTOCOL_FEE_BPS','BPS'].map(read),
    read('aggregationStatus').catch(()=>undefined),
  ]);
  if(!same(iaero,c.iAERO))throw Error('The vault does not mint the configured iAERO token.');
  if(bps<=0n||feeBps<0n||feeBps>=bps||minDeposit<=0n||maxDeposit<minDeposit)throw Error('Invalid vault limits.');
  return {block:block.number,timestamp:Number(block.timestamp),aero,escrow,voter,owner,tokenId,paused,finalized,custodied,
    tokenTransfersOpen:gate[0],enabledAt:Number(gate[1]),minDeposit,maxDeposit,feeBps,bps,
    aggregation:aggregation?{set:aggregation[0],authorized:aggregation[1],restricted:aggregation[2],registered:aggregation[3],ratePips:aggregation[4]}:undefined};
}
export function previewDeposit(s:VaultSnapshot,amount:bigint){
  if(amount<s.minDeposit||amount>s.maxDeposit)throw Error('Amount is outside the vault deposit limits.');
  const fee=amount*s.feeBps/s.bps;return {gross:amount,protocolFee:fee,iAeroOut:amount-fee};
}
export function depositClosedReason(s:VaultSnapshot):string|undefined {
  if(!s.finalized||!s.custodied)return 'Deposits become available after the vault migration is finalized in custody.';
  if(s.paused)return 'New deposits are paused.';
  if(!s.tokenTransfersOpen)return s.enabledAt>0?`AERO deposits open at ${new Date(s.enabledAt*1000).toISOString()}.`:'AERO deposits are temporarily unavailable.';
}
export function requireIntake(s:VaultSnapshot){
  if(!s.finalized||!s.custodied)throw Error('The vault migration is not finalized in custody.');
  if(s.paused)throw Error('New deposits are paused.');
}
export async function quoteStoken(client:ReadClient,c:SaeroAddresses,user:Address,tokenId:bigint):Promise<StokenQuote>{
  if(tokenId<=0n||tokenId>=2n**256n)throw Error('Enter a valid NFT ID.');
  const s=await readVault(client,c);requireIntake(s);
  if(same(user,s.owner))throw Error('Protocol backing returns use the owner migration runbook.');
  if(tokenId===s.tokenId)throw Error('The aggregate NFT cannot be deposited.');
  const a=s.aggregation;
  if(!a?.set||!a.authorized||(a.restricted&&!a.registered)||a.ratePips<0n||a.ratePips>=1_000_000n)throw Error('sAERO NFT deposits are not currently available.');
  const [owner,stake,idle]=await Promise.all([
    client.readContract({address:s.escrow,abi:INTAKE_ESCROW_ABI,functionName:'ownerOf',args:[tokenId],blockNumber:s.block}),
    client.readContract({address:s.escrow,abi:INTAKE_ESCROW_ABI,functionName:'staked',args:[tokenId],blockNumber:s.block}),
    client.readContract({address:s.voter,abi:VOTER_ABI,functionName:'allocationChainAmounts',args:[tokenId,0n],blockNumber:s.block}),
  ]);
  if(!same(owner,user))throw Error('This wallet does not own the sAERO NFT.');
  if(!stake.isPermanent&&Number(stake.end)<=s.timestamp)throw Error('This sAERO stake has expired.');
  const gross=BigInt(stake.amount);previewDeposit(s,gross);
  if(idle<gross)throw Error('Remove the NFT’s voting allocations on Aero before depositing it.');
  const vpmFee=gross*a.ratePips/1_000_000n,netBacking=gross-vpmFee;
  const protocolFee=netBacking*s.feeBps/s.bps;
  return {snapshot:s,tokenId,gross,netBacking,vpmFee,protocolFee,iAeroOut:netBacking-protocolFee};
}
export function vaultActions(client:ReadClient,write:StakingWriter,c:SaeroAddresses,user:Address,identity:()=>Promise<Address|undefined>){
  const send=walletSender(client,write,c,user,identity);
  return {
    async deposit(amount:bigint){
      const s=await readVault(client,c);requireIntake(s);previewDeposit(s,amount);
      const closed=depositClosedReason(s);if(closed)throw Error(closed);
      const allowance=await client.readContract({address:s.aero,abi:STAKING_ERC20_ABI,functionName:'allowance',args:[user,c.svault]});
      if(allowance<amount)await send(s.aero,STAKING_ERC20_ABI,'approve',[c.svault,amount]);
      return send(c.svault,VAULT_ABI,'deposit',[amount]);
    },
    async depositSToken(tokenId:bigint,minNetOut:bigint){
      const q=await quoteStoken(client,c,user,tokenId);
      if(minNetOut<=0n||minNetOut>q.netBacking)throw Error('The minimum received is no longer available. Refresh the quote.');
      // Exactly 32 bytes selects paid intake. Never use the empty-data protocol-return route here.
      // This route grants no blanket approvals and returns the empty source NFT to its owner.
      const data=encodeAbiParameters([{type:'uint256'}],[minNetOut]);
      return send(q.snapshot.escrow,INTAKE_ESCROW_ABI,'safeTransferFrom',[user,c.svault,tokenId,data]);
    },
  };
}
