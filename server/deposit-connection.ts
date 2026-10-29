import {isAddress,keccak256,type Address} from 'viem';
import manifest from '../config/aero-deposit.json' with {type:'json'};
import {DEPOSIT_MIN,depositIssues,depositsOpen,type DepositConnection} from '../src/live/deposit-contract.ts';
import type {BaseRegistry} from '../src/live/types.ts';
export {manifest as depositManifest};
type Read=(address:string,signature:string,args?:readonly unknown[])=>Promise<any>;
export async function verifyDepositConnection(registry:BaseRegistry,read:Read,code:(address:Address)=>Promise<`0x${string}`|undefined>):Promise<DepositConnection>{
 try{
  if(manifest.version!==1||manifest.chainId!==8453||!isAddress(manifest.address,{strict:false})||!/^0x[\da-f]{64}$/i.test(manifest.runtimeHash))throw Error();
  const runtime=await code(manifest.address as Address);if(!runtime||keccak256(runtime)!==manifest.runtimeHash)throw Error();
  const get=(name:string,returns='address')=>read(manifest.address,`function ${name}() view returns(${returns})`);
  const names=['VAULT','VOTING_ESCROW','VOTER','AERO','iAERO','LIQ','PREDECESSOR','treasury'] as const;
  const values=await Promise.all(names.map(n=>get(n))),links=Object.fromEntries(names.map((n,i)=>[n,values[i]]));
  const expected={VAULT:manifest.vault,VOTING_ESCROW:registry.aero.votingEscrow,VOTER:registry.aero.voter,AERO:registry.aero.token,iAERO:registry.legacy.iAERO,LIQ:registry.legacy.LIQ,PREDECESSOR:manifest.predecessor,treasury:manifest.treasury};
  if(Object.entries(expected).some(([n,address])=>typeof links[n]!=='string'||links[n].toLowerCase()!==address.toLowerCase()))throw Error();
  const [chain,primary,version,rawIssues]=await Promise.all([get('BASE_CHAIN_ID','uint256'),get('PRIMARY_ID','uint256'),get('REASONS_VERSION','uint256'),read(manifest.address,'function checkAeroDeposit(address user,uint256 amount) view returns((uint8 reason,uint256 tokenId,uint256 chainId,uint256 amount,uint256 limit,uint256 time,uint256 readyAt,address account,uint8 chainStatus)[])',['0x0000000000000000000000000000000000000000',DEPOSIT_MIN])]);
  if(chain!==8453n||primary!==BigInt(registry.aero.protocolNft)||version!==BigInt(manifest.reasonsVersion))throw Error();
  const issues=depositIssues(rawIssues);return {verified:true,reason:'Deposit runtime, token links and refusal version verified.',address:manifest.address as Address,vault:links.VAULT,escrow:links.VOTING_ESCROW,aero:links.AERO,iaero:links.iAERO,liq:links.LIQ,predecessor:links.PREDECESSOR,treasury:links.treasury,reasonsVersion:Number(version),runtimeHash:manifest.runtimeHash as `0x${string}`,open:depositsOpen(issues),issues};
 }catch{return {verified:false,reason:'The deposit contract could not be verified. Refresh Base reads before continuing.'};}
}
