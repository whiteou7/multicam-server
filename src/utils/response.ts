import { CODE, MESSAGE } from "./codes";

export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export function ok<T>(data: T, message: string = MESSAGE[CODE.OK]): ApiEnvelope<T> {
  return { code: CODE.OK, message, data };
}

export function envelope<T>(code: number, message: string, data: T): ApiEnvelope<T> {
  return { code, message, data };
}
