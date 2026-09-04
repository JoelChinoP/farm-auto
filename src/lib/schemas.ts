import { z } from "zod";

import { facebookToneValues } from "./facebook-copy-options.ts";

const deviceId = z.string().trim().min(1).max(120);
const idempotencyKey = z.string().uuid();

export const setupSchema = z.object({ deviceId });

export const deviceProfilesSchema = z
  .object({
    profiles: z
      .array(
        z
          .object({
            hardwareId: z.string().trim().min(1).max(240),
            deviceId,
            alias: z.string().trim().min(1).max(120),
            physicalOrder: z.number().int().min(0),
            systemPort: z.number().int().min(8200).max(8299),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((input, context) => {
    for (const field of ["hardwareId", "deviceId", "physicalOrder", "systemPort"] as const) {
      if (new Set(input.profiles.map((profile) => profile[field])).size !== input.profiles.length) {
        context.addIssue({
          code: "custom",
          path: ["profiles"],
          message: `El campo ${field} debe ser único.`,
        });
      }
    }
  });

export const deviceActionSchema = z.object({
  deviceId,
  idempotencyKey,
});

export const openContentSchema = z.object({
  deviceIds: z.array(deviceId).min(1).max(100),
  idempotencyKey,
  platform: z.enum(["tiktok", "facebook"]),
  url: z.string().trim().url().max(2048),
}).strict().superRefine((input, context) => {
  if (new Set(input.deviceIds).size === input.deviceIds.length) return;
  context.addIssue({
    code: "custom",
    path: ["deviceIds"],
    message: "Cada dispositivo solo puede abrir el enlace una vez.",
  });
});

export const tiktokLiveTapTapSchema = deviceActionSchema.extend({
  url: z.string().trim().url().max(2048),
  tapRounds: z.number().int().min(1).max(50),
  tapX: z.number().int().min(0).max(5000),
  tapY: z.number().int().min(0).max(5000),
}).strict();

export const draftInputSchema = z
  .object({
    kind: z.literal("social_comment"),
    platform: z.enum(["tiktok", "facebook"]),
    context: z.string().trim().min(5).max(1200),
    intent: z.string().trim().min(3).max(300),
    tone: z.enum(facebookToneValues),
  })
  .strict();

const generatedDraftSchema = z.object({
  text: z.string().trim().min(2).max(500),
}).strict();

const generatedCommentsSchema = z.object({
  comments: z.array(generatedDraftSchema).min(1).max(100),
}).strict();

export function parseGeneratedCommentsContent(
  content: string,
  expectedCount: number,
  minWords: number,
  maxWords: number,
) {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of new Set(candidates)) {
    try {
      const generated = generatedCommentsSchema.safeParse(JSON.parse(candidate));
      if (!generated.success || generated.data.comments.length !== expectedCount) continue;
      const validLengths = generated.data.comments.every(({ text }) => {
        const words = text.split(/\s+/u).filter(Boolean).length;
        return words >= minWords && words <= maxWords;
      });
      if (validLengths) return generated.data.comments;
    } catch {
      // Try the remaining supported response formats.
    }
  }
  return null;
}

export const sendDraftSchema = z.object({
  deviceId,
  contentUrl: z.string().trim().url().max(2048).optional(),
});

export const facebookBatchSchema = z
  .object({
    urls: z.array(z.string().trim().url().max(2048)).min(1).max(50),
    deviceIds: z.array(deviceId).min(1).max(100),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.deviceIds).size !== input.deviceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["deviceIds"],
        message: "Cada dispositivo solo puede incluirse una vez en la cola.",
      });
    }
  });

export const facebookShareSchema = z
  .object({
    deviceIds: z.array(deviceId).min(1).max(100),
    idempotencyKey,
    url: z.string().trim().url().max(2048),
    context: z.string().trim().min(12).max(1200),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.deviceIds).size === input.deviceIds.length) return;
    context.addIssue({
      code: "custom",
      path: ["deviceIds"],
      message: "Cada dispositivo solo puede compartir una vez por solicitud.",
    });
  });

export const facebookExtractSchema = z.object({}).strict();

export const facebookBrowserActionSchema = z
  .object({
    action: z.enum(["open", "close"]),
  })
  .strict();

const facebookAllocationSchema = z
  .object({
    intent: z.string().trim().min(3).max(300),
    tone: z.enum(facebookToneValues),
    count: z.number().int().min(1).max(100),
  })
  .strict();

export const facebookDraftsSchema = z
  .object({
    context: z.string().trim().min(5).max(1200),
    deviceIds: z.array(deviceId).min(1).max(100),
    allocations: z.array(facebookAllocationSchema).min(1).max(20),
    replaceExisting: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.deviceIds).size !== input.deviceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["deviceIds"],
        message: "Cada dispositivo solo puede seleccionarse una vez.",
      });
    }
    const allocated = input.allocations.reduce((total, item) => total + item.count, 0);
    if (allocated !== input.deviceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["allocations"],
        message: "La suma de cantidades debe coincidir con los dispositivos seleccionados.",
      });
    }
  });

