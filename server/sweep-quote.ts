export class SweepQuoteError extends Error{
  code:string;status:number;
  constructor(code:string,status:number,message:string){super(message);this.code=code;this.status=status;}
}
// [VERIFIED: actual 0x liquidityAvailable=false responses for the owner's VVV
// and wstETH amounts, 2026-10-26; 0x v2 Issues & Error Codes]
export function checkQuoteServiceResponse(status:number,data:any){
  if(status===429)throw new SweepQuoteError('RATE_LIMITED',429,'The 0x quote service is rate limited. Wait and retry.');
  if(status===401)throw new SweepQuoteError('QUOTE_AUTHENTICATION',503,'The quote service authentication needs attention.');
  if(status===403)throw new SweepQuoteError('QUOTE_ACCESS_DENIED',503,'The 0x quote service refused this request.');
  if(status>=500)throw new SweepQuoteError('QUOTE_SERVICE_UNAVAILABLE',503,'The 0x quote service is temporarily unavailable. Retry later.');
  if(status<200||status>=300){
    const code=String(data?.name??data?.code??'');
    if(['SELL_AMOUNT_TOO_SMALL','INSUFFICIENT_ASSET_LIQUIDITY'].includes(code))throw new SweepQuoteError('NO_ROUTE_FOR_AMOUNT',422,'0x returned no executable route for this exact amount. Very small balances can have a price without a tradeable route.');
    if(['TOKEN_NOT_SUPPORTED','SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE','BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE'].includes(code))throw new SweepQuoteError('TOKEN_NOT_SUPPORTED',422,'0x does not currently support this token for the requested trade.');
    throw new SweepQuoteError('QUOTE_REQUEST_REJECTED',422,'The quote service rejected this token and amount.');
  }
  if(data?.liquidityAvailable===false)throw new SweepQuoteError('NO_ROUTE_FOR_AMOUNT',422,'0x returned no executable route for this exact amount. Very small balances can have a price without a tradeable route.');
}
