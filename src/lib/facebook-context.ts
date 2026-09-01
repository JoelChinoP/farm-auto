const boilerplateFragments = [
  "create an account or log into facebook",
  "facebook helps you connect and share",
  "inicia sesión en facebook",
  "log into facebook",
  "see posts, photos and more on facebook",
  "regístrate o inicia sesión en facebook",
];

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function buildFacebookTargetMarker(value: string) {
  const canonical = normalize(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const segments = canonical.split(/\b(?:ver mas|see more)\b/);
  const relevant = segments.at(-1) || canonical;
  const headline = relevant
    .split(/[.!?]/)
    .find((segment) => segment.replace(/[^a-z0-9]+/g, " ").trim().length >= 12);
  const normalized = (headline || relevant)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const words: string[] = [];
  let meaningfulWords = 0;
  for (const word of normalized.split(" ").filter(Boolean)) {
    words.push(word);
    if (word.length > 1) meaningfulWords++;
    if (meaningfulWords === 6) break;
  }
  const marker = words.join(" ").slice(0, 80).trim();
  return meaningfulWords >= 3 && marker.length >= 12 ? marker : null;
}

function uniqueUseful(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawValue of values) {
    const value = normalize(rawValue);
    const key = value.toLocaleLowerCase("es");
    if (
      value.length < 3 ||
      seen.has(key) ||
      boilerplateFragments.some((fragment) => key.includes(fragment))
    ) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function buildFacebookPostDescription(
  input: {
    messages: string[];
    metadata?: string;
  },
  maxLength = 1_200,
) {
  const messages = uniqueUseful(input.messages);
  const values = messages.length
    ? messages
    : uniqueUseful(input.metadata ? [input.metadata] : []);

  let source = "";
  for (const value of uniqueUseful(values)) {
    const candidate = source ? `${source}\n${value}` : value;
    if (candidate.length > maxLength) {
      if (!source) source = value.slice(0, maxLength).trim();
      break;
    }
    source = candidate;
  }
  return source;
}
