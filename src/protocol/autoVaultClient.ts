// Principal reads remain independent of reward accounting in both vault generations.
import {parseAbi} from 'viem';
import type {ReadClient} from './streamingClient';
import type {SaeroAddresses} from './saeroAddresses';

export const AUTO_ABI=parseAbi(['function sharesOf(address) view returns(uint256)','function previewUSDC(address) view returns(uint256)','function paused() view returns(bool)','function deposit(uint256)','function withdraw(uint256)','function claimUSDC()']);
export const OLD_AUTO_ABI=parseAbi(['function sharesOf(address) view returns(uint256)','function previewUSDCMany(address,uint256[]) view returns(uint256[] amounts,uint256 total)','function withdraw(uint256)','function claimUSDC(uint256[])']);
export type AutoSnapshot={old:{shares?:bigint;earned?:bigint;epochs:bigint[]};fresh?:{shares?:bigint;earned?:bigint;paused?:boolean};errors:string[]};
export async function readAutoVaults(client:ReadClient,c:SaeroAddresses,user:string,olderDate:string):Promise<AutoSnapshot>{
  const block=await client.getBlock(),currentEpoch=Math.floor(Number(block.timestamp)/604800)*604800,errors:string[]=[];
  const selected=olderDate?Math.floor(Date.parse(olderDate+'T00:00:00Z')/1000/604800)*604800:currentEpoch;
  const validDate=Number.isSafeInteger(selected)&&selected>=0&&selected<=currentEpoch;
  const epochs=validDate?Array.from({length:26},(_,i)=>BigInt(Math.max(0,selected-i*604800))).filter((x,i,a)=>i===0||x!==a[i-1]):[];
  if(!validDate)errors.push('Select a past date for old rewards.');
  const read=(address:string,abi:readonly unknown[],functionName:string,args:readonly unknown[]=[])=>client.readContract({address,abi,functionName,args,blockNumber:block.number});
  const results=await Promise.allSettled([
    read(c.autoVault,OLD_AUTO_ABI,'sharesOf',[user]),
    validDate?read(c.autoVault,OLD_AUTO_ABI,'previewUSDCMany',[user,epochs]).then(r=>r[1]):Promise.resolve(undefined),
    c.streamAutoVault?read(c.streamAutoVault,AUTO_ABI,'sharesOf',[user]):Promise.resolve(undefined),
    c.streamAutoVault?read(c.streamAutoVault,AUTO_ABI,'previewUSDC',[user]):Promise.resolve(undefined),
    c.streamAutoVault?read(c.streamAutoVault,AUTO_ABI,'paused'):Promise.resolve(undefined),
  ]);
  const labels=['Old AutoVault stake','Old AutoVault rewards','Replacement AutoVault stake','Replacement AutoVault rewards','Replacement AutoVault deposit status'];
  const values=results.map((r,i)=>{if(r.status==='fulfilled')return r.value;errors.push(`${labels[i]} could not be read.`);return undefined;});
  return {old:{shares:values[0],earned:values[1],epochs},fresh:c.streamAutoVault?{shares:values[2],earned:values[3],paused:values[4]}:undefined,errors};
}
