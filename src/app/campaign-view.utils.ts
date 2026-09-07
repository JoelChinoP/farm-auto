import type { ControlState, Device, Platform } from "./control-panel.types";
import { isDeviceEligible, statusLabels } from "./demo-state";

export function draftFor(state: ControlState, platform: Platform) {
  return platform === "facebook" ? state.facebookDraft : state.tiktokDraft;
}

export function deviceReason(device: Device, platform: Platform) {
  if (device.connection === "offline") return "Equipo desconectado";
  if (device.connection === "unauthorized") return "ADB no autorizado";
  if (device.preparation !== "ready") return `Appium: ${statusLabels[device.preparation].toLowerCase()}`;
  if (device.capabilities[platform] !== "ready") return statusLabels[device.capabilities[platform]];
  if (device.activity !== "available") return "No disponible para Farm Appium";
  return "Elegible";
}

export function domainLabel(url: string) {
  try {
    const parsed = new URL(url);
    const suffix = parsed.pathname.split("/").filter(Boolean).slice(-2).join("/");
    return `${parsed.hostname.replace("www.", "")} / ${suffix || "publicación"}`;
  } catch {
    return url;
  }
}

export function shortSerial(serial?: string) {
  if (!serial) return "Sin serial";
  return serial.length > 12 ? `${serial.slice(0, 5)}…${serial.slice(-5)}` : serial;
}

export { isDeviceEligible };
