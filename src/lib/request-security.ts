export const PANEL_CLIENT_HEADER = "x-control-panel-client";
export const PANEL_CLIENT_ID = "control-panel";

function isLoopback(hostname: string) {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname.toLowerCase());
}

function isLocalHttpUrl(url: URL) {
  return isLoopback(url.hostname)
    && ["http:", "https:"].includes(url.protocol)
    && !url.username
    && !url.password;
}

export function validateMutationRequest(request: Request) {
  const url = new URL(request.url);
  if (!isLocalHttpUrl(url)) {
    return { code: "LOOPBACK_REQUIRED", message: "Las mutaciones solo se aceptan desde loopback." };
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!isLocalHttpUrl(new URL(origin))) throw new Error();
    } catch {
      return { code: "INVALID_ORIGIN", message: "El origen del panel no es local." };
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite.toLowerCase())) {
    return { code: "INVALID_FETCH_SITE", message: "La mutacion no proviene del mismo origen." };
  }

  if (request.headers.get(PANEL_CLIENT_HEADER) !== PANEL_CLIENT_ID) {
    return { code: "PANEL_CLIENT_REQUIRED", message: "Falta el identificador del cliente del panel." };
  }
  return null;
}
