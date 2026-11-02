import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Context,type Store} from '../src/store';
import {LiveEarn,LiveLegacyStakeDialog,LiveStatus} from '../src/live/views';
import {legacyEarnActive} from '../src/live/legacy-earn-view';
import {emptyWallet,initialLiveState,liveReason,type Bootstrap,type LiveState} from '../src/live/types';

const user='0x1111111111111111111111111111111111111111',E=10n**18n,copy='New staking is coming. Until it launches, staking uses the current iAERO staking pool (stiAERO).';
const boot=(patch:Partial<Bootstrap>={})=>({snapshot:{block:'1',timestamp:1,independentProviders:2},legacyReady:true,legacyPaused:false,oldAutoReady:true,newStackReady:false,newStackReason:'New contracts not deployed.',metrics:{},...patch}) as unknown as Bootstrap;
const live=(patch:Partial<LiveState>={}):LiveState=>({...initialLiveState(),boot:boot(),address:user,chainId:8453,known:{iaero:true,legacyStake:true},legacyReceipts:20n*E,legacyPaused:false,...patch});
function render(state:LiveState,view:any=createElement(LiveEarn,{openPanel:()=>{}})){
 const connected=!!state.address,store={mode:'live',live:state,disabledReason:kind=>liveReason(kind,state,connected),page:'earn',go:()=>{},connected,connect:()=>{},disconnect:()=>{},wallet:{...emptyWallet(),iaero:100n*E,legacyStake:20n*E},activities:[],flags:{paused:false,rewardsUnavailable:false,nftEnabled:false},setFlags:()=>{},walletDialog:false,setWalletDialog:()=>{},action:null,setAction:()=>{},execute:async()=>{},notify:()=>{},toast:'',dismissToast:()=>{},reset:()=>{},theme:'light',toggleTheme:()=>{}} as Store;
 return renderToStaticMarkup(createElement(Context.Provider,{value:store},view));
}
const button=(markup:string,label:string)=>markup.match(new RegExp('<button[^>]*>(?:(?!</button>).)*<span>'+label+'</span></button>'))?.[0];

