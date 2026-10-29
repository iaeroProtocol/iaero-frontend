import {readFile} from 'node:fs/promises';
import {decodeFunctionData,encodeAbiParameters,encodeEventTopics,encodeFunctionResult,parseAbi,zeroAddress} from 'viem';
import {liveFixture} from './live-fixture.mjs';

// Browser-only deterministic wallet/RPC. The deployed-contract replay is a
// separate test; no result here is presented as a live or fork acceptance.
export async function depositFixture(options={},origin){
 const f=await liveFixture(options,origin),{state,registry,unit,user,other,writes,hash}=f;
 const manifest=JSON.parse(await readFile('config/aero-deposit.json','utf8')),depositAbi=JSON.parse(await readFile('config/aero-deposit.abi.json','utf8')),runtime=JSON.parse(await readFile('test/fixtures/aero-deposit-runtime.json','utf8'));
 const escrowAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function tokenOfOwnerByIndex(address,uint256) view returns(uint256)','function staked(uint256) view returns((uint128 amount,uint48 end,bool isPermanent))','function ownerOf(uint256) view returns(address)','function approve(address,uint256)']);
 state.blockTimestamp=BigInt(Math.floor(Date.now()/1000));state.depositOpen=true;state.depositPaused=false;state.depositRate=unit/2n;state.oldAero=0n;state.stakeApprovals=new Set();state.depositIssues=[];
 state.depositStakes=[{id:700n,amount:2n*unit,end:0,isPermanent:true},{id:701n,amount:3n*unit,end:Number(state.blockTimestamp+604800n),isPermanent:false}];
 f.boot.deposit={verified:true,reason:'Deterministic UI fixture',address:manifest.address,vault:manifest.vault,escrow:registry.aero.votingEscrow,aero:registry.aero.token,iaero:registry.legacy.iAERO,liq:registry.legacy.LIQ,predecessor:manifest.predecessor,treasury:manifest.treasury,reasonsVersion:3,runtimeHash:manifest.runtimeHash,open:true};
 const same=(a,b)=>a.toLowerCase()===b.toLowerCase(),allowance=()=>state.allowances.get(registry.aero.token.toLowerCase()+':'+manifest.address.toLowerCase())??0n;
 const issue=(reason,extra={})=>({reason,tokenId:0n,chainId:8453n,amount:0n,limit:0n,time:state.blockTimestamp,readyAt:0n,account:zeroAddress,chainStatus:1,...extra});
 const quote=amount=>{const fee=amount*500n/10000n,iaero=amount-fee,liq=iaero*state.depositRate/unit;return [iaero,fee,liq,liq/5n];};
 state.customCode=address=>same(address,manifest.address)?runtime.code:'0x01';
 state.customCall=(to,data)=>{
  if(same(to,manifest.oldAero))return encodeFunctionResult({abi:escrowAbi,functionName:'balanceOf',result:state.oldAero});
  if(same(to,manifest.address)){
   const {functionName:name,args=[]}=decodeFunctionData({abi:depositAbi,data}),amount=name==='checkAeroDeposit'?args[1]:state.depositStakes.find(s=>s.id===args[0])?.amount??0n;
   if(name==='REASONS_VERSION')return encodeFunctionResult({abi:depositAbi,functionName:name,result:3n});
   if(name==='getCurrentEmissionRate'||name==='halvings'||name==='totalLIQMinted')return encodeFunctionResult({abi:depositAbi,functionName:name,result:name==='getCurrentEmissionRate'?state.depositRate:name==='halvings'?1n:5n*10n**24n});
   if(name==='checkAeroDeposit'||name==='checkStake'){
    const rows=[];if(!state.depositOpen)rows.push(issue(2));if(state.depositPaused)rows.push(issue(1));
    if(name==='checkAeroDeposit'){if((state.balances.get(registry.aero.token.toLowerCase())??0n)<amount)rows.push(issue(7,{amount,limit:state.balances.get(registry.aero.token.toLowerCase())??0n}));if(allowance()<amount)rows.push(issue(8,{amount,limit:allowance()}));}
    else{const stake=state.depositStakes.find(s=>s.id===args[0]);if(!stake)rows.push(issue(9,{tokenId:args[0]}));else if(!state.stakeApprovals.has(args[0].toString()))rows.push(issue(20,{tokenId:args[0]}));rows.push(...state.depositIssues.map(i=>issue(i.reason,{tokenId:args[0],...i})));}
    return encodeFunctionResult({abi:depositAbi,functionName:name,result:rows});
   }
   if(name==='previewDeposit')return encodeFunctionResult({abi:depositAbi,functionName:name,result:quote(args[0])});
   if(name==='depositAero'||name==='depositStake'){if(state.depositPaused||!state.depositOpen)throw Error('execution reverted: closed');return encodeFunctionResult({abi:depositAbi,functionName:name,result:name==='depositAero'?999n:undefined});}
   throw Error('Unexpected fixture deposit read: '+name);
  }
  if(same(to,registry.aero.votingEscrow)){
   const {functionName:name,args=[]}=decodeFunctionData({abi:escrowAbi,data});
   const result=name==='balanceOf'?BigInt(state.depositStakes.length):name==='tokenOfOwnerByIndex'?state.depositStakes[Number(args[1])]?.id:name==='staked'?state.depositStakes.find(s=>s.id===args[0])??{amount:0n,end:0,isPermanent:false}:name==='ownerOf'?user:undefined;
   return encodeFunctionResult({abi:escrowAbi,functionName:name,result});
  }
 };
 state.customBroadcast=async tx=>{
  if(!same(tx.to,manifest.address)&&!same(tx.to,registry.aero.votingEscrow))return;
  const abi=same(tx.to,manifest.address)?depositAbi:escrowAbi,{functionName:name,args=[]}=decodeFunctionData({abi,data:tx.data}),h=hash(writes.length+1),logs=[];writes.push({...tx,name,args,hash:h});
  if(name==='approve')state.stakeApprovals.add(args[1].toString());
  else{
   const stake=name==='depositStake',source=state.depositStakes.find(s=>s.id===args[0]),amount=stake?source.amount:args[0],id=stake?source.id:999n,q=quote(amount),eventName=stake?'StakeDeposited':'AeroDeposited',event=depositAbi.find(e=>e.name===eventName);
   if(stake)state.depositStakes=state.depositStakes.filter(s=>s.id!==id);else state.balances.set(registry.aero.token.toLowerCase(),state.balances.get(registry.aero.token.toLowerCase())-amount);
   for(const [token,value] of [[registry.legacy.iAERO,q[0]],[registry.legacy.LIQ,q[2]]])state.balances.set(token.toLowerCase(),state.balances.get(token.toLowerCase())+value);
   logs.push({address:manifest.address,topics:encodeEventTopics({abi:depositAbi,eventName,args:{user,tokenId:id}}),data:encodeAbiParameters(event.inputs.filter(i=>!i.indexed),stake?[amount,!source.isPermanent,...q]:[amount,...q])});
  }
  const blockHash='0x'+'cd'.repeat(32);state.receiptsByHash.set(h,{transactionHash:h,transactionIndex:'0x0',blockHash,blockNumber:'0x7b',from:user,to:tx.to,cumulativeGasUsed:'0x186a0',gasUsed:'0x186a0',effectiveGasPrice:'0x1',logs:logs.map((log,i)=>({...log,transactionHash:h,blockHash,blockNumber:'0x7b',transactionIndex:'0x0',logIndex:'0x'+i.toString(16),removed:false})),logsBloom:'0x'+'00'.repeat(256),status:'0x1',type:'0x2'});await state.afterBroadcast?.(tx,name,args,h);return h;
 };
 return {...f,manifest,issue,quote};
}
