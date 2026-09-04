export function apiSuccess<T>(data: T, status = 200) {
  return Response.json({ success: true as const, data }, { status });
}

export function apiError(
  code: string,
  message: string,
  status = 400,
  details: Record<string, unknown> = {},
) {
  return Response.json({ success: false as const, code, message, details }, { status });
}
