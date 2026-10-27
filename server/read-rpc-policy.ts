// The local adapter and the deployed Pages Worker share the same read-only boundary.
const methods=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getCode','eth_getBalance','eth_getStorageAt','eth_getTransactionCount','eth_getTransactionReceipt','eth_getTransactionByHash','eth_call','eth_simulateV1','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','net_version']);
export function canonicalReadRequest(value:unknown){
 const calls=Array.isArray(value)?value:[value];
 if(!calls.length||calls.length>50||calls.some(c=>!c||typeof c!=='object'||!methods.has(c.method)||c.params!==undefined&&!Array.isArray(c.params)))throw Error('Only Base read and simulation requests are supported.');
 return JSON.stringify(value);
}
export const scrubReadResponse=(reply:any):any=>Array.isArray(reply)?reply.map(scrubReadResponse):reply?.error?{jsonrpc:'2.0',id:reply.id??null,error:{code:typeof reply.error.code==='number'?reply.error.code:-32000,message:'Base read or simulation failed.',...(typeof reply.error.data==='string'&&/^0x[0-9a-f]*$/i.test(reply.error.data)?{data:reply.error.data}:{})}}:reply;
export function configuredBaseReads(raw:string){
 try{const urls=JSON.parse(raw);if(!Array.isArray(urls)||urls.length!==2||!urls.every(u=>{try{return typeof u==='string'&&new URL(u).protocol==='https:';}catch{return false;}})||new URL(urls[0]).hostname===new URL(urls[1]).hostname)throw Error();return urls as string[];}catch{throw Error('Two independent HTTPS Base read providers are required.');}
}
