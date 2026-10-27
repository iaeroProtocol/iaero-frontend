import {describe,it,expect} from 'vitest';
import {readableAmount} from '../src/live/exact-amount';

describe('readable amount presentation',()=>{
  it('never presents positive dust as a zero and retains all exact digits',()=>{
    expect(readableAmount(1n,18)).toEqual({exact:'0.000000000000000001',summary:'< 0.000001',reduced:true});
    expect(readableAmount(388395575n,18).exact).toBe('0.000000000388395575');
  });
  it('keeps USDC minima and whole amounts exact without approximation',()=>{
    expect(readableAmount(24750000n,6)).toEqual({exact:'24.75',summary:'24.75',reduced:false});
    expect(readableAmount(0n,18).summary).toBe('0');
    expect(readableAmount(100n*10n**18n,18).summary).toBe('100');
  });
  it('does not round a displayed summary above the actual amount',()=>{
    const value=123456789123456789n,result=readableAmount(value,18);
    expect(result.summary).toBe('≈ 0.123456');
    expect(result.exact).toBe('0.123456789123456789');
    expect(value).toBe(123456789123456789n);
  });
  it('keeps unknown-decimal raw units as an integer',()=>{
    expect(readableAmount(999999999999999999999n,null)).toEqual({exact:'999999999999999999999',summary:'999999999999999999999',reduced:false});
  });
});

import {tokenText} from '../src/domain';
import {BalanceAmount} from '../src/live/exact-amount';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
describe('portfolio and wallet display precision',()=>{
 it('distinguishes true zero and positive dust at the chosen precision',()=>{expect(tokenText(0n)).toBe('0.00');expect(tokenText(1n)).toBe('< 0.01');expect(tokenText(9999999999999999n)).toBe('< 0.01');expect(tokenText(10000000000000000n)).toBe('0.01');expect(tokenText(1n,18,6)).toBe('< 0.000001');});
 it('keeps ordinary rounded summaries without using floating-point token balances',()=>{expect(tokenText(12345678n,6)).toBe('12.35');expect(tokenText(123450000000000000000n)).toBe('123.45');expect(tokenText(1n,0)).toBe('1.00');});
 it('formats large integer parts exactly and retains exact accessible digits',()=>{const value=12345678901234567890123456789012345678n;expect(tokenText(value,18)).toBe('12,345,678,901,234,567,890.12');const markup=renderToStaticMarkup(createElement(BalanceAmount,{value,symbol:'LIQ'}));expect(markup).toContain('12345678901234567890.123456789012345678 LIQ');expect(markup).toContain('data-exact-amount="12345678901234567890.123456789012345678"');});
 it('renders positive dust with an exact screen-reader label and hover title',()=>{const markup=renderToStaticMarkup(createElement(BalanceAmount,{value:1n,symbol:'LIQ'}));expect(markup).toContain('&lt; 0.01');expect(markup).toContain('title="0.000000000000000001 LIQ"');expect(markup).toContain('aria-hidden="true"');expect(markup).toContain('>0.000000000000000001 LIQ</span>');});
 it('keeps an unknown balance distinct from zero',()=>{expect(renderToStaticMarkup(createElement(BalanceAmount,{value:undefined}))).toBe('—');});
});
