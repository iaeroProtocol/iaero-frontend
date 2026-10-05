// src/lib/rift/amount.ts
//
// What the user typed in the amount box, read the way they meant it, or refused. The box keeps their text
// as typed; nothing is rewritten silently ("1e-5" used to become 15).
//   "1234.5", "1,234.5", "1 234,5", "1.234,5", "0,5", "0,500", ".5" -> a plain decimal
//   "1,500" and "1.500" could be either: they follow the browser's decimal separator, and are flagged so the
//   page can show how it read them
//   letters, signs, exponents, several decimal points, more decimals than the token has -> an error
// Pure, with no imports, so `node --test` can run it (tests/rift/).

export interface ParsedAmount {
  value?: string;
  error?: string;
  /** "1,500" or "1.500": read by the browser's decimal separator; the page shows the reading. */
  ambiguous?: boolean;
}

/** Thousands groups: a first group of 1-3 digits that is not 0 (no number is written "0,500"), then groups of 3. */
const GROUPED = (sep: string) => new RegExp(`^[1-9]\\d{0,2}(\\${sep}\\d{3})+$`);
/** One separator with exactly three digits after it: a thousands group or a decimal, depending on the reader. */
const ONE_GROUP = (sep: string) => new RegExp(`^[1-9]\\d{0,2}\\${sep}\\d{3}$`);
const INVALID = { error: 'Enter a number, like 1234.56' };

/**
 * A plain decimal string ("1234.5") from what was typed, or an error message. Empty or zero -> {}.
 * `decimalSep` is the browser locale's decimal separator.
 */
export function parseAmountInput(text: string, decimals: number, decimalSep: '.' | ',' = '.'): ParsedAmount {
  const t = text.replace(/[\s  ']/g, '');
  if (!t) return {};
  if (/[^0-9.,]/.test(t)) return INVALID;
  let s: string;
  let ambiguous = false;
  const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // Both: the last one is the decimal point, the other groups thousands.
    const dec = lastDot > lastComma ? '.' : ',', group = dec === '.' ? ',' : '.';
    const [int, frac, ...extra] = t.split(dec);
    if (extra.length || frac.includes(group) || !GROUPED(group).test(int)) return INVALID;
    s = `${int.split(group).join('')}.${frac}`;
  } else if (lastDot >= 0 || lastComma >= 0) {
    // One kind of separator.
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = t.split(sep);
    if (ONE_GROUP(sep).test(t)) {
      // "1,500" / "1.500": a decimal where `sep` is the locale's decimal separator, else thousands.
      ambiguous = true;
      s = sep === decimalSep ? parts.join('.') : parts.join('');
    } else if (parts.length > 2) {
      // Several: only thousands groups ("1,234,567") make sense.
      if (!GROUPED(sep).test(t)) return INVALID;
      s = parts.join('');
    } else {
      // A single separator that cannot be a thousands group ("0,5", "0,500", "12.5"): the decimal point.
      s = parts.join('.');
    }
  } else {
    s = t;
  }
  if (s.startsWith('.')) s = `0${s}`;
  if (s.endsWith('.')) s = s.slice(0, -1); // still typing
  if (!/^\d+(\.\d+)?$/.test(s)) return INVALID;
  let [int, frac = ''] = s.split('.');
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  if (frac.length > decimals) return { error: decimals ? `At most ${decimals} decimal places` : 'Whole numbers only' };
  if (/^0*$/.test(int) && !frac) return {};
  return { value: frac ? `${int}.${frac}` : int, ...(ambiguous ? { ambiguous } : {}) };
}

/** A plain decimal ("12.345") written the way the user's locale writes it, for the amount box: what the page
 *  puts there itself (MAX, a repeated order) must read back as the same number ("12.345" is twelve thousand
 *  three hundred and forty-five where the decimal separator is a comma). */
export const toInputText = (decimal: string, decimalSep: '.' | ',') => (decimalSep === ',' ? decimal.replace('.', ',') : decimal);

/** The browser's decimal separator. */
export function localeDecimalSep(locale?: string): '.' | ',' {
  try {
    return (1.5).toLocaleString(locale).includes(',') ? ',' : '.';
  } catch {
    return '.';
  }
}
