import type {Address} from 'viem';

export type TokenFilter={chainId:8453;source:string;sourceSha256:string;fetchedAt:string;sourceUpdatedAt:string;version:string;addresses:Address[];symbolPatterns:string[]};
const addressSets=new WeakMap<TokenFilter,Set<string>>();
// [VERIFIED: existing frontend src/lib/swap-pipeline.ts spam blocklist]
// The protocol's explicit address and literal symbol rules. A missing quote is
// a trading failure, not evidence that a token belongs on this list.
export function spamReason(policy:TokenFilter|undefined,token:string,symbol:string):string|undefined{
  if(!policy||policy.chainId!==8453)throw Error('The token filter is unavailable. Refresh before sweeping.');
  let addresses=addressSets.get(policy);
  if(!addresses){addresses=new Set(policy.addresses.map(a=>a.toLowerCase()));addressSets.set(policy,addresses);}
  if(addresses.has(token.toLowerCase()))return 'Listed in the protocol spam filter';
  if(policy.symbolPatterns.some(pattern=>symbol.toLowerCase().includes(pattern.toLowerCase())))return 'Matches a protocol spam-symbol rule';
}
