import {protocolDataUrl} from '../protocol-data/api';
import {isAddress,parseAbi,type Address} from 'viem';
import type {BaseClient} from './client';
import type {Bootstrap,LegacyReward} from './types';
import {CLAIM_MANY_ABI} from './rewards';
import {OLD_AUTO_ABI} from '../protocol/autoVaultClient';
export type LegacyDiscovery={firstEpoch?:string;lastEpoch?:string;complete:boolean;head:string;indexedThrough:{name:string;block:string}[];pairs:number;readPairs:number;readErrors:number;errors:string[];epochs:number};
const metadata=parseAbi(['function symbol() view returns(string)','function decimals() view returns(uint8)']);
export async function readFundedHistory(client:BaseClient,boot:Bootstrap,user:Address){
 const response=await fetch(protocolDataUrl('/api/legacy-history'),{cache:'no-store'});if(!response.ok)throw Error('Full funded history is temporarily unavailable. Date-based claims remain available.');const index=await response.json();
 if(index.version!==1||index.chainId!==8453||index.providers!==2||!index.targets||!/^\d+$/.test(index.head))throw Error('Funding history is still being indexed.');
 const pairs=index.targets.staking?.pairs??[],autoEpochs=index.targets.autoVault?.epochs??[];if(!Array.isArray(pairs)||pairs.length>250000||!Array.isArray(autoEpochs))throw Error('Funding index is invalid.');
 const block=await client.getBlock(),current=block.timestamp/604800n*604800n,groups=new Map<string,Address[]>(),unique=new Set<string>();
 for(const p of pairs){if(!isAddress(p.token)||!/^\d+$/.test(p.epoch)||BigInt(p.epoch)%604800n!==0n)throw Error('Invalid funded token/week.');if(BigInt(p.epoch)>current)continue;const key=p.token.toLowerCase()+':'+p.epoch;if(unique.has(key))continue;unique.add(key);groups.set(p.epoch,[...(groups.get(p.epoch)??[]),p.token]);}
 const jobs:{epoch:bigint;tokens:Address[]}[]=[];for(const [epoch,tokens] of groups)for(let i=0;i<tokens.length;i+=64)jobs.push({epoch:BigInt(epoch),tokens:tokens.slice(i,i+64)});
 const positive:{epoch:bigint;token:Address;amount:bigint}[]=[],errors:string[]=[];let next=0,readPairs=0,readErrors=0;
 await Promise.all(Array.from({length:Math.min(jobs.length,4)},async()=>{while(next<jobs.length){const j=jobs[next++];try{const amounts=await client.readContract({address:boot.registry.legacy.epochDistributor,abi:CLAIM_MANY_ABI,functionName:'previewClaimsForEpoch',args:[user,j.tokens,j.epoch],blockNumber:block.number});if(amounts.length!==j.tokens.length)throw Error();j.tokens.forEach((token,i)=>{if(amounts[i]>0n)positive.push({epoch:j.epoch,token,amount:amounts[i]});});readPairs+=j.tokens.length;}catch{readErrors+=j.tokens.length;}}}));
 const infos=new Map<string,{symbol:string;decimals:number|null}>();await Promise.all([...new Set(positive.map(p=>p.token.toLowerCase()))].map(async token=>{const known=boot.registry.knownLegacyRewardTokens.find(t=>t.address.toLowerCase()===token);let symbol=known?.symbol??token.slice(0,6)+'…'+token.slice(-4),decimals:number|null=known?.decimals??null;if(BigInt(token)===0n){symbol='ETH';decimals=18;}else{try{symbol=String(await client.readContract({address:token as Address,abi:metadata,functionName:'symbol',blockNumber:block.number})).slice(0,32);}catch{}try{const d=Number(await client.readContract({address:token as Address,abi:metadata,functionName:'decimals',blockNumber:block.number}));if(d>=0&&d<=36)decimals=d;}catch{}}infos.set(token,{symbol,decimals});}));
 const rewards:LegacyReward[]=positive.map(p=>({...p,...infos.get(p.token.toLowerCase())!})),epochs=[...new Set(autoEpochs.filter((v:unknown)=>typeof v==='string'&&/^\d+$/.test(v)&&BigInt(v)%604800n===0n&&BigInt(v)<=current))].map(v=>BigInt(v as string));let autoEarned:bigint|undefined=epochs.length||index.targets.autoVault?.block===index.head?0n:undefined;
 try{for(let i=0;i<epochs.length;i+=50){const out=await client.readContract({address:boot.registry.legacy.autoVault,abi:OLD_AUTO_ABI,functionName:'previewUSDCMany',args:[user,epochs.slice(i,i+50)],blockNumber:block.number});autoEarned=(autoEarned??0n)+out[1];}}catch{autoEarned=undefined;errors.push('Some AutoVault reward weeks could not be read.');}
 const fresh=Number.isSafeInteger(index.readAtMs)&&Date.now()-index.readAtMs<20*60000&&index.readAtMs<Date.now()+5000;
 const fundedEpochs=[...groups.keys()].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
 const discovery:LegacyDiscovery={firstEpoch:fundedEpochs[0],lastEpoch:fundedEpochs.at(-1),complete:!!index.complete&&fresh&&readErrors===0&&autoEarned!==undefined,head:index.head,indexedThrough:Object.entries(index.targets).map(([name,c])=>({name,block:(c as any).block})),pairs:unique.size,readPairs,readErrors,errors:[...(index.errors??[]),...errors],epochs:groups.size};
 return {rewards,oldAutoEpochs:epochs,oldAutoEarned:autoEarned,rewardReadErrors:readErrors,legacyDiscovery:discovery,rewardTokenCount:new Set(pairs.map((p:any)=>p.token.toLowerCase())).size};
}
