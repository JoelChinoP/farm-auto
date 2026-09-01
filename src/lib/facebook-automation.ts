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
import { buildFacebookPostDescription } from "./facebook-context.ts";
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
      /^(?:(?:boton|button) )?(?:me gusta|ya no me gusta|like|liked|unlike)(?:$| (?:boton|button)$| toca )/.test(
        label,
      ),
  );
}

function isCommentControl(node: AndroidNode) {
  const label = nodeLabel(node);
  return Boolean(
    node.bounds &&
      node.attributes.enabled !== "false" &&
      /^(?:(?:boton|button) )?(?:comentar|comentario|comment)(?:$| (?:boton|button)$)/.test(
        label,
      ),
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

function preferredControls(
  nodes: AndroidNode[],
  predicate: (node: AndroidNode) => boolean,
) {
  const controls = nodes.filter(predicate);
  const clickable = controls.filter((node) => node.attributes.clickable === "true");
  return clickable.length ? clickable : controls;
}

function facebookPostCandidates(xml: string) {
  const all = flattenAndroidNodes(parseAndroidHierarchy(xml)).filter(
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
    const likes = preferredControls(nodes, isLike);
    const comments = preferredControls(nodes, isCommentControl);
    return likes.length === 1 && comments.length === 1
      ? [{ container, nodes, like: likes[0], comment: comments[0] }]
      : [];
  });
  const smallest = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate && other.container.parent === candidate.container,
      ),
  );
  return new Map(
    smallest.map((candidate) => [
      `${candidate.like.attributes.bounds}\0${candidate.comment.attributes.bounds}`,
      candidate,
    ]),
  );
}

export function locateFacebookTarget(xml: string, targetMarker: string) {
  const marker = normalizeAccessibleText(targetMarker);
  if (marker.length < 12 || marker.split(" ").length < 3) {
    throw new Error("Marcador objetivo inválido.");
  }
  const unique = new Map(
    [...facebookPostCandidates(xml)].filter(([, candidate]) =>
      orderedMarkerMatch(candidate.nodes, marker),
    ),
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

const ignoredDescription = /^(?:me gusta|ya no me gusta|like|liked|unlike|comentar|comentario|comment|compartir|share|enviar|send|seguir|follow|publico|public|patrocinado|sponsored|ver mas|see more)$/;

export function extractFacebookDescriptionFromHierarchy(xml: string) {
  const all = flattenAndroidNodes(parseAndroidHierarchy(xml)).filter(
    (node) =>
      node.attributes.package === FACEBOOK_PACKAGE &&
      node.attributes.displayed !== "false",
  );
  const screenText = all.map(nodeLabel).join(" ");
  if (
    /(?:inicia sesion|iniciar sesion|log in|create new account|crear cuenta nueva|checkpoint)/.test(
      screenText,
    )
  ) {
    throw new AppError(
      "Facebook requiere iniciar sesión en la aplicación móvil.",
      409,
      "FACEBOOK_LOGIN_REQUIRED",
    );
  }
  const videoDescriptions = new Set(
    all
      .filter((node) =>
        /^(?:detalles del reel|detalles del video|detalles de la pestana (?:reels?|video)|reel details|video details)$/.test(
          nodeLabel(node),
        ),
      )
      .map((node) => node.parent?.attributes["content-desc"]?.trim() ?? "")
      .filter((value) => value.length >= 5),
  );
  if (videoDescriptions.size > 1) {
    throw new Error("No se identificó un único Reel visible para extraer.");
  }
  if (videoDescriptions.size === 1) {
    const description = buildFacebookPostDescription({
      messages: [[...videoDescriptions][0]],
    });
    if (description.length < 5) {
      throw new Error("Facebook no expuso una descripción visible del Reel.");
    }
    return description;
  }
  const candidates = facebookPostCandidates(xml);
  if (candidates.size !== 1) {
    throw new Error("No se identificó una única publicación visible para extraer.");
  }
  const target = [...candidates.values()][0];
  const actionTop = Math.min(target.like.bounds!.top, target.comment.bounds!.top);
  const values = target.nodes
    .flatMap((node) => {
      const className = node.attributes.class ?? "";
      if (
        !node.bounds ||
        node.bounds.top < target.container.bounds!.top ||
        node.bounds.bottom > actionTop ||
        !/(?:TextView|android\.view\.View)$/.test(className) ||
        /(?:Button|EditText|ImageView)/.test(className) ||
        node.attributes.clickable === "true"
      ) {
        return [];
      }
      const value = (node.attributes.text || node.attributes["content-desc"] || "")
        .replace(/\s+/g, " ")
        .trim();
      const normalized = normalizeAccessibleText(value);
      if (
        value.length < 5 ||
        ignoredDescription.test(normalized) ||
        /^(?:\d+[hmsd]|\d+\s*(?:reacciones?|reactions?|comentarios?|comments?|veces compartido|shares?|visualizaciones?|views?))$/.test(
          normalized,
        )
      ) {
        return [];
      }
      return [value];
    })
    .filter((value, index, allValues) => allValues.indexOf(value) === index)
    .sort((left, right) => right.length - left.length);
  const description = buildFacebookPostDescription({
    messages: values.slice(0, 1),
  });
  if (description.length < 5) {
    throw new Error("Facebook no expuso una descripción visible de la publicación.");
  }
  return description;
}

export async function readFacebookPostDescription(
  driver: AndroidDriver,
  url: string,
  signal: AbortSignal,
) {
  const targetUrl = new URL(url);
  if (["web.facebook.com", "m.facebook.com"].includes(targetUrl.hostname)) {
    targetUrl.hostname = "www.facebook.com";
  }
  await activateAndOpenUrl(driver, FACEBOOK_PACKAGE, targetUrl.toString(), true);
  await waitForForegroundPackage(driver, FACEBOOK_PACKAGE, 20_000, signal);
  let previous: string | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    await wait(attempt ? 750 : 1_000, signal);
    try {
      const description = extractFacebookDescriptionFromHierarchy(
        await driver.getPageSource(),
      );
      if (description === previous) return description;
      previous = description;
    } catch (error) {
      if (error instanceof AppError && error.code === "FACEBOOK_LOGIN_REQUIRED") {
        throw error;
      }
      lastError = error;
    }
  }
  throw new AppError(
    "Facebook no expuso una descripción estable de la publicación.",
    422,
    "FACEBOOK_CONTENT_NOT_VERIFIED",
    { cause: lastError instanceof Error ? lastError.message : String(lastError) },
  );
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
