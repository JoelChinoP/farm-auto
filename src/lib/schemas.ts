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

export const draftInputSchema = z.object({
  kind: z.enum(["social_comment", "direct_message"]),
  platform: z.enum(["tiktok", "facebook", "whatsapp"]),
  context: z.string().trim().min(5).max(1200),
  intent: z.string().trim().min(3).max(300),
  tone: z.enum(["amable", "curioso", "entusiasta", "casual"]),
});

export const generatedDraftSchema = z.object({
  text: z.string().trim().min(2).max(500),
});

export const approveDraftSchema = z.object({
  text: z.string().trim().min(2).max(500),
  consentConfirmed: z.boolean(),
  recipient: z.string().trim().max(24).optional().default(""),
});

export const sendDraftSchema = z.object({
  deviceId,
});

export function normalizeContentUrl(
  platform: "tiktok" | "facebook",
  value: string,
) {
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

export function normalizePhone(value: string) {
  const phone = value.replace(/[^0-9]/g, "");
  if (!/^[1-9][0-9]{7,14}$/.test(phone)) {
    throw new Error("Usa el número internacional, solo dígitos y sin +.");
  }
  return phone;
}
