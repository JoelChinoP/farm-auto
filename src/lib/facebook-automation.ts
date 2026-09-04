import {
  activateAndOpenUrl,
  clickBounds,
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
  const visible = nodes.map(nodeLabel).filter(Boolean).join(" ");
  if (!expected) return false;
  if (` ${visible} `.includes(` ${expected} `)) return true;

  // Older markers omitted one-letter Spanish connector words such as "a".
  const legacyPattern = expected
    .split(" ")
    .join(" (?:[a-z0-9] )?");
  return new RegExp(` ${legacyPattern} `).test(` ${visible} `);
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

function isReelDetail(node: AndroidNode) {
  return accessibleLabels(node).some((label) =>
    /^(?:detalles del reel|detalles del video|detalles de la pestana (?:reels?|video)|reel details|video details)$/.test(
      label,
    ),
  );
}

function isReelLike(node: AndroidNode) {
  return (
    isLike(node) ||
      Boolean(
        node.bounds &&
        node.attributes.enabled !== "false" &&
        (node.attributes["long-clickable"] === "true" ||
          node.attributes.selected === "true" ||
          node.attributes.checked === "true") &&
        accessibleLabels(node).some((label) =>
          /^(?:\d+(?: \d+)?(?: (?:mil|k|m))? )?(?:me gusta|like|reaccion(?:es)?|reactions?)(?: \d+(?: \d+)?(?: (?:mil|k|m))?)?$/.test(
            label,
          ),
        ),
    )
  );
}

function isReelCommentControl(node: AndroidNode) {
  return (
    isCommentControl(node) ||
    Boolean(
      node.bounds &&
        node.attributes.enabled !== "false" &&
        accessibleLabels(node).some((label) =>
          /^(?:\d+(?: \d+)?(?: (?:mil|k|m))? )?(?:comentarios?|comments?)(?: \d+(?: \d+)?(?: (?:mil|k|m))?)?$/.test(
            label,
          ),
        ),
    )
  );
}

function isShareControl(node: AndroidNode) {
  return Boolean(
    node.bounds &&
      node.attributes.enabled !== "false" &&
      accessibleLabels(node).some((label) =>
        /^(?:(?:boton|button) )?(?:compartir|share)(?: (?:boton|button))?$/.test(
          label,
        ),
      ),
  );
}

function eligibleContainer(node: AndroidNode) {
  if (!node.bounds || !node.parent || isScrollable(node)) return false;
  return true;
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

function uniqueControls(
  nodes: AndroidNode[],
  predicate: (node: AndroidNode) => boolean,
) {
  return [...new Map(
    preferredControls(nodes, predicate).map((node) => [node.attributes.bounds, node]),
  ).values()];
}

function overlappingRailControls(left: AndroidNode, right: AndroidNode) {
  if (!left.bounds || !right.bounds) return false;
  const sharedLabel = accessibleLabels(left).some((label) =>
    accessibleLabels(right).includes(label),
  );
  return (
    sharedLabel &&
    left.bounds.left === right.bounds.left &&
    left.bounds.right === right.bounds.right &&
    left.bounds.top < right.bounds.bottom &&
    right.bounds.top < left.bounds.bottom
  );
}

function uniqueReelRailControls(
  nodes: AndroidNode[],
  predicate: (node: AndroidNode) => boolean,
) {
  const controls = uniqueControls(nodes, predicate);
  return controls.filter(
    (control) =>
      !controls.some(
        (other) => {
          if (other === control || !overlappingRailControls(other, control)) {
            return false;
          }
          const otherIsSelected =
            other.attributes.selected === "true" || other.attributes.checked === "true";
          const controlIsSelected =
            control.attributes.selected === "true" || control.attributes.checked === "true";
          if (otherIsSelected !== controlIsSelected) return otherIsSelected;
          const otherIsReactionAction = other.attributes["long-clickable"] === "true";
          const controlIsReactionAction = control.attributes["long-clickable"] === "true";
          return otherIsReactionAction !== controlIsReactionAction
            ? otherIsReactionAction
            : other.bounds!.top < control.bounds!.top;
        },
      ),
  );
}

type FacebookPostCandidate = {
  container: AndroidNode;
  nodes: AndroidNode[];
  like: AndroidNode;
  comment: AndroidNode;
};

function isRightReelRailControl(node: AndroidNode, reelBounds: Bounds) {
  if (!node.bounds) return false;
  const center = (node.bounds.left + node.bounds.right) / 2;
  return (
    node.bounds.bottom > reelBounds.top &&
    node.bounds.top < reelBounds.bottom &&
    center >= reelBounds.left + (reelBounds.right - reelBounds.left) * 0.65
  );
}

function reelSideControlCandidates(all: AndroidNode[], targetMarker?: string) {
  if (!targetMarker) return [] as FacebookPostCandidate[];
  return all.flatMap((container): FacebookPostCandidate[] => {
    if (!eligibleContainer(container)) return [];
    const nodes = subtreeNodes(container).filter(
      (node) =>
        node.attributes.package === FACEBOOK_PACKAGE &&
        node.attributes.displayed !== "false",
    );
    if (
      !orderedMarkerMatch(nodes, targetMarker) ||
      !nodes.some(isReelDetail)
    ) {
      return [];
    }
    const sideControls = all.filter((node) =>
      isRightReelRailControl(node, container.bounds!),
    );
    const likes = uniqueReelRailControls(sideControls, isReelLike);
    const sideComments = uniqueReelRailControls(sideControls, isReelCommentControl);
    return likes.length === 1 && sideComments.length === 1
      ? [{ container, nodes, like: likes[0], comment: sideComments[0] }]
      : [];
  });
}

function facebookPostCandidates(xml: string, targetMarker?: string) {
  const all = flattenAndroidNodes(parseAndroidHierarchy(xml)).filter(
    (node) =>
      node.attributes.package === FACEBOOK_PACKAGE &&
      node.attributes.displayed !== "false",
  );
  let candidates: FacebookPostCandidate[] = all.flatMap((container) => {
    if (!eligibleContainer(container) || !container.parent) return [];
    const nodes = subtreeNodes(container).filter(
      (node) =>
        node.attributes.package === FACEBOOK_PACKAGE &&
        node.attributes.displayed !== "false",
    );
    if (
      !isScrollable(container.parent) &&
      (!targetMarker || !orderedMarkerMatch(nodes, targetMarker))
    ) {
      return [];
    }
    const likes = preferredControls(nodes, isLike);
    const comments = preferredControls(nodes, isCommentControl);
    return likes.length === 1 && comments.length === 1
      ? [{ container, nodes, like: likes[0], comment: comments[0] }]
      : [];
  });
  const reelCandidates = reelSideControlCandidates(all, targetMarker);
  const reelContainers = new Set(reelCandidates.map((candidate) => candidate.container));
  candidates = candidates.filter((candidate) => !reelContainers.has(candidate.container));
  candidates.push(...reelCandidates);
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
    [...facebookPostCandidates(xml, marker)].filter(([, candidate]) =>
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
    likeStateObservable: isLike(target.like),
    alreadyLiked:
      target.like.attributes.selected === "true" ||
      target.like.attributes.checked === "true" ||
      /(^| )(unlike|liked|ya no me gusta)( |$)|(?:me gusta|like) (?:presionado|pressed)( |$)/.test(
        nodeLabel(target.like),
      ),
  };
}

function locateFacebookTargetScrollArea(xml: string, targetMarker: string) {
  const all = facebookVisibleNodes(xml);
  const candidates = all.filter((container) => {
    if (!eligibleContainer(container)) return false;
    const nodes = subtreeNodes(container);
    return (
      orderedMarkerMatch(nodes, targetMarker) &&
      nodes.some((node) =>
        accessibleLabels(node).some((label) =>
          /^(?:ocultar publicacion|hide post)$/.test(label),
        ),
      ) &&
      !nodes.some(isReelDetail) &&
      !nodes.some(isLike) &&
      !nodes.some(isCommentControl)
    );
  });
  const smallest = candidates.filter(
    (container) =>
      !candidates.some(
        (other) => other !== container && subtreeNodes(container).includes(other),
      ),
  );
  if (smallest.length !== 1) return null;
  for (let ancestor = smallest[0].parent; ancestor; ancestor = ancestor.parent) {
    if (isScrollable(ancestor) && ancestor.bounds) return ancestor.bounds;
  }
  return null;
}

export function locateFacebookShareTarget(xml: string, targetMarker: string) {
  const candidates = [...facebookPostCandidates(xml, targetMarker).values()].flatMap(
    (candidate) => {
      const shares = preferredControls(candidate.nodes, isShareControl);
      return shares.length === 1
        ? [{ containerBounds: candidate.container.bounds!, shareBounds: shares[0].bounds! }]
        : [];
    },
  );
  if (candidates.length !== 1) {
    throw new Error("No se identificó un único botón Compartir en la publicación objetivo.");
  }
  return candidates[0];
}

function isProfileShareDestination(node: AndroidNode) {
  return Boolean(
    node.bounds &&
      node.attributes.enabled !== "false" &&
      accessibleLabels(node).some((label) =>
        /^(?:compartir en tu perfil|share to profile)$/.test(label),
      ),
  );
}

function isProfileShareConfirmation(node: AndroidNode) {
  return accessibleLabels(node).some((label) =>
    /^(?:tu perfil|your profile|compartiendo en tu perfil|sharing to your profile)$/.test(
      label,
    ),
  );
}

function isFinalShareControl(node: AndroidNode) {
  return Boolean(
    node.bounds &&
      node.attributes.enabled !== "false" &&
      accessibleLabels(node).some((label) => /^(?:compartir ahora|share now)$/.test(label)),
  );
}

function facebookVisibleNodes(xml: string) {
  return flattenAndroidNodes(parseAndroidHierarchy(xml)).filter(
    (node) =>
      node.attributes.package === FACEBOOK_PACKAGE &&
      node.attributes.displayed !== "false",
  );
}

export function locateFacebookProfileShareDestination(xml: string) {
  const destinations = preferredControls(facebookVisibleNodes(xml), isProfileShareDestination);
  if (destinations.length !== 1) {
    throw new Error("Facebook no expuso un único destino Compartir en tu perfil.");
  }
  return destinations[0].bounds!;
}

export function locateFacebookProfileShareConfirmation(xml: string) {
  const nodes = facebookVisibleNodes(xml);
  const candidates = nodes.flatMap((container) => {
    if (!eligibleContainer(container)) return [];
    const children = subtreeNodes(container).filter(
      (node) =>
        node.attributes.package === FACEBOOK_PACKAGE &&
        node.attributes.displayed !== "false",
    );
    if (!children.some(isProfileShareConfirmation)) return [];
    const controls = preferredControls(children, isFinalShareControl);
    return controls.length === 1 ? [controls[0]] : [];
  });
  const unique = new Map(candidates.map((node) => [node.attributes.bounds, node]));
  if (unique.size !== 1) {
    throw new Error("Facebook no expuso una confirmación inequívoca para compartir en tu perfil.");
  }
  return [...unique.values()][0].bounds!;
}

export function verifyFacebookShareDelivery(xml: string) {
  return facebookVisibleNodes(xml).some((node) =>
    accessibleLabels(node).some((label) =>
      /^(?:compartido|shared|publicacion compartida|post shared)(?:[.!].*)?$/.test(label),
    ),
  );
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

function reelCommentSheet(xml: string, requirePrompt = false) {
  const roots = parseAndroidHierarchy(xml).filter(
    (node) =>
      node.attributes.package === FACEBOOK_PACKAGE &&
      node.attributes.displayed !== "false" &&
      node.bounds,
  );
  if (roots.length !== 1 || roots[0].bounds!.top <= 0) return null;
  if (
    requirePrompt &&
    !subtreeNodes(roots[0]).some((node) =>
      accessibleLabels(node).some((label) =>
        /^(?:comentarios sugeridos|suggested comments|aun no hay comentarios|no comments yet)$/.test(
          label,
        ),
      ),
    )
  ) {
    return null;
  }
  return roots[0].bounds!;
}

function hiddenReelComposerBounds(xml: string) {
  if (!reelCommentSheet(xml, true)) return null;
  const prompts = facebookVisibleNodes(xml).filter(
    (node) =>
      node.bounds &&
      accessibleLabels(node).some((label) =>
        /^(?:comentarios sugeridos|suggested comments)$/.test(label),
      ),
  );
  if (prompts.length !== 1) return null;
  const prompt = prompts[0].bounds!;
  const width = prompt.right - prompt.left;
  const height = prompt.bottom - prompt.top;
  const x = Math.round(prompt.left + width / 2);
  const y = Math.round(prompt.bottom - height * 0.17);
  return { left: x - 1, top: y - 1, right: x + 1, bottom: y + 1 };
}

function locateThread(
  xml: string,
  targetMarker: string,
  targetBounds: Bounds,
  commentText?: string,
  allowReelSheet = false,
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
  const hasReelSheet = allowReelSheet && Boolean(reelCommentSheet(xml));
  if (
    smallestTargets.length > 1 ||
    (smallestTargets.length === 0 && modalCloseControls.length !== 1 && !hasReelSheet)
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
        (hasReelSheet ||
          accessibleLabels(node).some((label) =>
            /(comment|coment|escribe|write)/.test(label),
          )),
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
  allowReelSheet = false,
) {
  try {
    const thread = locateThread(
      xml,
      targetMarker,
      targetBounds,
      commentText,
      allowReelSheet,
    );
    return (
      thread.published.length === 1 &&
      normalizeAccessibleText(thread.composer.attributes.text ?? "") === ""
    );
  } catch (error) {
    if (!allowReelSheet || !reelCommentSheet(xml)) throw error;
    const expected = normalizeAccessibleText(commentText);
    const matches = facebookVisibleNodes(xml).filter(
      (node) =>
        !/EditText|AutoCompleteTextView/.test(node.attributes.class ?? "") &&
        accessibleLabels(node).includes(expected),
    );
    const smallest = matches.filter(
      (node) =>
        !subtreeNodes(node).some(
          (descendant) => descendant !== node && matches.includes(descendant),
        ),
    );
    return smallest.length === 1;
  }
}

export async function runFacebookPost(
  driver: AndroidDriver,
  input: { url: string; commentText: string; targetMarker: string },
  signal: AbortSignal,
  checkpoint: (effect: "like" | "comment") => void,
  openUrl: (url: string) => Promise<void>,
) {
  await driver.setOrientation?.("PORTRAIT");
  let target: ReturnType<typeof locateFacebookTarget> | null = null;
  for (let navigationAttempt = 0; navigationAttempt < 3 && !target; navigationAttempt++) {
    signal.throwIfAborted();
    await openUrl(input.url);
    await waitForForegroundPackage(driver, FACEBOOK_PACKAGE, 20_000, signal);
    let scrolledToActions = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      const hierarchy = await driver.getPageSource();
      try {
        target = locateFacebookTarget(
          hierarchy,
          input.targetMarker,
        );
        break;
      } catch {
        const scrollArea = !scrolledToActions &&
          locateFacebookTargetScrollArea(hierarchy, input.targetMarker);
        if (scrollArea) {
          await driver.execute("mobile: swipeGesture", {
            left: scrollArea.left,
            top: scrollArea.top,
            width: scrollArea.right - scrollArea.left,
            height: scrollArea.bottom - scrollArea.top,
            direction: "up",
            percent: 0.2,
            speed: 600,
          });
          scrolledToActions = true;
        }
        if (attempt === 3) break;
        // A vertical gesture can advance to a different Reel or post.
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
      target = updated;
      if (updated.alreadyLiked) {
        break;
      }
    }
    if (!target.alreadyLiked && target.likeStateObservable) {
      throw new AppError(
        "No se pudo verificar el like aplicado en Facebook.",
        502,
        "LIKE_OUTCOME_UNKNOWN",
      );
    }
  }
  const targetWidth = target.containerBounds.right - target.containerBounds.left;
  const isReel =
    target.commentBounds.left >= target.containerBounds.left + targetWidth * 0.65;
  await clickBounds(driver, target.commentBounds);

  let thread: ReturnType<typeof locateThread> | null = null;
  let hiddenComposerFocused = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await wait(500, signal);
    const hierarchy = await driver.getPageSource();
    try {
      thread = locateThread(
        hierarchy,
        input.targetMarker,
        target.containerBounds,
        undefined,
        isReel,
      );
      break;
    } catch {
      const hiddenComposer = isReel && hiddenReelComposerBounds(hierarchy);
      if (!hiddenComposer) continue;
      await clickBounds(driver, hiddenComposer);
      hiddenComposerFocused = true;
      await wait(500, signal);
      const focusedHierarchy = await driver.getPageSource();
      try {
        thread = locateThread(
          focusedHierarchy,
          input.targetMarker,
          target.containerBounds,
          undefined,
          true,
        );
      } catch {
        if (!reelCommentSheet(focusedHierarchy)) hiddenComposerFocused = false;
      }
      break;
    }
  }
  if (!thread && !hiddenComposerFocused) {
    throw new AppError(
      "Facebook no expuso un único compositor asociado al objetivo.",
      409,
      "FACEBOOK_TARGET_NOT_VERIFIED",
    );
  }
  if (thread) {
    const composer = await driver.$(`//*[@bounds='${thread.composer.attributes.bounds}']`);
    await composer.clearValue();
    await composer.click();
  }
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
        isReel,
      );
      if (updated.published.length) {
        throw new AppError(
          "El comentario generado ya estaba visible antes del envío.",
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
        "Facebook no conservó el comentario generado en el compositor.",
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
  for (let attempt = 0; attempt < 20; attempt++) {
    await wait(1_000, signal);
    try {
      if (
        verifyFacebookDelivery(
          await driver.getPageSource(),
          input.targetMarker,
          target.containerBounds,
          input.commentText,
          isReel,
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

export async function runFacebookSharePost(
  driver: AndroidDriver,
  input: { url: string; targetMarker: string },
  signal: AbortSignal,
  checkpoint: () => void,
  openUrl: (url: string) => Promise<void>,
) {
  let target: ReturnType<typeof locateFacebookShareTarget> | null = null;
  for (let navigationAttempt = 0; navigationAttempt < 3 && !target; navigationAttempt++) {
    signal.throwIfAborted();
    await openUrl(input.url);
    await waitForForegroundPackage(driver, FACEBOOK_PACKAGE, 20_000, signal);
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      try {
        target = locateFacebookShareTarget(
          await driver.getPageSource(),
          input.targetMarker,
        );
        break;
      } catch {
        if (attempt === 3) break;
        await wait(750, signal);
      }
    }
  }
  if (!target) {
    throw new AppError(
      "Facebook no expuso inequívocamente el botón Compartir de la publicación objetivo.",
      409,
      "FACEBOOK_TARGET_NOT_VERIFIED",
    );
  }

  // Some Facebook versions can share directly from this first control, so retain
  // an uncertain outcome if the sheet cannot be verified afterwards.
  checkpoint();
  await clickBounds(driver, target.shareBounds);

  let destination: Bounds | null = null;
  for (let attempt = 0; attempt < 5 && !destination; attempt++) {
    await wait(500, signal);
    try {
      destination = locateFacebookProfileShareDestination(await driver.getPageSource());
    } catch {
      // The share sheet may still be rendering.
    }
  }
  if (!destination) {
    throw new AppError(
      "Facebook no ofreció el destino Compartir en tu perfil para esta publicación.",
      409,
      "FACEBOOK_SHARE_PROFILE_UNAVAILABLE",
    );
  }
  await clickBounds(driver, destination);

  let confirmation: Bounds | null = null;
  for (let attempt = 0; attempt < 5 && !confirmation; attempt++) {
    await wait(500, signal);
    try {
      confirmation = locateFacebookProfileShareConfirmation(await driver.getPageSource());
    } catch {
      // Wait for the profile composer to show its final explicit action.
    }
  }
  if (!confirmation) {
    throw new AppError(
      "Facebook no mostró una confirmación explícita para compartir en tu perfil.",
      409,
      "FACEBOOK_SHARE_CONFIRMATION_UNAVAILABLE",
    );
  }
  await clickBounds(driver, confirmation);

  for (let attempt = 0; attempt < 5; attempt++) {
    await wait(1_000, signal);
    if (verifyFacebookShareDelivery(await driver.getPageSource())) return;
  }
  throw new AppError(
    "No se pudo verificar que Facebook compartió la publicación en el perfil.",
    502,
    "SHARE_DELIVERY_UNKNOWN",
  );
}
