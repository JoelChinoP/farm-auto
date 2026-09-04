import type { CampaignDraft, ControlState, Device, Platform } from "./control-panel.types";
import { isDeviceEligible, statusLabels } from "./demo-state";

export function draftFor(state: ControlState, platform: Platform) {
  return platform === "facebook" ? state.facebookDraft : state.tiktokDraft;
}

export function deviceReason(device: Device, platform: Platform) {
  if (device.connection === "offline") return "Equipo desconectado";
  if (device.connection === "unauthorized") return "ADB no autorizado";
  if (device.preparation !== "ready") return `Appium: ${statusLabels[device.preparation].toLowerCase()}`;
  if (device.capabilities[platform] !== "ready") return statusLabels[device.capabilities[platform]];
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

export function groupAssignments(draft: CampaignDraft, devices: Device[]) {
  if (draft.reviewGrouping === "post") {
    return draft.posts.map((post) => ({
      label: `${String(post.position).padStart(2, "0")} / ${domainLabel(post.url)}`,
      items: draft.assignments.filter((item) => item.postId === post.id).map((item) => ({
        ...item,
        detail: devices.find((device) => device.id === item.deviceId)?.alias ?? "Dispositivo retirado",
      })),
    }));
  }

  return draft.selectedDeviceIds.map((deviceId) => ({
    label: devices.find((device) => device.id === deviceId)?.alias ?? "Dispositivo retirado",
    items: draft.assignments.filter((item) => item.deviceId === deviceId).map((item) => ({
      ...item,
      detail: domainLabel(draft.posts.find((post) => post.id === item.postId)?.url ?? ""),
    })),
  }));
}

export { isDeviceEligible };