export const facebookExecuteSchema = z
  .object({
    minDelaySeconds: z.number().int().min(1).max(600),
    maxDelaySeconds: z.number().int().min(1).max(600),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.maxDelaySeconds < input.minDelaySeconds) {
      context.addIssue({
        code: "custom",
        path: ["maxDelaySeconds"],
        message: "El tiempo máximo debe ser igual o mayor que el mínimo.",
      });
    }
  });

export const facebookBatchExecuteSchema = z
  .object({
    maxDelayMinutes: z.number().int().min(0).max(1_440),
  })
  .strict();

export const facebookReconcileSchema = z
  .object({
    outcomes: z
      .array(
        z
          .object({
            assignmentId: z.string().uuid(),
            outcome: z.enum(["sent", "not_sent"]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.outcomes.map((item) => item.assignmentId)).size !== input.outcomes.length) {
      context.addIssue({
        code: "custom",
        path: ["outcomes"],
        message: "Cada asignación solo puede verificarse una vez.",
      });
    }
  });

export function normalizeContentUrl(
  platform: "tiktok" | "facebook",
  value: string,
) {
  if (/['\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("El enlace contiene caracteres no permitidos.");
  }
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("El enlace debe usar HTTPS.");
  }
  if (url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("El enlace contiene credenciales o un puerto no permitido.");
  }

  const hostname = url.hostname.toLowerCase();
  const allowed =
    platform === "tiktok"
      ? hostname === "tiktok.com" || hostname.endsWith(".tiktok.com")
      : hostname === "facebook.com" ||
      hostname.endsWith(".facebook.com") ||
      hostname === "fb.watch" ||
      hostname.endsWith(".fb.watch");

  if (!allowed) {
    throw new Error(
      platform === "tiktok"
        ? "Ingresa un enlace válido de TikTok."
        : "Ingresa un enlace válido de Facebook.",
    );
  }

  if (platform === "facebook" && hostname.endsWith("facebook.com")) {
    url.hostname = "www.facebook.com";
  }
  url.hash = "";
  return url.toString();
}

export function preferFacebookVideoPostUrl(currentUrl: string, openGraphUrl: string | null) {
  const current = normalizeContentUrl("facebook", currentUrl);
  if (!openGraphUrl?.trim()) return current;
  try {
    const candidate = normalizeContentUrl(
      "facebook",
      new URL(openGraphUrl.trim(), current).toString(),
    );
    const currentPath = new URL(current).pathname.toLowerCase();
    const candidatePath = new URL(candidate).pathname.toLowerCase();
    return currentPath.startsWith("/reel/") && candidatePath.includes("/videos/")
      ? candidate
      : current;
  } catch {
    return current;
  }
}

export function normalizeFacebookUrls(values: string[]) {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const url = normalizeContentUrl("facebook", value);
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

export function distributeFacebookDevices(deviceIds: string[], postCount: number) {
  if (!Number.isInteger(postCount) || postCount < 1) {
    throw new Error("La cola debe contener al menos una publicación.");
  }
  if (new Set(deviceIds).size !== deviceIds.length) {
    throw new Error("Cada dispositivo solo puede incluirse una vez en la cola.");
  }
  if (!deviceIds.length) {
    throw new Error("Se necesita al menos un dispositivo preparado.");
  }

  const baseSize = Math.floor(deviceIds.length / postCount);
  const extraDevices = deviceIds.length % postCount;
  const groups: string[][] = [];
  let offset = 0;
  for (let index = 0; index < postCount; index++) {
    const size = baseSize + (index < extraDevices ? 1 : 0);
    groups.push(deviceIds.slice(offset, offset + size));
    offset += size;
  }
  return groups;
}

export function expandFacebookAllocations(
  deviceIds: string[],
  allocations: Array<{ intent: string; tone: string; count: number }>,
) {
  const expanded: Array<{ deviceId: string; intent: string; tone: string }> = [];
  let deviceIndex = 0;
  for (const allocation of allocations) {
    for (let index = 0; index < allocation.count; index++) {
      const deviceId = deviceIds[deviceIndex++];
      if (!deviceId) throw new Error("La distribución excede los dispositivos elegidos.");
      expanded.push({
        deviceId,
        intent: allocation.intent,
        tone: allocation.tone,
      });
    }
  }
  if (deviceIndex !== deviceIds.length) {
    throw new Error("La distribución no cubre todos los dispositivos elegidos.");
  }
  return expanded;
}
