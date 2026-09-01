import {
  activateAndOpenUrl,
  clickBounds,
  doubleTap,
  wait,
  waitForElement,
  waitForForegroundPackage,
} from "./android-actions.ts";
import type { AndroidDriver } from "./appium.ts";
import {
  flattenAndroidNodes,
  nodeLabel,
  normalizeAccessibleText,
  parseAndroidHierarchy,
  subtreeNodes,
} from "./android-ui.ts";
import type { AndroidNode, Bounds } from "./android-ui.ts";
import { AppError } from "./errors.ts";

export const TIKTOK_PACKAGE = "com.zhiliaoapp.musically";

const composerSelector =
  "//*[@class='android.widget.EditText' and (@clickable='true' or @focusable='true')]";
const sendSelector =
  "//*[contains(@content-desc,'Post comment') or contains(@content-desc,'Publicar comentario') or contains(@content-desc,'Enviar comentario') or @text='Post' or @text='Publicar' or @text='Enviar']";

function visibleNodes(node: AndroidNode) {
  return subtreeNodes(node).filter(
    (item) =>
      item.attributes.package === TIKTOK_PACKAGE &&
      item.attributes.displayed !== "false",
  );
}

function phraseMatches(nodes: AndroidNode[], marker: string) {
  const expected = normalizeAccessibleText(marker);
  const visible = nodes
    .map(nodeLabel)
    .filter(Boolean)
    .join(" ");
  return Boolean(expected && ` ${visible} `.includes(` ${expected} `));
}

function targetWords(targetMarker: string, requirePhrase = true) {
  const words = normalizeAccessibleText(targetMarker).split(" ").filter(Boolean);
  if ((requirePhrase && words.length < 3) || !words.length) {
    throw new AppError(
      "No hay un marcador suficiente para verificar el contenido de TikTok.",
      409,
      "TIKTOK_TARGET_NOT_VERIFIED",
    );
  }
  return words.join(" ");
}

function isLike(node: AndroidNode) {
  return Boolean(
    node.bounds &&
      node.attributes.enabled !== "false" &&
      /(^| )(like|me gusta|unlike|ya no me gusta)( |$)/.test(nodeLabel(node)),
  );
}

function isComment(node: AndroidNode) {
  return Boolean(
    node.bounds &&
      node.attributes.enabled !== "false" &&
      !/EditText|AutoCompleteTextView|TextView/.test(
        node.attributes.class ?? "",
      ) &&
      /(^| )(comment|comments|comentario|comentarios)( |$)/.test(nodeLabel(node)),
  );
}

