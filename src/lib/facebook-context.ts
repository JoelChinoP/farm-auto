const ignoredLabels = new Set(
  [
    "facebook",
    "like",
    "me gusta",
    "comment",
    "comentar",
    "share",
    "compartir",
    "send",
    "enviar",
    "post",
    "publicar",
    "write a comment",
    "escribe un comentario",
    "see more",
    "ver más",
    "ver mas",
    "back",
    "atrás",
    "atras",
    "close",
    "cerrar",
    "not now",
    "ahora no",
    "add friend",
    "add as friend",
    "añadir como amigo(a)",
    "agregar como amigo(a)",
  ].map((value) => value.toLocaleLowerCase("es")),
);

const ignoredFragments = [
  "añádelo como amigo para que sea aún más fácil compartir contenido",
  "add them as a friend to make sharing content even easier",
];

const contextBoundaries = new Set(["detalles del reel", "reel details"]);

function decodeXml(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

export function extractAccessibleFacebookContext(xml: string, maxLength = 1200) {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const node of xml.matchAll(/<node\b[^>]*>/g)) {
    const attributes = node[0];
    const packageName = attributes.match(/\bpackage="([^"]*)"/)?.[1];
    if (packageName && packageName !== "com.facebook.katana") continue;
    for (const match of attributes.matchAll(/(?:text|content-desc)="([^"]*)"/g)) {
      const value = decodeXml(match[1]).replace(/\s+/g, " ").trim();
      const normalized = value.toLocaleLowerCase("es");
      if (
        value.length < 2 ||
        ignoredLabels.has(normalized) ||
        ignoredFragments.some((fragment) => normalized.includes(fragment)) ||
        seen.has(normalized)
      ) {
        continue;
      }
      seen.add(normalized);
      values.push(value);
    }
  }

  let context = "";
  for (const value of values) {
    if (contextBoundaries.has(value.toLocaleLowerCase("es"))) break;
    const candidate = context ? `${context}\n${value}` : value;
    if (candidate.length > maxLength) {
      if (!context) context = value.slice(0, maxLength).trim();
      break;
    }
    context = candidate;
  }
  return context;
}

export function findStoredFacebookContext(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const context = findStoredFacebookContext(item);
      if (context) return context;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (
    record.outputType === "facebook-context-v1" &&
    typeof record.context === "string"
  ) {
    const context = record.context.trim();
    return context.length <= 1200 ? context : null;
  }
  for (const item of Object.values(record)) {
    const context = findStoredFacebookContext(item);
    if (context) return context;
  }
  return null;
}
