import { NextRequest, NextResponse } from "next/server";

import { isAllowedApiMutation } from "@/lib/request-security";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function proxy(request: NextRequest) {
  if (safeMethods.has(request.method)) return NextResponse.next();

  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const panelClient = request.headers.get("x-genfarmer-client");
  const requestHost = request.headers.get("host") || request.nextUrl.host;
  const hostname = requestHost.startsWith("[")
    ? requestHost.slice(0, requestHost.indexOf("]") + 1)
    : requestHost.split(":", 1)[0];
  if (!isAllowedApiMutation({
    hostname,
    requestOrigin: `${request.nextUrl.protocol}//${requestHost}`,
    origin,
    fetchSite,
    panelClient,
  })) {
    return NextResponse.json(
      {
        success: false,
        code: "CROSS_ORIGIN_REQUEST",
        message: "El panel solo acepta acciones desde su origen local.",
      },
      { status: 403 },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
