import {it,expect} from 'vitest';
import {positionSummary,connectionLabel} from '../src/live/position-model';
const wallet={iaero:100n,legacyStake:20n} as any;
function live(){return {known:{iaero:true,legacyStake:true},oldAutoShares:3n,boot:{newStackReady:true,newStack:{configured:true,addresses:{streamAutoVault:'auto',stakedCollateral:'wrapper'},optionalErrors:[]}},newPosition:{stream:{balance:7n},auto:{shares:11n},collateral:{shares:5n,principal:10n}}} as any;}
it('counts wrapped underlying principal rather than adding both wrapper shares and receipts',()=>{expect(positionSummary(live(),wallet)).toMatchObject({total:151n,complete:true});});
it('uses a subtotal when a configured deployed stack cannot currently be verified',()=>{const l=live();l.boot.newStackReady=false;l.newPosition=undefined;expect(positionSummary(l,wallet)).toMatchObject({total:123n,complete:false});expect(connectionLabel(l.boot).label).toBe('Verification unavailable');});
it('distinguishes an undeployed stack from unknown deployed positions',()=>{const l=live();l.boot.newStackReady=false;l.boot.newStack.configured=false;expect(positionSummary(l,wallet)).toMatchObject({total:123n,complete:true});expect(connectionLabel(l.boot).label).toBe('Awaiting deployment');});
it('does not substitute wrapper shares when its underlying quote fails',()=>{const l=live();l.newPosition.collateral.principal=undefined;expect(positionSummary(l,wallet)).toMatchObject({total:141n,complete:false});});
it('keeps optional contract verification failures visible in principal scope',()=>{const l=live();delete l.boot.newStack.addresses.streamAutoVault;l.boot.newStack.optionalErrors=['streamAutoVault runtime unavailable'];l.newPosition.auto=undefined;expect(positionSummary(l,wallet)).toMatchObject({total:140n,complete:false});});
it('reports no invented zero when every principal read is unavailable',()=>{const l=live();l.known={};l.oldAutoShares=undefined;l.newPosition=undefined;expect(positionSummary(l,wallet)).toMatchObject({total:undefined,complete:false});});

it('keeps LIQ stake outside the iAERO principal total',()=>{const l=live();l.liqPosition={balance:1000000n};expect(positionSummary(l,wallet)).toMatchObject({total:151n,complete:true});});
