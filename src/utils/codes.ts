// Response codes per specs/v3_GiaoDien_TichHop_API_MultiCamRecorder.md section 1.6
export const CODE = {
  OK: 1000,
  DB_ERROR: 1001,
  PARAM_MISSING: 1002,
  PARAM_TYPE_INVALID: 1003,
  PARAM_VALUE_INVALID: 1004,
  UNKNOWN_ERROR: 1005,
  FILE_TOO_BIG: 1006,
  UPLOAD_FAILED: 1007,
  MAX_ITEMS_EXCEEDED: 1008,
  NOT_ACCESS: 1009,
  ALREADY_DONE: 1010,
  COULD_NOT_COMPLETE: 1011,
  LIMITED_ACCESS: 1012,
  NOT_EXISTED: 9992,
  CODE_VERIFY_INCORRECT: 9993,
  NO_DATA: 9994,
  USER_NOT_VALIDATED: 9995,
  USER_EXISTED: 9996,
  METHOD_INVALID: 9997,
  TOKEN_INVALID: 9998,
  EXCEPTION_ERROR: 9999,
} as const;

export const MESSAGE: Record<number, string> = {
  [CODE.OK]: "OK",
  [CODE.DB_ERROR]: "Can not connect to DB",
  [CODE.PARAM_MISSING]: "Parameter is not enough",
  [CODE.PARAM_TYPE_INVALID]: "Parameter type is invalid",
  [CODE.PARAM_VALUE_INVALID]: "Parameter value is invalid",
  [CODE.UNKNOWN_ERROR]: "Unknown error",
  [CODE.FILE_TOO_BIG]: "File size is too big",
  [CODE.UPLOAD_FAILED]: "Upload file failed",
  [CODE.MAX_ITEMS_EXCEEDED]: "Maximum number of images",
  [CODE.NOT_ACCESS]: "Not access",
  [CODE.ALREADY_DONE]: "Action has been done previously by this user",
  [CODE.COULD_NOT_COMPLETE]: "Could not publish this post",
  [CODE.LIMITED_ACCESS]: "Limited access",
  [CODE.NOT_EXISTED]: "Post is not existed",
  [CODE.CODE_VERIFY_INCORRECT]: "Code verify is incorrect",
  [CODE.NO_DATA]: "No data or end of list data",
  [CODE.USER_NOT_VALIDATED]: "User is not validated",
  [CODE.USER_EXISTED]: "User existed",
  [CODE.METHOD_INVALID]: "Method is invalid",
  [CODE.TOKEN_INVALID]: "Token is invalid",
  [CODE.EXCEPTION_ERROR]: "Exception error",
};

const DEFAULT_HTTP_STATUS: Record<number, number> = {
  [CODE.OK]: 200,
  [CODE.DB_ERROR]: 500,
  [CODE.PARAM_MISSING]: 400,
  [CODE.PARAM_TYPE_INVALID]: 400,
  [CODE.PARAM_VALUE_INVALID]: 400,
  [CODE.UNKNOWN_ERROR]: 500,
  [CODE.FILE_TOO_BIG]: 413,
  [CODE.UPLOAD_FAILED]: 400,
  [CODE.MAX_ITEMS_EXCEEDED]: 400,
  [CODE.NOT_ACCESS]: 403,
  [CODE.ALREADY_DONE]: 409,
  [CODE.COULD_NOT_COMPLETE]: 409,
  [CODE.LIMITED_ACCESS]: 403,
  [CODE.NOT_EXISTED]: 404,
  [CODE.CODE_VERIFY_INCORRECT]: 400,
  [CODE.NO_DATA]: 200,
  [CODE.USER_NOT_VALIDATED]: 401,
  [CODE.USER_EXISTED]: 409,
  [CODE.METHOD_INVALID]: 405,
  [CODE.TOKEN_INVALID]: 401,
  [CODE.EXCEPTION_ERROR]: 500,
};

export class ApiError extends Error {
  code: number;
  httpStatus: number;

  constructor(code: number, message?: string, httpStatus?: number) {
    super(message ?? MESSAGE[code] ?? "Unknown error");
    this.code = code;
    this.httpStatus = httpStatus ?? DEFAULT_HTTP_STATUS[code] ?? 400;
  }
}
