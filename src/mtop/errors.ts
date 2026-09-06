// Taxonomy of the MTOP `ret[0]` string. The half before `::` is a stable code;
// the half after it is Chinese and never reaches the user.

export type RetKind =
  | "success"
  | "token" // absorb the new cookie, re-sign with a fresh `t`, retry
  | "session" // the login is gone; only the user can fix it
  | "traffic" // rate limit; back off
  | "captcha" // anti-bot verdict; stop and trip the breaker
  | "denied"
  | "unknown";

/** Codes the official SDK treats as the same "re-sign and retry" case. */
export const TOKEN_RET_CODES = [
  "FAIL_SYS_TOKEN_EMPTY",
  // The typo is Alibaba's, not ours.
  "FAIL_SYS_TOKEN_EXOIRED",
  "FAIL_SYS_ILLEGAL_ACCESS",
] as const;

const SESSION_RET_CODES = ["FAIL_SYS_SESSION_EXPIRED", "NEED_LOGIN", "FAIL_SYS_SID_INVALID"];

/** Human hints, pt-BR, keyed by ret code. Open map: unknown codes just get none. */
export const RET_HINTS: Record<string, string> = {
  FAIL_SYS_TRAFFIC_LIMIT: "limite de requisições; o cliente vai esperar e tentar de novo",
  FAIL_SYS_USER_VALIDATE: "desafio anti-bot",
  FAIL_SYS_ACCESS_DENIED: "sem permissão para esta API",
  UNKNOWN_FAIL_CODE: "parâmetro inválido ou erro interno do AliExpress",
};

/** `"FAIL_SYS_TOKEN_EMPTY::令牌为空"` → `"FAIL_SYS_TOKEN_EMPTY"`. */
export function retCodeOf(ret: string | undefined): string {
  return (ret ?? "").split("::")[0] ?? "";
}

export function classifyRet(ret: string | undefined): RetKind {
  const code = retCodeOf(ret);
  if (code === "SUCCESS") return "success";
  if ((TOKEN_RET_CODES as readonly string[]).includes(code)) return "token";
  if (SESSION_RET_CODES.includes(code)) return "session";
  if (code === "FAIL_SYS_TRAFFIC_LIMIT") return "traffic";
  if (code === "FAIL_SYS_USER_VALIDATE") return "captcha";
  if (code === "FAIL_SYS_ACCESS_DENIED") return "denied";
  return "unknown";
}

export const isTokenError = (ret: string | undefined): boolean => classifyRet(ret) === "token";