describe('Earn routing while the new staking pool is not deployed',()=>{
 it('uses previous staking unless the new pool is verified ready',()=>{
  expect(legacyEarnActive(boot())).toBe(true);
  expect(legacyEarnActive(undefined)).toBe(true);
  expect(legacyEarnActive(boot({newStack:{configured:true} as Bootstrap['newStack']}))).toBe(true);
  expect(legacyEarnActive(boot({newStackReady:true}))).toBe(false);
 });
 it('shows a usable previous-staking stake route with withdraw and claim routes',()=>{
  const markup=render(live()),stake=button(markup,'Stake iAERO');
  expect(markup).toContain(copy);expect(markup).toContain('You can move to the new pool when it opens.');expect(markup).toContain('Current iAERO staking');
  expect(stake).toBeDefined();expect(stake).not.toContain('disabled');
  expect(button(markup,'Withdraw staked iAERO')).not.toContain('disabled');expect(button(markup,'Claim rewards')).not.toContain('disabled');
  expect(markup).toContain('100.00');expect(markup).toContain('20.00');
  expect(markup).not.toContain('New staking stream not deployed');expect(markup).not.toContain('Direct staking');
 });
 it('asks a disconnected visitor to connect instead of disabling the route',()=>{
  const markup=render(live({address:undefined,known:{},legacyPaused:undefined}));
  expect(button(markup,'Connect your wallet')).not.toContain('disabled');expect(markup).toContain(copy);
 });
 it('returns to the new-pool page when the new pool is ready',()=>{
  const markup=render(live({boot:boot({newStackReady:true,newStackReason:'Verified.'})}));
  expect(markup).toContain('Direct staking');expect(button(markup,'Review stake')).toBeDefined();expect(markup).not.toContain(copy);
 });
 it('keeps previous staking while a configured new pool is unverified',()=>{
  const markup=render(live({boot:boot({newStack:{configured:true,optionalErrors:[]} as unknown as Bootstrap['newStack'],newStackReason:'Runtime unavailable.'})}));
  expect(markup).toContain(copy);expect(button(markup,'Stake iAERO')).not.toContain('disabled');expect(markup).not.toContain('Contract verification unavailable');
 });
 it('shows a neutral checking state while the bootstrap loads',()=>{
  for(const state of [live({boot:undefined,loading:true}),live({boot:undefined,address:undefined,known:{}})]){
   const markup=render(state);
   expect(markup).toContain(copy);expect(markup).toContain('Checking the staking pool on Base…');expect(button(markup,'Checking the staking pool…')).toContain('disabled');
   expect(markup).not.toContain('could not be verified on Base');expect(markup).not.toContain('could not be read');expect(markup).not.toContain('info-amber');expect(markup).not.toContain('Direct staking');
  }
 });
 it('disables staking with the reason when the bootstrap fails',()=>{
  const markup=render(live({boot:undefined,error:'Verified Base contract data is unavailable. Refresh to retry.'}));
  expect(markup).toContain(copy);expect(button(markup,'Staking unavailable')).toContain('disabled');expect(markup).toContain('Base contract data could not be read, so staking is unavailable. Refresh to retry.');expect(markup).not.toContain('Checking the staking pool');
 });
 it('disables staking with the reason when previous staking is paused',()=>{
  const markup=render(live({legacyPaused:true}));
  expect(button(markup,'Staking unavailable')).toContain('disabled');expect(markup).toContain('The current staking pool is paused on chain. New stakes are unavailable until it resumes.');
  const visitor=render(live({address:undefined,known:{},legacyPaused:undefined,boot:boot({legacyPaused:true})}));
  expect(button(visitor,'Staking unavailable')).toContain('disabled');expect(visitor).toContain('paused on chain');
 });
 it('disables staking with the reason when previous staking is not verified',()=>{
  const markup=render(live({boot:boot({legacyReady:false})}));
  expect(button(markup,'Staking unavailable')).toContain('disabled');expect(markup).toContain('The current staking pool could not be verified on Base.');
 });
 it('shows the existing guard when the wallet cannot stake yet',()=>{
  const wrongChain=render(live({chainId:1}));
  expect(button(wrongChain,'Stake iAERO')).toContain('disabled');expect(wrongChain).toContain('Switch your wallet to Base before continuing.');
  const unknown=render(live({known:{legacyStake:true}}));
  expect(button(unknown,'Stake iAERO')).toContain('disabled');expect(unknown).toContain('The previous staking route or liquid iAERO balance is unavailable.');
  const unread=render(live({legacyPaused:undefined}));
  expect(button(unread,'Stake iAERO')).toContain('disabled');
 });
 it('labels the connection caption and the Earn stake dialog for the current pool',()=>{
  const caption=render(live(),createElement(LiveStatus));
  expect(caption).toContain('Staking: current pool (stiAERO) · new pool coming');expect(caption).not.toContain('legacy claims &amp; withdrawals available');
  expect(render(live({boot:boot({newStackReady:true})}),createElement(LiveStatus))).not.toContain('deployment-caption');
  expect(render(live(),createElement(LiveLegacyStakeDialog,{onClose:()=>{}}))).toContain('Stake iAERO in the current staking pool and receive stiAERO.');
  expect(render(live(),createElement(LiveLegacyStakeDialog,{onClose:()=>{},maximum:E}))).toContain('Add to previous staking without repeating a swap.');
 });
 it('leaves the new-pool actions blocked behind their own guard',()=>{
  for(const kind of ['stake','autoStake','unstake','claim'] as const)expect(liveReason(kind,live(),true)).toBe('New contracts not deployed.');
  expect(liveReason('legacyStake',live(),true)).toBeUndefined();
 });
});
