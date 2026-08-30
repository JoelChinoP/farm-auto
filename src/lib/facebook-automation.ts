import {
  activateAndOpenUrl,
  clickBounds,
  swipeUp,
  wait,
  waitForForegroundPackage,
} from "./android-actions.ts";
import type { AndroidDriver } from "./appium.ts";
import type { AndroidNode, Bounds } from "./android-ui.ts";
import {
  flattenAndroidNodes,
  nodeLabel,
  normalizeAccessibleText,
  parseAndroidHierarchy,
  subtreeNodes,
} from "./android-ui.ts";
import { AppError } from "./errors.ts";

export const FACEBOOK_PACKAGE = "com.facebook.katana";

function orderedMarkerMatch(nodes: AndroidNode[], marker: string) {
  const expected = normalizeAccessibleText(marker);
  return Boolean(
    expected &&
      nodes.some((node) => ` ${nodeLabel(node)} `.includes(` ${expected} `)),
  );
}

function isScrollable(node: AndroidNode) {
  return (
    node.attributes.scrollable === "true" ||
    /RecyclerView|ListView|ScrollView/.test(node.attributes.class ?? "")
  );
}

function isLike(node: AndroidNode) {
  const label = nodeLabel(node);
  return Boolean(
    node.bounds &&
      node.attributes.enabled !== "false" &&
      /(^| )(me gusta|ya no me gusta|like|liked|unlike)( |$)/.test(label),
  );
}

function isCommentControl(node: AndroidNode) {
  const label = nodeLabel(node);
  return Boolean(
    node.bounds &&
      node.attributes.enabled !== "false" &&
      /(^| )(comentar|comentario|comment)( |$)/.test(label),
  );
}

function eligibleContainer(node: AndroidNode, screenHeight: number) {
  if (!node.bounds || !node.parent || isScrollable(node)) return false;
  return node.bounds.bottom - node.bounds.top < screenHeight * 0.9;
}

function sameBounds(left: Bounds | null, right: Bounds) {
  return Boolean(
    left &&
      left.left === right.left &&
      left.top === right.top &&
      left.right === right.right &&
      left.bottom === right.bottom,
  );
}

export function locateFacebookTarget(xml: string, targetMarker: string) {
  const marker = normalizeAccessibleText(targetMarker);
  if (marker.length < 12 || marker.split(" ").length < 3) {
    throw new Error("Marcador objetivo inválido.");
  }
  const roots = parseAndroidHierarchy(xml);
  const all = flattenAndroidNodes(roots).filter(
    (node) =>
      node.attributes.package === FACEBOOK_PACKAGE &&
      node.attributes.displayed !== "false",
  );
  const screenHeight = Math.max(...all.map((node) => node.bounds?.bottom ?? 0), 1);
  const candidates = all.flatMap((container) => {
    if (
      !eligibleContainer(container, screenHeight) ||
      !container.parent ||
      !isScrollable(container.parent)
    ) {
      return [];
    }
    const nodes = subtreeNodes(container).filter(
      (node) =>
        node.attributes.package === FACEBOOK_PACKAGE &&
        node.attributes.displayed !== "false",
    );
    const likes = nodes.filter(isLike);
    const comments = nodes.filter(isCommentControl);
    if (!orderedMarkerMatch(nodes, marker) || likes.length !== 1 || comments.length !== 1) {
      return [];
    }
    return [{ container, like: likes[0], comment: comments[0] }];
  });
  const smallest = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate && other.container.parent === candidate.container,
      ),
  );
  const unique = new Map(
    smallest.map((candidate) => [
      `${candidate.like.attributes.bounds}\0${candidate.comment.attributes.bounds}`,
      candidate,
    ]),
  );
  if (unique.size !== 1) {
    throw new Error("No se identificó un único contenedor de publicación objetivo.");
  }
  const target = [...unique.values()][0];
  return {
    containerBounds: target.container.bounds!,
    likeBounds: target.like.bounds!,
    commentBounds: target.comment.bounds!,
    alreadyLiked:
      target.like.attributes.selected === "true" ||
      target.like.attributes.checked === "true" ||
      /(^| )(unlike|liked|ya no me gusta)( |$)/.test(nodeLabel(target.like)),
  };
}

