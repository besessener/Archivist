// Check digits of identifiers that look like random digit strings; they keep the masking from hitting ordinary numbers.
const digitsOf = (value: string): number[] => [...value].map(Number);

/** IBAN: country, check digits, at most 34 characters, ISO 7064 mod 97-10. */
export function validIban(raw: string): boolean {
  const iban = raw.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const character of moved) {
    const value = /\d/.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

/** Payment card number of 13 to 19 digits (spaces and hyphens allowed), Luhn check. */
export function validCardNumber(raw: string): boolean {
  const digits = raw.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  const sum = digitsOf(digits)
    .toReversed()
    .reduce((total, digit, index) => {
      const value = index % 2 === 1 ? digit * 2 : digit;
      return total + (value > 9 ? value - 9 : value);
    }, 0);
  return sum % 10 === 0;
}

/** German tax ID (Steuer-ID): 11 digits, one digit twice or three times among the first ten, ISO 7064 mod 11,10. */
export function validSteuerId(raw: string): boolean {
  const compact = raw.replace(/\s/g, '');
  if (!/^[1-9]\d{10}$/.test(compact)) return false;
  const digits = digitsOf(compact);
  const counts = new Map<number, number>();
  for (const digit of digits.slice(0, 10)) counts.set(digit, (counts.get(digit) ?? 0) + 1);
  const repeated = [...counts.values()].filter((count) => count > 1);
  if (repeated.length !== 1 || repeated[0]! > 3) return false;
  let product = 10;
  for (const digit of digits.slice(0, 10)) {
    let sum = (digit + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  return (11 - product) % 10 === digits[10];
}

const SV_WEIGHTS = [2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1];

/** German social security number (Rentenversicherungsnummer): area, birth date, initial letter, serial, check digit. */
export function validSvNumber(raw: string): boolean {
  const compact = raw.replace(/\s/g, '').toUpperCase();
  const match = /^(\d{2})(\d{6})([A-Z])(\d{2})(\d)$/.exec(compact);
  if (!match) return false;
  const letter = String(match[3]!.charCodeAt(0) - 64).padStart(2, '0');
  const digits = digitsOf(`${match[1]}${match[2]}${letter}${match[4]}`);
  const sum = digits.reduce((total, digit, index) => total + [...String(digit * SV_WEIGHTS[index]!)].reduce((part, one) => part + Number(one), 0), 0);
  return sum % 10 === Number(match[5]);
}
