import { z } from "zod";

const deviceId = z.string().trim().min(1).max(120);
const idempotencyKey = z.string().uuid();

export const setupSchema = z.object({ deviceId });

export const deviceActionSchema = z.object({
  deviceId,
  idempotencyKey,
});

export const openContentSchema = deviceActionSchema.extend({
  platform: z.enum(["tiktok", "facebook"]),
  url: z.string().trim().url().max(2048),
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
    tone: z.enum(["amable", "curioso", "entusiasta", "casual"]),
  })
  .strict();

export const generatedDraftSchema = z.object({
  text: z.string().trim().min(2).max(500),
});

export function parseGeneratedDraftContent(content: string) {
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
      const generated = generatedDraftSchema.safeParse(JSON.parse(candidate));
      if (generated.success) return generated.data;
    } catch {
      // Try the remaining supported response formats.
    }
  }

  const plainText = fenced?.[1]?.trim() ?? trimmed;
  if (!/[{}\[\]`]/.test(plainText)) {
    const generated = generatedDraftSchema.safeParse({ text: plainText });
    if (generated.success) return generated.data;
  }
  return null;
}

export const approveDraftSchema = z
  .object({
    text: z.string().trim().min(2).max(500),
  })
  .strict();

export const sendDraftSchema = z.object({
  deviceId,
  contentUrl: z.string().trim().url().max(2048).optional(),
});

export const facebookBatchSchema = z
  .object({
    urls: z.array(z.string().trim().url().max(2048)).min(1).max(50),
  })
  .strict();

export const facebookExtractSchema = deviceActionSchema.strict();

const facebookAllocationSchema = z
  .object({
    intent: z.string().trim().min(3).max(300),
    tone: z.enum(["amable", "curioso", "entusiasta", "casual"]),
    count: z.number().int().min(1).max(100),
  })
  .strict();

export const facebookDraftsSchema = z
  .object({
    context: z.string().trim().min(5).max(1200),
    deviceIds: z.array(deviceId).min(1).max(100),
    allocations: z.array(facebookAllocationSchema).min(1).max(20),
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

export const facebookApproveSchema = z
  .object({
    comments: z
      .array(
        z
          .object({
            assignmentId: z.string().uuid(),
            text: z.string().trim().min(2).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(100),
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

  url.hash = "";
  return url.toString();
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
