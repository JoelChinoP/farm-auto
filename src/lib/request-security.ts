const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isAllowedApiMutation(input: {
  hostname: string;
  requestOrigin: string;
  origin: string | null;
  fetchSite: string | null;
  panelClient: string | null;
}) {
  return (
    localHosts.has(input.hostname) &&
    input.panelClient === "control-panel" &&
    (!input.origin || input.origin === input.requestOrigin) &&
    (!input.fetchSite || ["same-origin", "none"].includes(input.fetchSite))
  );
}
