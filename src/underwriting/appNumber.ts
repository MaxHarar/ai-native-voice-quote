import { APP_NUMBER_PREFIX } from "../brand";

export function luhnCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function luhnValid(full: string): boolean {
  return luhnCheckDigit(full.slice(0, -1)) === Number(full.slice(-1));
}

/** ANA-1234567: 6 random digits + Luhn check digit, so a misheard number is caught on lookup. */
export function newApplicationNumber(random: () => number = Math.random): string {
  const body = Array.from({ length: 6 }, (_, i) => Math.floor(random() * 10) || (i === 0 ? 1 : 0)).join("");
  return `${APP_NUMBER_PREFIX}-${body}${luhnCheckDigit(body)}`;
}

export function isValidApplicationNumber(app: string): boolean {
  const m = app.toUpperCase().replace(/[^A-Z0-9]/g, "").match(/^(?:[A-Z]+)?(\d{7})$/);
  return !!m && luhnValid(m[1]!);
}

export function normalizeApplicationNumber(app: string): string | null {
  const m = app.toUpperCase().replace(/[^A-Z0-9]/g, "").match(/(\d{7})$/);
  return m && luhnValid(m[1]!) ? `${APP_NUMBER_PREFIX}-${m[1]}` : null;
}

/** "ANA-4829173" → "4 8 2, 9 1 7, 3" */
export function spokenApplicationNumber(app: string): string {
  const d = app.replace(/\D/g, "");
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6)].map((g) => g.split("").join(" ")).join(", ");
}