function locateThread(
  xml: string,
  targetMarker: string,
  targetBounds: Bounds,
  commentText?: string,
) {
  const expected = commentText ? normalizeAccessibleText(commentText) : null;
  const all = flattenAndroidNodes(parseAndroidHierarchy(xml)).filter(
    (node) =>
      node.attributes.package === FACEBOOK_PACKAGE &&
      node.attributes.displayed !== "false",
  );
  const candidates = all.flatMap((container) => {
    if (!sameBounds(container.bounds, targetBounds)) return [];
    const nodes = subtreeNodes(container).filter(
      (node) =>
        node.attributes.package === FACEBOOK_PACKAGE &&
        node.attributes.displayed !== "false",
    );
    if (!container.parent || isScrollable(container) || !orderedMarkerMatch(nodes, targetMarker)) {
      return [];
    }
    const composers = nodes.filter(
      (node) =>
        node.bounds &&
        /EditText|AutoCompleteTextView/.test(node.attributes.class ?? "") &&
        node.attributes.focusable !== "false" &&
        /(comment|coment|escribe|write)/.test(nodeLabel(node)),
    );
    if (composers.length !== 1) return [];
    const sends = nodes.filter((node) => {
      const labels = [
        node.attributes.text,
        node.attributes["content-desc"],
      ].map((value) => normalizeAccessibleText(value ?? ""));
      return Boolean(
        node.bounds &&
          node.attributes.enabled !== "false" &&
          labels.some((label) =>
            /^(post comment|send comment|enviar comentario|publicar comentario|send|enviar|post|publicar)$/.test(
              label,
            ),
          ),
      );
    });
    const published = expected
      ? nodes.filter(
          (node) =>
            node.attributes.class === "android.widget.TextView" &&
            normalizeAccessibleText(node.attributes.text || node.attributes["content-desc"] || "") ===
              expected,
        )
      : [];
    return [{ container, composer: composers[0], sends, published }];
  });
  const smallest = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) => other !== candidate && other.container.parent === candidate.container,
      ),
  );
  const unique = new Map(
    smallest.map((candidate) => [candidate.composer.attributes.bounds, candidate]),
  );
  if (unique.size !== 1) throw new Error("No se identificó un único hilo objetivo.");
  return [...unique.values()][0];
}

export function verifyFacebookDelivery(
  xml: string,
  targetMarker: string,
  targetBounds: Bounds,
  commentText: string,
) {
  const thread = locateThread(xml, targetMarker, targetBounds, commentText);
  return (
    thread.published.length === 1 &&
    normalizeAccessibleText(thread.composer.attributes.text ?? "") === ""
  );
}

export async function runFacebookPost(
  driver: AndroidDriver,
  input: { url: string; commentText: string; targetMarker: string },
  signal: AbortSignal,
  checkpoint: (effect: "like" | "comment") => void,
) {
  await activateAndOpenUrl(driver, FACEBOOK_PACKAGE, input.url, true);
  await waitForForegroundPackage(driver, FACEBOOK_PACKAGE, 20_000, signal);

  let target: ReturnType<typeof locateFacebookTarget> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      target = locateFacebookTarget(await driver.getPageSource(), input.targetMarker);
      break;
    } catch {
      if (attempt === 2) break;
      await swipeUp(driver);
      await wait(750, signal);
    }
  }
  if (!target) {
    throw new AppError(
      "Facebook no expuso inequívocamente la publicación objetivo.",
      409,
      "FACEBOOK_TARGET_NOT_VERIFIED",
    );
  }

  if (!target.alreadyLiked) {
    checkpoint("like");
    await clickBounds(driver, target.likeBounds);
    for (let attempt = 0; attempt < 5; attempt++) {
      await wait(500, signal);
      const updated = locateFacebookTarget(
        await driver.getPageSource(),
        input.targetMarker,
      );
      if (updated.alreadyLiked) {
        target = updated;
        break;
      }
    }
    if (!target.alreadyLiked) {
      throw new AppError(
        "No se pudo verificar el like aplicado en Facebook.",
        502,
        "LIKE_OUTCOME_UNKNOWN",
      );
    }
  }
  await clickBounds(driver, target.commentBounds);

  let thread: ReturnType<typeof locateThread> | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await wait(500, signal);
    try {
      thread = locateThread(
        await driver.getPageSource(),
        input.targetMarker,
        target.containerBounds,
      );
      break;
    } catch {
      // The comment surface may still be opening.
    }
  }
  if (!thread) {
    throw new AppError(
      "Facebook no expuso un único compositor asociado al objetivo.",
      409,
      "FACEBOOK_TARGET_NOT_VERIFIED",
    );
  }
  const composer = await driver.$(`//*[@bounds='${thread.composer.attributes.bounds}']`);
  await composer.setValue(input.commentText);
  if ((await composer.getValue()).trim() !== input.commentText) {
    throw new AppError(
      "Facebook no conservó el comentario aprobado en el compositor.",
      502,
      "COMMENT_NOT_READY",
    );
  }

  let readyThread: ReturnType<typeof locateThread> | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await wait(250, signal);
    try {
      const updated = locateThread(
        await driver.getPageSource(),
        input.targetMarker,
        target.containerBounds,
        input.commentText,
      );
      if (updated.published.length) {
        throw new AppError(
          "El comentario aprobado ya estaba visible antes del envío.",
          409,
          "COMMENT_ALREADY_PRESENT",
        );
      }
      if (updated.sends.length === 1) {
        readyThread = updated;
        break;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
    }
  }
  if (!readyThread) {
    throw new AppError(
      "Facebook no expuso un único botón de envío asociado al objetivo.",
      409,
      "FACEBOOK_TARGET_NOT_VERIFIED",
    );
  }
  checkpoint("comment");
  await clickBounds(driver, readyThread.sends[0].bounds!);
  for (let attempt = 0; attempt < 5; attempt++) {
    await wait(1_000, signal);
    try {
      if (
        verifyFacebookDelivery(
          await driver.getPageSource(),
          input.targetMarker,
          target.containerBounds,
          input.commentText,
        )
      ) {
        return;
      }
    } catch {
      // Keep waiting for the same thread to expose the confirmed comment.
    }
  }
  throw new AppError(
    "No se pudo verificar el comentario publicado en Facebook.",
    502,
    "COMMENT_DELIVERY_UNKNOWN",
  );
}
