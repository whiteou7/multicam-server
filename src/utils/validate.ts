import { ApiError, CODE } from "./codes";

export function requireField<T>(value: T | undefined | null, fieldName: string): T {
  if (value === undefined || value === null || value === "") {
    throw new ApiError(CODE.PARAM_MISSING, `Missing required parameter: ${fieldName}`);
  }
  return value;
}

export function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(CODE.PARAM_TYPE_INVALID, `${fieldName} must be a non-empty string`);
  }
  return value;
}

export function assertNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ApiError(CODE.PARAM_TYPE_INVALID, `${fieldName} must be a number`);
  }
  return value;
}

export function assertOneOf<T extends string | number>(
  value: T,
  allowed: readonly T[],
  fieldName: string
): T {
  if (!allowed.includes(value)) {
    throw new ApiError(CODE.PARAM_VALUE_INVALID, `${fieldName} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

export function assertPhone(value: string): string {
  if (!/^0\d{9}$/.test(value)) {
    throw new ApiError(CODE.PARAM_VALUE_INVALID, "phone must be 10 digits starting with 0");
  }
  return value;
}

export function assertPassword(value: string): string {
  if (value.length < 6 || value.length > 20) {
    throw new ApiError(CODE.PARAM_VALUE_INVALID, "password must be 6-20 characters");
  }
  return value;
}
