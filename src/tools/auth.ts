import { Type } from "@sinclair/typebox";
import { AuthError, CaptchaError } from "../core/errors.js";
import { timeZoneParam } from "../mtop/client.js";
import { listOrders } from "../ultron/parse.js";
import type { UltronResponse } from "../ultron/types.js";
import { compactObject, defineTool } from "./define.js";

// Session diagnostics. Free by default: it reads the local session file and
// says nothing that could not be derived from it. `verify: true` spends exactly
// one request — `order.count` is the cheapest authenticated endpoint.

export type AuthStatus = {
  loggedIn: boolean;
  verified?: boolean;
  error?: string;
  sessionFile: string;
  cookieCount: number;
  httpOnlyCount: number;
  savedAt: string | null;
  ageDays: number | null;
  soonestExpiry: string | null;
  region: string | null;
  locale: string | null;
  currency: string | null;
  memberId: string | null;
  breaker: "ok" | "tripped";
  cooldownUntil: string | null;
  /** Orders on the first page of the real list — proof the session is live. */
  firstPageOrders?: number;
  hasMore?: boolean;
  hint?: string;
};

export const authStatus = defineTool({
  name: "auth_status",
  description:
    "Diz se há uma sessão do AliExpress salva e o que ela cobre (região, idioma, moeda, validade dos " +
    "cookies). Não usa a rede por padrão. Com verify=true gasta 1 requisição para confirmar que o " +
    "AliExpress ainda aceita a sessão. Comece por aqui quando outra tool reclamar de sessão.",
  readOnly: true,
  input: Type.Object({
    verify: Type.Optional(
      Type.Boolean({
        description: "Também faz 1 chamada ao AliExpress para confirmar que a sessão é aceita",
      }),
    ),
  }),
  run: async (args, ctx): Promise<AuthStatus> => {
    const { session, http, config } = ctx;
    let data: ReturnType<typeof session.load> = null;
    let loadError: string | undefined;
    try {
      data = session.load();
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }

    const cookies = data?.cookies ?? [];
    const expiries = cookies.filter((cookie) => cookie.expires > 0).map((cookie) => cookie.expires);
    const cooldown = http.cooldownUntil();
    const base: AuthStatus = {
      loggedIn: data !== null,
      sessionFile: config.sessionPath,
      cookieCount: cookies.length,
      httpOnlyCount: cookies.filter((cookie) => cookie.httpOnly).length,
      savedAt: data ? new Date(data.savedAt).toISOString() : null,
      ageDays: data ? Math.floor((ctx.now() - data.savedAt) / 86_400_000) : null,
      soonestExpiry:
        expiries.length > 0 ? new Date(Math.min(...expiries) * 1000).toISOString() : null,
      region: data?.regional.region ?? null,
      locale: data?.regional.locale ?? null,
      currency: data?.regional.currency ?? null,
      memberId: data?.regional.memberId ?? null,
      breaker: http.state().tripped ? "tripped" : "ok",
      cooldownUntil: cooldown === null ? null : new Date(cooldown).toISOString(),
    };

    if (loadError) {
      return compactObject({ ...base, loggedIn: false, error: loadError });
    }
    if (data === null) {
      return compactObject({
        ...base,
        hint: "Nenhuma sessão salva. Rode `aliexpress login`.",
      });
    }
    if (!args.verify) return compactObject(base);

    try {
      // NOT `order.count`: it answers SUCCESS with zeros to an unauthenticated
      // caller, so it proves nothing (observed 2026-09-07). `order.list` is the
      // cheapest endpoint that actually answers FAIL_SYS_SESSION_EXPIRED.
      const response = await ctx.mtop.request<UltronResponse>({
        api: "mtop.aliexpress.trade.buyer.order.list",
        data: {
          statusTab: "all",
          renderType: "init",
          clientPlatform: "pc",
          timeZone: timeZoneParam(new Date(ctx.now())),
        },
      });
      const page = response.data;
      return compactObject({
        ...base,
        verified: true,
        firstPageOrders: listOrders(page).length,
        hasMore: page?.data ? Boolean(fieldsHasMore(page)) : undefined,
      });
    } catch (error) {
      // An expired session or an anti-bot verdict is a *status*, not a crash:
      // this tool exists to report exactly that.
      if (error instanceof AuthError || error instanceof CaptchaError) {
        return compactObject({
          ...base,
          loggedIn: false,
          verified: false,
          breaker: http.state().tripped ? "tripped" : base.breaker,
          error: error.message,
        });
      }
      throw error;
    }
  },
});

function fieldsHasMore(page: UltronResponse): boolean {
  for (const component of Object.values(page.data ?? {})) {
    if (component.tag === "pc_om_list_body") return component.fields.hasMore === true;
  }
  return false;
}
