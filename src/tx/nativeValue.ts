/** Decimal wei from a relay `value` field. `null` when the string is not base-10 digits. */
export function nativeValueWei(value: string | undefined): bigint | null {
  if (value === undefined || value.length === 0) {
    return 0n;
  }
  if (!/^[0-9]+$/.test(value)) {
    return null;
  }
  return BigInt(value);
}

export function isZeroNativeValue(value: string | undefined): boolean {
  return nativeValueWei(value) === 0n;
}
