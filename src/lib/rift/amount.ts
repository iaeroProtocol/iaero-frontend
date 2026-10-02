// src/lib/rift/amount.ts
//
// What the user typed in the amount box, read the way they meant it, or refused. The box keeps their text
// as typed; nothing is rewritten silently ("1e-5" used to become 15).
//   "1234.5", "1,234.5", "1 234,5", "1.234,5", "0,5", ".5" -> a plain decimal
//   letters, signs, exponents, several decimal points, more decimals than the token has -> an error
// Pure, with no imports, so `node --test` can run it (tests/rift/).

export interface ParsedAmount { value?: string; error?: string }

const GROUPED = (sep: string) => new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`);

/** A plain decimal string ("1234.5") from what was typed, or an error message. Empty or zero -> {}. */
export function parseAmountInput(text: string, decimals: number): ParsedAmount {
  const t = text.replace(/[\s  ']/g, '');
  if (!t) return {};
  if (/[^0-9.,]/.test(t)) return { error: 'Enter a number, like 1234.56' };
  let s: string;
  const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // Both: the last one is the decimal point, the other groups thousands.
    const dec = lastDot > lastComma ? '.' : ',', group = dec === '.' ? ',' : '.';
    const [int, frac, ...extra] = t.split(dec);
    if (extra.length || frac.includes(group) || !GROUPED(group).test(int)) return { error: 'Enter a number, like 1234.56' };
    s = `${int.split(group).join('')}.${frac}`;
  } else if (lastComma >= 0) {
    // Commas only: "1,234,567" groups thousands; a single comma is a decimal comma ("0,5").
    if (GROUPED(',').test(t)) s = t.split(',').join('');
    else if (t.split(',').length === 2) s = t.replace(',', '.');
    else return { error: 'Enter a number, like 1234.56' };
  } else if (t.split('.').length > 2) {
    // Several dots: only "1.234.567" (dots grouping thousands) makes sense.
    if (!GROUPED('.').test(t)) return { error: 'Enter a number, like 1234.56' };
    s = t.split('.').join('');
  } else {
    s = t;
  }
  if (s.startsWith('.')) s = `0${s}`;
  if (s.endsWith('.')) s = s.slice(0, -1); // still typing
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: 'Enter a number, like 1234.56' };
  let [int, frac = ''] = s.split('.');
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  if (frac.length > decimals) return { error: decimals ? `At most ${decimals} decimal places` : 'Whole numbers only' };
  if (/^0*$/.test(int) && !frac) return {};
  return { value: frac ? `${int}.${frac}` : int };
}
