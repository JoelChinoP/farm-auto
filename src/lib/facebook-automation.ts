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

function accessibleLabels(node: AndroidNode) {
  return [...new Set(
    [node.attributes.text, node.attributes["content-desc"], node.attributes.hint]
      .map((value) => normalizeAccessibleText(value ?? ""))
      .filter(Boolean),
  )];
}

function isLike(node: AndroidNode) {
  return Boolean(
      node.bounds &&
      node.attributes.enabled !== "false" &&
      accessibleLabels(node).some((label) =>
        /^(?:(?:boton|button) )?(?:me gusta|ya no me gusta|like|liked|unlike)(?:$| (?:boton|button)$| (?:presionado|pressed)(?:$| )| toca )/.test(
          label,
        ),
      ),
  );
}

function isCommentControl(node: AndroidNode) {
  return Boolean(
    node.bounds &&
      node.attributes.enabled !== "false" &&
      accessibleLabels(node).some((label) =>
        /^(?:(?:boton|button) )?(?:comentar|comentario|comment)(?:$| (?:boton|button)$)/.test(
          label,
        ),
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

const collapsedDescription =
  /(?:…|\.\.\.)\s*(?:(?:ver|see)\s+)?(?:más|mas|more)\s*$/iu;

function isFacebookHomeHierarchy(xml: string) {
  const labels = flattenAndroidNodes(parseAndroidHierarchy(xml))
    .filter(
      (node) =>
        node.attributes.package === FACEBOOK_PACKAGE &&
        node.attributes.displayed !== "false",
    )
    .flatMap(accessibleLabels);
  return (
    labels.some((label) => /^(?:historias|stories)$/.test(label)) &&
    labels.some((label) => /^(?:crear historia|create story)$/.test(label))
  );
}

function locateFacebookExpansion(xml: string) {
  const candidates = facebookPostCandidates(xml);
  if (candidates.size !== 1) return null;
  const target = [...candidates.values()][0];
  const actionTop = Math.min(target.like.bounds!.top, target.comment.bounds!.top);
  const controls = target.nodes.filter((node) => {
    if (
      !node.bounds ||
      node.bounds.top < target.container.bounds!.top ||
      node.bounds.bottom > actionTop ||
      node.attributes.clickable !== "true" ||
      node.attributes.enabled === "false"
    ) {
      return false;
    }
    const labels = accessibleLabels(node);
    if (labels.some((label) => /^(?:ver mas|see more)$/.test(label))) {
      return true;
    }
    if (!labels.some((label) => /^(?:mas|more)$/.test(label))) return false;
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (
        [ancestor.attributes.text, ancestor.attributes["content-desc"]].some(
          (value) => collapsedDescription.test((value ?? "").trim()),
        )
      ) {
        return true;
      }
      if (ancestor === target.container) break;
    }
    return false;
  });
  const unique = new Map(
    controls.map((node) => [node.attributes.bounds, node.bounds!]),
  );
  if (unique.size > 1) {
    throw new Error("Facebook expuso varios controles para expandir la publicación.");
  }
  return unique.size === 1 ? [...unique.values()][0] : null;
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
      /(^| )(unlike|liked|ya no me gusta)( |$)|(?:me gusta|like) (?:presionado|pressed)( |$)/.test(
        nodeLabel(target.like),
      ),
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
  if (isFacebookHomeHierarchy(xml)) {
    throw new Error(
      "Facebook abrió Inicio en lugar de la publicación solicitada.",
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
      const text = (node.attributes.text ?? "").replace(/\s+/g, " ").trim();
      const contentDescription = (node.attributes["content-desc"] ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const mirroredViewGroup =
        /ViewGroup$/.test(className) &&
        text.length >= 5 &&
        text === contentDescription;
      if (
        !node.bounds ||
        node.bounds.top < target.container.bounds!.top ||
        node.bounds.bottom > actionTop ||
        (!/(?:TextView|android\.view\.View)$/.test(className) &&
          !mirroredViewGroup) ||
        /(?:Button|EditText|ImageView)/.test(className) ||
        (node.attributes.clickable === "true" && !mirroredViewGroup)
      ) {
        return [];
      }
      const value = text || contentDescription;
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
  if (collapsedDescription.test(description)) {
    throw new Error("Facebook no expuso el contenido completo de la publicación.");
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
  let lastError: unknown;
  for (let navigationAttempt = 0; navigationAttempt < 3; navigationAttempt++) {
    for (let openAttempt = 0; openAttempt < 2; openAttempt++) {
      await activateAndOpenUrl(
        driver,
        FACEBOOK_PACKAGE,
        targetUrl.toString(),
        openAttempt === 0,
      );
      await waitForForegroundPackage(driver, FACEBOOK_PACKAGE, 20_000, signal);
      let previous: string | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        await wait(attempt ? 750 : 1_000, signal);
        const hierarchy = await driver.getPageSource();
        if (isFacebookHomeHierarchy(hierarchy)) {
          lastError = new Error(
            "Facebook abrió Inicio en lugar de la publicación solicitada.",
          );
          break;
        }
        try {
          const expansion = locateFacebookExpansion(hierarchy);
          if (expansion) {
            await clickBounds(driver, expansion);
            previous = null;
            continue;
          }
          const description = extractFacebookDescriptionFromHierarchy(hierarchy);
          if (description === previous) return description;
          previous = description;
        } catch (error) {
          if (
            error instanceof AppError &&
            error.code === "FACEBOOK_LOGIN_REQUIRED"
          ) {
            throw error;
          }
          lastError = error;
        }
      }
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
  const targetContainers = all.filter((container) => {
    if (
      !sameBounds(container.bounds, targetBounds) ||
      !container.parent ||
      isScrollable(container)
    ) {
      return false;
    }
    return orderedMarkerMatch(subtreeNodes(container), targetMarker);
  });
  const smallestTargets = targetContainers.filter(
    (container) =>
      !targetContainers.some(
        (other) => other !== container && other.parent === container,
      ),
  );
  const modalCloseControls = all.filter(
    (node) =>
      node.bounds &&
      node.attributes.clickable === "true" &&
      accessibleLabels(node).includes("cerrar"),
  );
  if (
    smallestTargets.length > 1 ||
    (smallestTargets.length === 0 && modalCloseControls.length !== 1)
  ) {
    throw new Error("No se identificó un único hilo objetivo.");
  }
  const container = smallestTargets[0] ?? null;
  const targetNodes = container
    ? subtreeNodes(container).filter(
        (node) =>
          node.attributes.package === FACEBOOK_PACKAGE &&
          node.attributes.displayed !== "false",
      )
    : [];
  const isComposer = (node: AndroidNode) =>
    Boolean(
      node.bounds &&
        /EditText|AutoCompleteTextView/.test(node.attributes.class ?? "") &&
        node.attributes.focusable !== "false" &&
        accessibleLabels(node).some((label) =>
          /(comment|coment|escribe|write)/.test(label),
        ),
    );
  const internalComposers = targetNodes.filter(isComposer);
  const targetIds = new Set(targetNodes.map((node) => node.id));
  const isOutsideScrollableContent = (node: AndroidNode) => {
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (isScrollable(ancestor)) return false;
    }
    return true;
  };
  const composers = internalComposers.length
    ? internalComposers
    : all.filter(
        (node) =>
          !targetIds.has(node.id) &&
          isComposer(node) &&
          isOutsideScrollableContent(node),
      );
  if (composers.length !== 1) {
    throw new Error("No se identificó un único hilo objetivo.");
  }
  const composer = composers[0];
  const findSends = (nodes: AndroidNode[]) =>
    nodes.filter((node) =>
      Boolean(
        node.bounds &&
          node.attributes.enabled !== "false" &&
          accessibleLabels(node).some((label) =>
            /^(post comment|send comment|enviar comentario|publicar comentario|send|enviar|post|publicar)$/.test(
              label,
            ),
          ),
      ),
    );
  let sends: AndroidNode[] = [];
  for (let scope = composer.parent; scope; scope = scope.parent) {
    sends = findSends(subtreeNodes(scope));
    if (sends.length) break;
  }
  if (!sends.length) sends = findSends(all);
  const publishedCandidates = expected
    ? all.filter(
        (node) =>
          !/EditText|AutoCompleteTextView/.test(node.attributes.class ?? "") &&
          accessibleLabels(node).includes(expected),
      )
    : [];
  const published = publishedCandidates.filter(
    (node) =>
      !subtreeNodes(node).some(
        (descendant) =>
          descendant !== node && publishedCandidates.includes(descendant),
      ),
  );
  return { container: container ?? composer.parent!, composer, sends, published };
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
  let target: ReturnType<typeof locateFacebookTarget> | null = null;
  for (let navigationAttempt = 0; navigationAttempt < 3 && !target; navigationAttempt++) {
    await activateAndOpenUrl(driver, FACEBOOK_PACKAGE, input.url, true);
    await waitForForegroundPackage(driver, FACEBOOK_PACKAGE, 20_000, signal);
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      try {
        target = locateFacebookTarget(
          await driver.getPageSource(),
          input.targetMarker,
        );
        break;
      } catch {
        if (attempt === 2) break;
        await swipeUp(driver);
        await wait(750, signal);
      }
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
  await composer.clearValue();
  await composer.click();
  await driver.execute("mobile: type", { text: input.commentText });

  let readyThread: ReturnType<typeof locateThread> | null = null;
  let commentReady = false;
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
      commentReady =
        (updated.composer.attributes.text ?? "").trim() === input.commentText;
      if (!commentReady) continue;
      if (updated.sends.length === 1) {
        readyThread = updated;
        break;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
    }
  }
  if (!readyThread) {
    if (!commentReady) {
      throw new AppError(
        "Facebook no conservó el comentario aprobado en el compositor.",
        502,
        "COMMENT_NOT_READY",
      );
    }
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
