import {formatUnits,getAddress,type Address} from 'viem';
import table from '../../config/aero-deposit.reasons.v3.json';
import type {DepositIssue} from './deposit-contract';
export {table as depositReasonTable};
export type DepositGuidance={code:number;name:string;instruction:string;steps:string[];fee:string;wait:string;technical:string[]};
export function depositUtc(seconds:bigint){if(seconds<0n||seconds>8_640_000_000_000n)return 'date unavailable';const date=new Date(Number(seconds)*1000);if(!Number.isFinite(date.getTime()))return 'date unavailable';return date.toISOString().slice(0,16).replace('T',' ')+' UTC';}
const entries=new Map(table.reasons.map(r=>[r.code,r]));
export function depositGuidance(issue:DepositIssue,caller:Address,version:number):DepositGuidance{
 const entry=entries.get(issue.reason);
 if(version!==table.reasonsVersion||!entry)return {code:issue.reason,name:'Deposit unavailable',instruction:'The deposit could not be checked with the current guidance. Refresh and retry before making a deposit.',steps:[],fee:'',wait:'',technical:[]};
 const variant=(entry as any).variants?.find((v:any)=>Object.entries(v.when).every(([key,value])=>String((issue as any)[key])===String(value))),texts={...entry,...variant};
 const chain=table.chains.find(c=>String(c.id)===String(issue.chainId))?.name;
 const values:Record<string,string>={tokenId:issue.tokenId.toString(),chainId:issue.chainId.toString(),chainName:chain??'chain '+issue.chainId,amount:formatUnits(issue.amount,18),amountWei:issue.amount.toString(),limit:formatUnits(issue.limit,18),time:depositUtc(issue.time),readyAt:issue.readyAt===0n?'now':depositUtc(issue.readyAt),account:getAddress(issue.account),caller:getAddress(caller)};
 const fill=(text:string)=>text.replace(/\{([^{}]+)\}/g,(_match,key)=>{if(!(key in values))throw Error('Unsupported deposit guidance placeholder.');return values[key];});
 return {code:issue.reason,name:entry.name,instruction:fill(texts.instruction),steps:(texts.steps??[]).map(fill),fee:fill(texts.fee??''),wait:fill(texts.wait??''),technical:(texts.technical??[]).map(fill)};
}
