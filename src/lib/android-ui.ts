export type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type AndroidNode = {
  id: number;
  attributes: Record<string, string>;
  parent: AndroidNode | null;
  children: AndroidNode[];
  bounds: Bounds | null;
};

export function decodeXmlEntities(value: string) {
  return value.replace(
    /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi,
    (entity, name: string) => {
      if (name.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      }
      if (name.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      }
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
        name.toLowerCase() as "amp" | "lt" | "gt" | "quot" | "apos"
      ];
    },
  );
}

export function parseBounds(value: string | undefined): Bounds | null {
  const match = value?.match(
    /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/,
  );
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function xmlTags(xml: string) {
  const tags: Array<{
    name: string;
    attributes: string;
    closing: boolean;
    selfClosing: boolean;
  }> = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end < 0) throw new Error("Comentario XML sin cerrar.");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end < 0) throw new Error("Declaración XML sin cerrar.");
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", start)) {
      throw new Error("Declaración XML no soportada.");
    }
    let quote = "";
    let end = start + 1;
    for (; end < xml.length; end++) {
      const character = xml[end];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (end >= xml.length || quote) throw new Error("Etiqueta XML sin cerrar.");
    const raw = xml.slice(start + 1, end).trim();
    const closing = raw.startsWith("/");
    const selfClosing = !closing && raw.endsWith("/");
    const body = raw
      .slice(closing ? 1 : 0, selfClosing ? -1 : undefined)
      .trim();
    const parsed = body.match(/^([\w.$:-]+)\b([\s\S]*)$/);
    if (!parsed) throw new Error("Etiqueta XML inválida.");
    tags.push({
      name: parsed[1],
      attributes: parsed[2],
      closing,
      selfClosing,
    });
    cursor = end + 1;
  }
  return tags;
}

export function parseAndroidHierarchy(xml: string) {
  if (!xml.includes("<hierarchy")) throw new Error("Jerarquía Android inválida.");
  const roots: AndroidNode[] = [];
  const stack: AndroidNode[] = [];
  const openTags: string[] = [];
  let hierarchySeen = false;
  for (const tag of xmlTags(xml)) {
    if (tag.closing) {
      if (openTags.pop() !== tag.name) throw new Error("Jerarquía Android desbalanceada.");
      if (tag.name !== "hierarchy" && !stack.pop()) {
        throw new Error("Jerarquía Android desbalanceada.");
      }
      continue;
    }
    if (tag.name === "hierarchy") {
      if (hierarchySeen || openTags.length || tag.selfClosing) {
        throw new Error("Jerarquía Android inválida.");
      }
      hierarchySeen = true;
      openTags.push(tag.name);
      continue;
    }
    if (openTags[0] !== "hierarchy") throw new Error("Nodo fuera de la jerarquía Android.");
    const attributes: Record<string, string> = {};
    for (const attribute of tag.attributes.matchAll(
      /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )) {
      attributes[attribute[1]] = decodeXmlEntities(attribute[2] ?? attribute[3] ?? "");
    }
    if (
      tag.attributes
        .replace(/([\w:-]+)\s*=\s*(?:"[^"]*"|'[^']*')/g, "")
        .trim()
    ) {
      throw new Error("Atributos Android inválidos.");
    }
    attributes.class ||= tag.name === "node" ? "" : tag.name;
    const parent = stack.at(-1) ?? null;
    const node: AndroidNode = {
      id: 0,
      attributes,
      parent,
      children: [],
      bounds: parseBounds(attributes.bounds),
    };
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (!tag.selfClosing) {
      openTags.push(tag.name);
      stack.push(node);
    }
  }
  if (!hierarchySeen || openTags.length || stack.length) {
    throw new Error("Jerarquía Android desbalanceada.");
  }
  let id = 0;
  for (const node of flattenAndroidNodes(roots)) node.id = id++;
  return roots;
}

export function flattenAndroidNodes(nodes: AndroidNode[]): AndroidNode[] {
  const flattened: AndroidNode[] = [];
  const visit = (node: AndroidNode) => {
    flattened.push(node);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return flattened;
}

export function normalizeAccessibleText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function nodeLabel(node: AndroidNode) {
  return normalizeAccessibleText(
    [node.attributes.text, node.attributes["content-desc"], node.attributes.hint]
      .filter(Boolean)
      .join(" "),
  );
}

export function subtreeNodes(node: AndroidNode) {
  return flattenAndroidNodes([node]);
}
