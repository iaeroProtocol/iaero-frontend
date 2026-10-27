import {getAddress, isAddress, type Address} from 'viem';

export const SAERO_ENABLED = process.env.NEXT_PUBLIC_SAERO_ENABLED === 'true';
const keys = ['svault', 'rewardForwarder', 'revenueConverter', 'streamingDistributor', 'iAERO', 'USDC', 'epochDistributor', 'stiAERO', 'autoVault'] as const;
export type SaeroAddresses = Record<typeof keys[number], Address> & {
  chainId: number; autoVaultSunset?: string; supportUrl?: string; streamAutoVault?: Address; stakedCollateral?:Address; rewardHistoryUrl?:string;
};

export function saeroAddresses(chainId: number, raw = process.env.NEXT_PUBLIC_SAERO_ADDRESSES_JSON): SaeroAddresses {
  if (!raw) throw Error('The sAERO deployment is not configured.');
  const entry = JSON.parse(raw)[String(chainId)];
  if (!entry) throw Error('sAERO is not configured on this network.');
  const result = {chainId} as SaeroAddresses;
  for (const key of keys) {
    const value = entry[key];
    if (typeof value !== 'string' || !isAddress(value, {strict:false}) || BigInt(value) === 0n) throw Error(`Missing or invalid ${key} address.`);
    result[key] = getAddress(value);
  }
  if(entry.streamAutoVault!==undefined){
    if(typeof entry.streamAutoVault!=='string'||!isAddress(entry.streamAutoVault,{strict:false})||BigInt(entry.streamAutoVault)===0n)throw Error('Invalid replacement AutoVault address.');
    result.streamAutoVault=getAddress(entry.streamAutoVault);
  }
  if(entry.stakedCollateral!==undefined){
    if(typeof entry.stakedCollateral!=='string'||!isAddress(entry.stakedCollateral,{strict:false})||BigInt(entry.stakedCollateral)===0n)throw Error('Invalid staking collateral wrapper address.');
    result.stakedCollateral=getAddress(entry.stakedCollateral);
  }
  if (entry.autoVaultSunset) {
    if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(entry.autoVaultSunset) || !Number.isFinite(Date.parse(entry.autoVaultSunset))) throw Error('Invalid AutoVault sunset date.');
    result.autoVaultSunset = entry.autoVaultSunset;
  }
  if (entry.supportUrl) {
    const url = new URL(entry.supportUrl);
    if (url.protocol !== 'https:') throw Error('Support URL must use HTTPS.');
    result.supportUrl = url.href;
  }
  if(entry.rewardHistoryUrl){
    const url=new URL(entry.rewardHistoryUrl);
    if(url.protocol!=='https:')throw Error('Reward history URL must use HTTPS.');
    result.rewardHistoryUrl=url.href;
  }
  return result;
}
