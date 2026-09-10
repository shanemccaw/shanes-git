/** Small shared arg-validation helpers used by every sub-issue/dependency tool. */

export function requireInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer issue number`);
  }
  return value;
}

export function requireIntArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of integer issue numbers`);
  }
  return value.map((v, i) => requireInt(v, `${name}[${i}]`));
}