function area(bounds: Bounds) {
  return (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
}

function locateTikTokTarget(xml: string, targetMarker: string) {
  const marker = targetWords(targetMarker);
  const all = flattenAndroidNodes(parseAndroidHierarchy(xml)).filter(
    (node) =>
      node.attributes.package === TIKTOK_PACKAGE &&
      node.attributes.displayed !== "false",
  );
  const candidates = all.flatMap((container) => {
    if (
      !container.parent ||
      !container.bounds ||
      container.attributes.scrollable === "true"
    ) {
      return [];
    }
    const nodes = visibleNodes(container);
    const likes = nodes.filter(isLike);
    const comments = nodes.filter(isComment);
    if (!phraseMatches(nodes, marker) || likes.length !== 1 || comments.length !== 1) {
      return [];
    }
    return [{
      containerBounds: container.bounds,
      commentBounds: comments[0].bounds!,
      alreadyLiked:
        likes[0].attributes.selected === "true" ||
        likes[0].attributes.checked === "true" ||
        /(^| )(unlike|ya no me gusta)( |$)/.test(nodeLabel(likes[0])),
    }];
  });
  const minimumArea = Math.min(...candidates.map((candidate) => area(candidate.containerBounds)));
  const smallest = candidates.filter(
    (candidate) => area(candidate.containerBounds) === minimumArea,
  );
  const unique = new Map(
    smallest.map((candidate) => [
      `${JSON.stringify(candidate.containerBounds)}\0${JSON.stringify(candidate.commentBounds)}`,
      candidate,
    ]),
  );
  if (unique.size !== 1) {
    throw new AppError(
      "TikTok no expuso inequívocamente el contenido objetivo.",
      409,
      "TIKTOK_TARGET_NOT_VERIFIED",
    );
  }
  return [...unique.values()][0];
}

function assertTikTokLiveTarget(
  xml: string,
  handle: string,
  point: { x: number; y: number },
) {
  const marker = targetWords(handle, false);
  const candidates = flattenAndroidNodes(parseAndroidHierarchy(xml)).filter((container) => {
    if (
      !container.parent ||
      !container.bounds ||
      container.attributes.scrollable === "true"
    ) {
      return false;
    }
    const nodes = visibleNodes(container);
    const identity = nodes.some((node) => {
      const label = nodeLabel(node);
      return phraseMatches([node], marker) && /(^| )(live|en vivo)( |$)/.test(label);
    });
    return (
      identity &&
      point.x >= container.bounds.left &&
      point.x <= container.bounds.right &&
      point.y >= container.bounds.top &&
      point.y <= container.bounds.bottom
    );
  });
  if (!candidates.length) {
    throw new AppError(
      "TikTok no expuso inequívocamente el Live objetivo.",
      409,
      "TIKTOK_TARGET_NOT_VERIFIED",
    );
  }
  const minimumArea = Math.min(...candidates.map((node) => area(node.bounds!)));
  if (candidates.filter((node) => area(node.bounds!) === minimumArea).length !== 1) {
    throw new AppError(
      "TikTok expuso más de un Live compatible con el objetivo.",
      409,
      "TIKTOK_TARGET_NOT_VERIFIED",
    );
  }
}

function liveHandle(url: string) {
  try {
    return new URL(url).pathname
      .split("/")
      .find((segment) => segment.startsWith("@"))
      ?.slice(1) ?? null;
  } catch {
    return null;
  }
}

function isPublishedCommentVisible(xml: string, commentText: string) {
  const expected = normalizeAccessibleText(commentText);
  const nodes = flattenAndroidNodes(parseAndroidHierarchy(xml)).filter(
    (node) =>
      node.attributes.package === TIKTOK_PACKAGE &&
      node.attributes.displayed !== "false",
  );
  const composer = nodes.find((node) =>
    /EditText|AutoCompleteTextView/.test(node.attributes.class ?? ""),
  );
  return (
    nodes.some(
      (node) =>
        !/EditText|AutoCompleteTextView/.test(node.attributes.class ?? "") &&
        nodeLabel(node) === expected,
    ) &&
    (!composer || normalizeAccessibleText(composer.attributes.text ?? "") === "")
  );
}

export async function runTikTokLive(
  driver: AndroidDriver,
  input: { url: string; tapRounds: number; tapX: number; tapY: number },
  signal: AbortSignal,
  checkpoint: () => void = () => undefined,
) {
  await activateAndOpenUrl(driver, TIKTOK_PACKAGE, input.url);
  await waitForForegroundPackage(driver, TIKTOK_PACKAGE, 15_000, signal);
  const handle = liveHandle(input.url);
  if (!handle) {
    throw new AppError(
      "El enlace Live debe incluir el @usuario para verificar el objetivo.",
      409,
      "TIKTOK_TARGET_NOT_VERIFIED",
    );
  }
  assertTikTokLiveTarget(await driver.getPageSource(), handle, {
    x: input.tapX,
    y: input.tapY,
  });
  for (let round = 0; round < input.tapRounds; round++) {
    signal.throwIfAborted();
    assertTikTokLiveTarget(await driver.getPageSource(), handle, {
      x: input.tapX,
      y: input.tapY,
    });
    checkpoint();
    await doubleTap(driver, input.tapX, input.tapY);
    if (round + 1 < input.tapRounds) await wait(400, signal);
  }
}

export async function runTikTokPost(
  driver: AndroidDriver,
  input: { url: string; commentText: string; targetMarker: string },
  signal: AbortSignal,
  checkpoint: (effect: "like" | "comment") => void,
) {
  await activateAndOpenUrl(driver, TIKTOK_PACKAGE, input.url);
  await waitForForegroundPackage(driver, TIKTOK_PACKAGE, 15_000, signal);
  let target = locateTikTokTarget(await driver.getPageSource(), input.targetMarker);

  if (!target.alreadyLiked) {
    checkpoint("like");
    await doubleTap(
      driver,
      Math.round((target.containerBounds.left + target.containerBounds.right) / 2),
      Math.round((target.containerBounds.top + target.containerBounds.bottom) / 2),
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      await wait(500, signal);
      target = locateTikTokTarget(await driver.getPageSource(), input.targetMarker);
      if (target.alreadyLiked) break;
    }
    if (!target.alreadyLiked) {
      throw new AppError(
        "No se pudo verificar el like aplicado en TikTok.",
        502,
        "LIKE_OUTCOME_UNKNOWN",
      );
    }
  }

  await clickBounds(driver, target.commentBounds);
  const composer = await waitForElement(driver, composerSelector, 10_000, signal);
  if (isPublishedCommentVisible(await driver.getPageSource(), input.commentText)) {
    throw new AppError(
      "El comentario generado ya estaba visible antes del envío.",
      409,
      "COMMENT_ALREADY_PRESENT",
    );
  }
  await composer.setValue(input.commentText);
  if ((await composer.getValue()).trim() !== input.commentText) {
    throw new AppError(
      "TikTok no conservó el comentario generado en el compositor.",
      502,
      "COMMENT_NOT_READY",
    );
  }

  const send = await waitForElement(driver, sendSelector, 10_000, signal);
  checkpoint("comment");
  await send.click();

  for (let attempt = 0; attempt < 5; attempt++) {
    await wait(1_000, signal);
    if (isPublishedCommentVisible(await driver.getPageSource(), input.commentText)) {
      return;
    }
  }
  throw new AppError(
    "No se pudo verificar el comentario publicado en TikTok.",
    502,
    "COMMENT_DELIVERY_UNKNOWN",
  );
}
