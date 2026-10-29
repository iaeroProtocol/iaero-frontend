import type {BaseRegistry} from '../src/live/types.ts';
import type {DepositConnection} from '../src/live/deposit-contract.ts';
type Reader=(address:string,signature:string,args?:readonly unknown[])=>Promise<any>;
export type ProtocolBacking={scope:'primary-and-vault'|'primary-only'|'unavailable';complete:boolean;primary:bigint;additional?:bigint;total?:bigint;heldTokenIds:string[]};
// [VERIFIED: AeroStakeVault.sol:328-341,715-720; AeroStakeDeposit.sol:317-369]
// New deposits are held as separate stakes until the keeper merges them. Never
// count the primary twice or report a partial sum as the protocol's total TVL.
export async function readProtocolBacking(read:Reader,registry:BaseRegistry,deposit:DepositConnection,primary:bigint):Promise<ProtocolBacking>{
 if(!deposit.verified||!deposit.vault)return {scope:'primary-only',complete:false,primary,total:primary,heldTokenIds:[]};
 try{
  const held=await read(deposit.vault,'function heldTokenIds() view returns(uint256[])');
  if(!Array.isArray(held)||held.length>1024||held.some(id=>typeof id!=='bigint'||id<=0n||id>=2n**256n))throw Error();
  const ids=[...new Set<bigint>(held)],rows=await Promise.all(ids.map(async id=>{
   const [owner,tracked,stake]=await Promise.all([read(registry.aero.votingEscrow,'function ownerOf(uint256) view returns(address)',[id]),read(deposit.vault!,'function isHeld(uint256) view returns(bool)',[id]),read(registry.aero.votingEscrow,'function staked(uint256) view returns((uint128 amount,uint48 end,bool isPermanent))',[id])]);
   if(typeof owner!=='string'||owner.toLowerCase()!==deposit.vault!.toLowerCase()||tracked!==true||typeof stake?.amount!=='bigint'||stake.amount<0n||stake.amount>=2n**128n)throw Error();
   return id===BigInt(registry.aero.protocolNft)?0n:stake.amount;
  }));
  const additional=rows.reduce((a,b)=>a+b,0n),total=primary+additional;if(primary<0n||total>=2n**256n)throw Error();
  return {scope:'primary-and-vault',complete:true,primary,additional,total,heldTokenIds:ids.map(String)};
 }catch{return {scope:'unavailable',complete:false,primary,heldTokenIds:[]};}
}
