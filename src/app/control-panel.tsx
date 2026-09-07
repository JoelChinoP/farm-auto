"use client";

import {
  Alert,
  Badge,
  Button,
  Drawer,
  Group,
  Modal,
  NumberInput,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useReducer, useRef, useState } from "react";

import { CampaignView } from "./campaign-view";
import type {
  CampaignDraft,
  CampaignActionResult,
  ControlAction,
  ControlDispatch,
  ControlState,
  Device,
  Platform,
  Tone,
  ViewId,
} from "./control-panel.types";
import {
  buildAssignments,
  formatDate,
  createInitialState,
  parseCampaignUrls,
  parseDeviceInput,
  randomDeviceSchedule,
  statusLabels,
} from "./demo-state";
import { DevicesView } from "./devices-view";
import { HistoryView } from "./history-view";
import { TikTokLivePanel, type TikTokConfiguration, type TikTokLiveInput } from "./tiktok-live-panel";

const navItems: { id: ViewId; index: string; label: string }[] = [
  { id: "devices", index: "01", label: "Dispositivos" },
  { id: "facebook", index: "02", label: "Facebook" },
  { id: "tiktok", index: "03", label: "TikTok" },
  { id: "history", index: "04", label: "Historial" },
];

const abortSteps = [
  "Solicitud registrada",
  "Deteniendo nuevos trabajos",
  "Cancelando tareas activas",
  "Cerrando sesiones propias",
  "Enviando Home por dispositivo",
  "Finalizado o requiere recuperación",
];

type DeviceSnapshot = {
  hardwareId: string;
  deviceId: string;
  alias: string;
  physicalOrder: number;
  systemPort: number;
  connection: Device["connection"] | null;
  model: string | null;
  observedAt: number | null;
  preparationStatus: Device["preparation"] | null;
  preparationStep: string | null;
  preparationUpdatedAt: number | null;
  farmAvailability: "available" | "busy";
  retirementStatus: "pending" | null;
  facebookAccount: string | null;
  facebookAccountFingerprint: string | null;
  packages: unknown[];
};

type FacebookSnapshot = {
  id: string;
  platform: Platform;
  mode?: "post" | "live";
  status: CampaignDraft["status"];
  revision: number;
  actions: CampaignDraft["actions"];
  controlledAccount: string | null;
  manifest?: null | {
    revision: number;
    scheduledAt: number;
    allowSharedAccounts: boolean;
    createdAt: number;
  };
  deviceIds: string[];
  createdAt: number;
  updatedAt: number;
  posts: Array<{
    id: string;
    position: number;
    url: string;
    finalUrl: string | null;
    status: CampaignDraft["posts"][number]["status"];
    contextStatus: CampaignDraft["posts"][number]["contextStatus"];
    context: string;
    extractedContext: string;
    contextSource: CampaignDraft["posts"][number]["contextSource"];
    extractedAt: number | null;
    error: string | null;
    comments: Array<{
      id: string;
      assignmentId: string;
      deviceId: string;
      intention: string;
      tone: Tone;
      text: string;
      status: CampaignDraft["posts"][number]["comments"][number]["status"];
      stale: boolean;
      source: "generated" | "manual";
      version: number;
      textHash: string;
      error: string | null;
    }>;
  }>;
  assignments: Array<{
    id: string;
    postId: string;
    deviceId: string;
    status: CampaignDraft["assignments"][number]["status"];
    scheduledAt: number | null;
    actualAt: number | null;
    execution: CampaignDraft["assignments"][number]["execution"];
  }>;
};

function isoDate(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

function mapDeviceSnapshots(devices: DeviceSnapshot[]): Device[] {
  return devices.map((device) => {
    const packages = new Set(device.packages.filter((value): value is string => typeof value === "string"));
    const preparation = device.preparationStatus ?? "not_ready";
    return {
      id: device.deviceId,
      order: device.physicalOrder,
      alias: device.alias,
      serial: device.deviceId,
      model: device.model ?? "Pendiente de lectura",
      connection: device.connection ?? "offline",
      preparation,
      preparationStep: device.preparationStep ?? undefined,
      capabilities: {
        facebook: packages.has("com.facebook.katana") ? "ready" : "not_installed",
        tiktok: packages.has("com.zhiliaoapp.musically") ? "ready" : "not_installed",
      },
      activity: preparation === "recovery_required" ? "recovery_required" : device.farmAvailability,
      systemPort: device.systemPort,
      hardwareId: device.hardwareId,
      lastPreparation: isoDate(device.preparationUpdatedAt),
      lastPlatformCheck: { facebook: isoDate(device.observedAt), tiktok: isoDate(device.observedAt) },
      facebookAccount: device.facebookAccount,
      retireAfterCampaign: device.retirementStatus === "pending",
    };
  });
}

function mapCampaignSnapshot(snapshot: FacebookSnapshot): CampaignDraft {
  const firstComments = snapshot.posts[0]?.comments ?? [];
  const distribution = [...firstComments.reduce((rows, comment) => {
    const key = `${comment.intention}\0${comment.tone}`;
    const current = rows.get(key);
    if (current) current.count += 1;
    else rows.set(key, { id: `${snapshot.platform}-intent-${rows.size + 1}`, intention: comment.intention, tone: comment.tone, count: 1 });
    return rows;
  }, new Map<string, CampaignDraft["distribution"][number]>()).values()];
  return {
    id: snapshot.id,
    revision: snapshot.revision,
    platform: snapshot.platform,
    mode: snapshot.mode,
    status: snapshot.status,
    selectedDeviceIds: snapshot.deviceIds,
    urlInput: snapshot.posts.map((post) => post.url).join("\n"),
    urls: snapshot.posts.map((post) => post.url),
    urlErrors: [],
    actions: snapshot.actions,
    controlledAccount: snapshot.controlledAccount,
    distribution: distribution.length
      ? distribution
      : [{ id: `${snapshot.platform}-intent-1`, intention: "Reacción natural", tone: "Cercano", count: 0 }],
    posts: snapshot.posts.map((post) => ({
      id: post.id,
      position: post.position,
      url: post.url,
      finalUrl: post.finalUrl,
      status: post.status,
      contextStatus: post.contextStatus,
      context: post.context,
      extractedContext: post.extractedContext,
      contextSource: post.contextSource,
      extractedAt: isoDate(post.extractedAt),
      elapsedSeconds: 0,
      comments: post.comments.map((comment) => ({
        id: comment.id,
        assignmentId: comment.assignmentId,
        deviceId: comment.deviceId,
        intention: comment.intention,
        tone: comment.tone,
        text: comment.text,
        status: comment.status,
        stale: comment.stale,
        source: comment.source,
        version: comment.version,
        textHash: comment.textHash,
        ...(comment.error ? { error: comment.error } : {}),
      })),
      ...(post.error ? { error: post.error } : {}),
    })),
    assignments: snapshot.assignments.map((assignment) => ({
      id: assignment.id,
      postId: assignment.postId,
      deviceId: assignment.deviceId,
      status: assignment.status,
      scheduledAt: isoDate(assignment.scheduledAt),
      actualAt: isoDate(assignment.actualAt),
      execution: assignment.execution,
    })),
    selectedPostId: snapshot.posts[0]?.id ?? null,
    scheduleDeadline: snapshot.manifest ? new Date(snapshot.manifest.scheduledAt).toISOString().slice(0, 16) : "",
  };
}

function actionResult(
  requested: boolean,
  action: CampaignActionResult | null,
) {
  if (!requested) return "not_requested" as const;
  if (action?.status === "confirmed") return "ok" as const;
  if (action?.status === "effect_possible" || action?.status === "outcome_unknown") return "outcome_unknown" as const;
  return "failed" as const;
}

function mapCampaignHistory(snapshots: FacebookSnapshot[], devices: Device[]) {
  return snapshots.map((snapshot) => ({
    id: snapshot.id,
    platform: snapshot.platform,
    mode: snapshot.mode,
    startedAt: new Date(snapshot.createdAt).toISOString(),
    deviceIds: snapshot.deviceIds,
    postUrls: snapshot.posts.map((post) => post.url),
    actions: snapshot.actions,
    status: snapshot.status,
    completedAssignments: snapshot.assignments.filter((assignment) => ["sent", "failed", "outcome_unknown", "cancelled"].includes(assignment.status)).length,
    totalAssignments: snapshot.assignments.length,
    assignments: snapshot.assignments.map((assignment) => {
      const post = snapshot.posts.find((item) => item.id === assignment.postId)!;
      const comment = post.comments.find((item) => item.assignmentId === assignment.id);
      const device = devices.find((item) => item.id === assignment.deviceId);
      const execution = assignment.execution;
      const cleanup = execution?.cleanupStatus === "home_confirmed"
        ? "home_confirmed" as const
        : execution?.cleanupStatus === "session_closed"
          ? "session_closed" as const
          : execution?.cleanupStatus === "failed"
            ? "failed" as const
            : "unknown" as const;
      return {
        id: assignment.id,
        operationId: execution?.operationId ?? null,
        postUrl: post.url,
        deviceId: assignment.deviceId,
        deviceAlias: device?.alias ?? "Dispositivo retirado",
        deviceSerial: device?.serial ?? assignment.deviceId,
        plannedAt: isoDate(assignment.scheduledAt) ?? new Date(snapshot.createdAt).toISOString(),
        actualAt: isoDate(assignment.actualAt),
        status: assignment.status,
        comment: comment?.text || null,
        context: post.context || "No requerido",
        likeResult: actionResult(snapshot.actions.like, execution?.like ?? null),
        commentResult: actionResult(snapshot.actions.comment, execution?.comment ?? null),
        ...(execution?.error ? { error: execution.error } : {}),
        attempts: execution?.attempts ?? 0,
        confirmedRounds: execution?.confirmedRounds,
        requestedRounds: execution?.requestedRounds,
        cleanup,
        uncertainAction: execution?.uncertainAction ?? null,
        checkpoints: execution?.checkpoints ?? [],
        evidence: execution?.evidence ?? [],
      };
    }),
  }));
}

function preserveDirtyFacebookFields(current: CampaignDraft, incoming: CampaignDraft, dirty: Set<string>) {
  if (!dirty.size || current.id !== incoming.id) return incoming;
  return {
    ...incoming,
    posts: incoming.posts.map((post) => {
      const localPost = current.posts.find((item) => item.id === post.id);
      if (!localPost) return post;
      return {
        ...post,
        ...(dirty.has(`context:${post.id}`) ? {
          context: localPost.context,
          contextStatus: localPost.contextStatus,
          contextSource: localPost.contextSource,
        } : {}),
        comments: post.comments.map((comment) => {
          if (!dirty.has(`comment:${comment.id}`)) return comment;
          const local = localPost.comments.find((item) => item.id === comment.id);
          return local ? { ...comment, text: local.text, intention: local.intention, tone: local.tone, status: local.status, source: local.source } : comment;
        }),
      };
    }),
  };
}

async function apiRequest<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const payload = await response.json() as { success: boolean; data?: T; message?: string };
  if (!response.ok || !payload.success || !payload.data) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload.data;
}

function draftKey(platform: Platform) {
  return platform === "facebook" ? "facebookDraft" : "tiktokDraft";
}

function updateDraft(state: ControlState, platform: Platform, update: (draft: CampaignDraft) => CampaignDraft): ControlState {
  const key = draftKey(platform);
  return { ...state, [key]: update(state[key]) };
}

function resetWorkflow(draft: CampaignDraft): CampaignDraft {
  return {
    ...draft,
    status: "draft",
    posts: [],
    assignments: [],
    selectedPostId: null,
  };
}

function validateDeviceEditor(state: ControlState) {
  const modal = state.activeModal;
  const editor = state.demoOperations.deviceEditor;
  if (!editor || modal?.type !== "edit-device") return null;
  const others = state.devices.filter((item) => item.id !== modal.deviceId);
  const errors = {
    ...(!editor.alias.trim() ? { alias: "El alias es obligatorio" } : {}),
    ...(!Number.isInteger(editor.order) || editor.order < 1 ? { order: "Usa un entero positivo" } : {}),
    ...(others.some((item) => item.order === editor.order) ? { order: "El orden ya está asignado" } : {}),
    ...(!editor.serial.trim() ? { serial: "El serial es obligatorio" } : {}),
    ...(editor.serial.length > 120 ? { serial: "Máximo 120 caracteres" } : {}),
    ...(/[\u0000-\u001f\u007f]/.test(editor.serial) ? { serial: "Contiene caracteres de control" } : {}),
    ...(others.some((item) => item.serial.toLowerCase() === editor.serial.trim().toLowerCase()) ? { serial: "El serial ya está registrado" } : {}),
    ...(!Number.isInteger(editor.systemPort) || editor.systemPort < 8200 || editor.systemPort > 8299
      ? { systemPort: "Debe estar entre 8200 y 8299" }
      : {}),
    ...(others.some((item) => item.systemPort === editor.systemPort) ? { systemPort: "El puerto ya está asignado" } : {}),
    ...(editor.facebookAccount.length > 300 ? { facebookAccount: "Máximo 300 caracteres" } : {}),
    ...(/[\u0000-\u001f\u007f]/.test(editor.facebookAccount) ? { facebookAccount: "Contiene caracteres de control" } : {}),
  };
  return { editor, errors, deviceId: modal.deviceId };
}

// ponytail: the prototype keeps transitions in memory; split by domain when persisted runtime services replace this demo state.
function controlReducer(state: ControlState, action: ControlAction): ControlState {
  switch (action.type) {
    case "tick":
      return { ...state, demoOperations: { ...state.demoOperations, now: action.now } };
    case "hydrate-devices": {
      const deviceIds = new Set(action.devices.map((device) => device.id));
      return {
        ...state,
        devices: action.devices,
        demoOperations: {
          ...state.demoOperations,
          selectedDeviceIds: state.demoOperations.selectedDeviceIds.filter((deviceId) => deviceIds.has(deviceId)),
        },
      };
    }
    case "hydrate-facebook":
      if (!action.force
         && state.facebookDraft.id === action.draft.id
         && (state.facebookDraft.revision ?? 0) >= (action.draft.revision ?? 0)
         && state.facebookDraft.controlledAccount === action.draft.controlledAccount) return state;
      return {
        ...state,
        facebookDraft: {
          ...action.draft,
          selectedPostId: action.draft.posts.some((post) => post.id === state.facebookDraft.selectedPostId)
            ? state.facebookDraft.selectedPostId
            : action.draft.selectedPostId,
        },
      };
    case "hydrate-tiktok":
      if (!action.force
         && state.tiktokDraft.id === action.draft.id
         && (state.tiktokDraft.revision ?? 0) >= (action.draft.revision ?? 0)) return state;
      return {
        ...state,
        tiktokDraft: {
          ...action.draft,
          selectedPostId: action.draft.posts.some((post) => post.id === state.tiktokDraft.selectedPostId)
            ? state.tiktokDraft.selectedPostId
            : action.draft.selectedPostId,
        },
      };
    case "hydrate-history":
      return { ...state, history: [...action.history, ...state.history.filter((item) => item.platform !== action.platform)] };
    case "set-notice":
      return { ...state, notice: action.notice };
    case "navigate":
      return { ...state, activeView: action.view };
    case "clear-notice":
      return { ...state, notice: null };
    case "set-device-import":
      return {
        ...state,
        demoOperations: { ...state.demoOperations, deviceImportText: action.value, deviceImportErrors: [] },
      };
    case "add-devices": {
      const parsed = parseDeviceInput(state.demoOperations.deviceImportText, state.devices);
      if (parsed.errors.length || parsed.serials.length === 0) {
        return {
          ...state,
          notice: parsed.serials.length === 0 && parsed.errors.length === 0
            ? { kind: "error", title: "No hay seriales", message: "Escribe al menos un identificador ADB." }
            : { kind: "error", title: "Revisa la lista", message: "Corrige los errores por línea antes de agregar dispositivos." },
          demoOperations: { ...state.demoOperations, deviceImportErrors: parsed.errors },
        };
      }
      return state;
    }
    case "set-device-search":
      return { ...state, demoOperations: { ...state.demoOperations, deviceSearch: action.value } };
    case "toggle-device-selection": {
      const selected = state.demoOperations.selectedDeviceIds.includes(action.deviceId);
      return {
        ...state,
        demoOperations: {
          ...state.demoOperations,
          selectedDeviceIds: selected
            ? state.demoOperations.selectedDeviceIds.filter((id) => id !== action.deviceId)
            : [...state.demoOperations.selectedDeviceIds, action.deviceId],
        },
      };
    }
    case "select-visible-devices": {
      const visible = new Set(action.deviceIds);
      const selectedDeviceIds = action.selected
        ? [...new Set([...state.demoOperations.selectedDeviceIds, ...action.deviceIds])]
        : state.demoOperations.selectedDeviceIds.filter((id) => !visible.has(id));
      return { ...state, demoOperations: { ...state.demoOperations, selectedDeviceIds } };
    }
    case "open-device-editor": {
      const device = state.devices.find((item) => item.id === action.deviceId);
      if (!device) return state;
      return {
        ...state,
        activeModal: { type: "edit-device", deviceId: device.id },
        demoOperations: {
          ...state.demoOperations,
          deviceEditor: {
            alias: device.alias,
            order: device.order,
            serial: device.serial,
            systemPort: device.systemPort,
            facebookAccount: device.facebookAccount ?? "",
            errors: {},
          },
        },
      };
    }
    case "update-device-editor": {
      const editor = state.demoOperations.deviceEditor;
      if (!editor) return state;
      return {
        ...state,
        demoOperations: { ...state.demoOperations, deviceEditor: { ...editor, [action.field]: action.value, errors: {} } },
      };
    }
    case "save-device": {
      const validation = validateDeviceEditor(state);
      if (!validation) return state;
      if (Object.keys(validation.errors).length) {
        return {
          ...state,
          demoOperations: {
            ...state.demoOperations,
            deviceEditor: { ...validation.editor, errors: validation.errors },
          },
        };
      }
      return {
        ...state,
        devices: state.devices.map((item) => {
          if (item.id !== validation.deviceId) return item;
          const changedIdentity = item.serial !== validation.editor.serial.trim() || item.systemPort !== validation.editor.systemPort;
          return {
            ...item,
            alias: validation.editor.alias.trim(),
            order: validation.editor.order,
            serial: validation.editor.serial.trim(),
            systemPort: validation.editor.systemPort,
            facebookAccount: validation.editor.facebookAccount.trim() || null,
            preparation: changedIdentity ? "not_ready" : item.preparation,
            preparationStep: changedIdentity ? undefined : item.preparationStep,
          };
        }),
        activeModal: null,
        notice: { kind: "status", title: "Dispositivo actualizado", message: "Perfil y cuenta esperada guardados en SQLite." },
        demoOperations: { ...state.demoOperations, deviceEditor: null },
      };
    }
    case "request-device-retirement": {
      const device = state.devices.find((item) => item.id === action.deviceId);
      if (!device) return state;
      if (device.activity === "available") {
        return {
          ...state,
          devices: state.devices.filter((item) => item.id !== device.id),
          notice: { kind: "status", title: "Dispositivo retirado", message: "Sus referencias históricas se conservaron." },
        };
      }
      return { ...state, activeModal: { type: "retire-device", deviceId: device.id } };
    }
    case "confirm-device-retirement": {
      const modal = state.activeModal;
      if (modal?.type !== "retire-device") return state;
      return {
        ...state,
        devices: state.devices.map((item) => item.id === modal.deviceId ? { ...item, retireAfterCampaign: true } : item),
        activeModal: null,
        notice: { kind: "status", title: "Retiro programado", message: "El equipo se retirará al finalizar; la campaña no fue cancelada." },
      };
    }
    case "request-clear-devices":
      return state.devices.length ? { ...state, activeModal: { type: "clear-devices" } } : state;
    case "start-device-preparation":
      return {
        ...state,
        devices: state.devices.map((item) => action.deviceIds.includes(item.id)
          ? { ...item, preparation: "preparing", preparationStep: "En cola para comprobar Appium" }
          : item),
        notice: { kind: "status", title: "Comprobación Appium iniciada", message: `${action.deviceIds.length} equipo(s) quedaron en cola. Se verificará ADB, la sesión UiAutomator2 y su jerarquía.` },
      };
    case "advance-device-preparation":
      return { ...state, devices: state.devices.map((item) => item.id === action.deviceId ? { ...item, preparationStep: action.step } : item) };
    case "finish-device-preparation":
      return {
        ...state,
        devices: state.devices.map((item) => item.id === action.deviceId
          ? {
              ...item,
              preparation: action.failed ? "failed" : "ready",
              preparationStep: action.failed ? "Falló la lectura de jerarquía" : "Listo",
              connection: action.failed ? item.connection : "connected",
              capabilities: action.failed ? item.capabilities : { facebook: "ready", tiktok: "ready" },
              lastPreparation: action.failed ? item.lastPreparation : state.demoOperations.now,
            }
          : item),
      };
    case "set-campaign-devices":
      return updateDraft(state, action.platform, (draft) => {
        const next = resetWorkflow({ ...draft, selectedDeviceIds: action.deviceIds });
        if (next.distribution.length === 1) next.distribution = [{ ...next.distribution[0], count: action.deviceIds.length }];
        return next;
      });
    case "set-campaign-urls": {
      const parsed = parseCampaignUrls(action.value, action.platform);
      return updateDraft(state, action.platform, (draft) => resetWorkflow({
        ...draft,
        urlInput: action.value,
        urls: parsed.urls,
        urlErrors: parsed.errors,
      }));
    }
    case "remove-campaign-url":
      return updateDraft(state, action.platform, (draft) => {
        const urls = draft.urls.filter((_, index) => index !== action.index);
        return resetWorkflow({ ...draft, urls, urlInput: urls.join("\n"), urlErrors: [] });
      });
    case "move-campaign-url":
      return updateDraft(state, action.platform, (draft) => {
        const target = action.index + action.direction;
        if (target < 0 || target >= draft.urls.length) return draft;
        const urls = [...draft.urls];
        [urls[action.index], urls[target]] = [urls[target], urls[action.index]];
        return resetWorkflow({ ...draft, urls, urlInput: urls.join("\n") });
      });
    case "toggle-campaign-action":
      return updateDraft(state, action.platform, (draft) => resetWorkflow({
        ...draft,
        actions: { ...draft.actions, [action.action]: !draft.actions[action.action] },
      }));
    case "add-distribution":
      return updateDraft(state, action.platform, (draft) => resetWorkflow({
        ...draft,
        distribution: [...draft.distribution, { id: `${action.platform}-intent-${Date.now()}`, intention: "Nueva intención", tone: "Cercano", count: 0 }],
      }));
    case "remove-distribution":
      return updateDraft(state, action.platform, (draft) => resetWorkflow({
        ...draft,
        distribution: draft.distribution.filter((item) => item.id !== action.id),
      }));
    case "update-distribution":
      return updateDraft(state, action.platform, (draft) => resetWorkflow({
        ...draft,
        distribution: draft.distribution.map((item) => item.id === action.id ? { ...item, [action.field]: action.value } : item),
      }));
    case "prepare-campaign":
      return updateDraft(state, action.platform, (draft) => {
        const built = buildAssignments(draft);
        return {
          ...draft,
          ...built,
          status: draft.actions.comment ? "preparing" : "ready",
          selectedPostId: built.posts[0]?.id ?? null,
        };
      });
    case "campaign-requested":
      return updateDraft(state, action.platform, (draft) => ({ ...draft, status: "preparing" }));
    case "campaign-request-failed":
      return updateDraft(state, action.platform, (draft) => ({ ...draft, status: "draft" }));
    case "advance-post":
      return updateDraft(state, action.platform, (draft) => {
        const posts = draft.posts.map((post) => {
          if (post.id !== action.postId) return post;
          if (action.stage === "failed") {
            return {
              ...post,
              status: "partial_failed" as const,
              contextStatus: "failed" as const,
              error: "La extracción simulada falló de forma aislada.",
              comments: post.comments.map((comment) => ({ ...comment, status: "failed" as const, error: "Sin contexto para generar" })),
            };
          }
          if (action.stage === "context") {
            const context = `Contexto simulado para la publicación ${post.position}: tema principal, tono y señales útiles para respuestas naturales.`;
            return {
              ...post,
              status: "generating" as const,
              contextStatus: "ready" as const,
              context,
              extractedContext: context,
              contextSource: "extracted" as const,
              extractedAt: state.demoOperations.now,
              elapsedSeconds: 4 + post.position,
              comments: post.comments.map((comment) => ({ ...comment, status: "generating" as const })),
            };
          }
          return {
            ...post,
            status: "ready" as const,
            comments: post.comments.map((comment, index) => ({
              ...comment,
              text: `${comment.tone === "Breve" ? "Buena propuesta" : "Me gustó esta publicación y la forma clara de presentar la idea"}${index % 2 ? "." : ", gracias por compartirla."}`,
              status: "ready" as const,
              stale: false,
              error: undefined,
            })),
          };
        });
        const finished = posts.every((post) => post.status === "ready" || post.status === "partial_failed");
        return { ...draft, posts, status: finished ? "ready" : draft.status };
      });
    case "select-post":
      return updateDraft(state, action.platform, (draft) => ({ ...draft, selectedPostId: action.postId }));
    case "edit-context":
      return updateDraft(state, action.platform, (draft) => ({
        ...draft,
        posts: draft.posts.map((post) => post.id === action.postId
          ? {
              ...post,
              context: action.value,
              contextStatus: "edited",
              contextSource: "manual",
              status: "context_ready",
              error: undefined,
              comments: post.comments.map((comment) => ({ ...comment, stale: true })),
            }
          : post),
      }));
    case "save-context":
      return state;
    case "restore-context":
      return updateDraft(state, action.platform, (draft) => ({
        ...draft,
        posts: draft.posts.map((post) => post.id === action.postId
          ? { ...post, context: post.extractedContext, contextStatus: "ready", contextSource: "extracted", comments: post.comments.map((comment) => ({ ...comment, stale: true })) }
          : post),
      }));
    case "retry-context":
      return updateDraft(state, action.platform, (draft) => ({
        ...draft,
        status: "preparing",
        posts: draft.posts.map((post) => post.id === action.postId
          ? { ...post, status: "extracting", contextStatus: "extracting", error: undefined }
          : post),
      }));
    case "edit-comment":
      return updateDraft(state, action.platform, (draft) => ({
        ...draft,
        posts: draft.posts.map((post) => post.id === action.postId
          ? { ...post, comments: post.comments.map((comment) => comment.id === action.commentId ? { ...comment, text: action.value, status: "edited", stale: false, source: "manual" } : comment) }
          : post),
      }));
    case "save-comment":
      return state;
    case "update-comment-profile":
      return updateDraft(state, action.platform, (draft) => ({
        ...draft,
        posts: draft.posts.map((post) => post.id === action.postId
          ? {
              ...post,
              comments: post.comments.map((comment) => comment.id === action.commentId
                ? {
                    ...comment,
                    intention: action.field === "intention" ? action.value : comment.intention,
                    tone: action.field === "tone" ? action.value : comment.tone,
                    stale: true,
                  }
                : comment),
            }
          : post),
      }));
    case "start-comment-regeneration":
      return updateDraft({ ...state, activeModal: null }, action.platform, (draft) => ({
        ...draft,
        posts: draft.posts.map((post) => post.id === action.postId
          ? { ...post, comments: post.comments.map((comment) => action.commentIds.includes(comment.id) ? { ...comment, status: "regenerating", stale: false } : comment) }
          : post),
      }));
    case "finish-comment-regeneration":
      return updateDraft(state, action.platform, (draft) => ({
        ...draft,
        posts: draft.posts.map((post) => post.id === action.postId
          ? {
              ...post,
              status: "ready",
              comments: post.comments.map((comment) => action.commentIds.includes(comment.id)
                ? { ...comment, text: `Nueva versión ${comment.tone.toLowerCase()} para esta publicación.`, status: "ready", stale: false, source: "generated", error: undefined }
                : comment),
            }
          : post),
      }));
    case "request-regenerate-post": {
      const draft = state[draftKey(action.platform)];
      const post = draft.posts.find((item) => item.id === action.postId);
      if (!post) return state;
      return post.comments.some((comment) => comment.status === "edited")
        ? { ...state, activeModal: { type: "regenerate-post", platform: action.platform, postId: action.postId } }
        : state;
    }
    case "set-schedule-deadline":
      return updateDraft(state, action.platform, (draft) => ({ ...draft, scheduleDeadline: action.value }));
    case "advance-running-campaign": {
      const key = draftKey(action.platform);
      const draft = state[key];
      const active = state.history.find((item) => item.platform === action.platform && item.status === "running");
      if (!active) return state;
      const limit = Math.max(1, Math.floor(active.assignments.length / 2));
      return {
        ...state,
        [key]: {
          ...draft,
          assignments: draft.assignments.map((item, index) => index < limit ? { ...item, status: "sent" } : item),
          posts: draft.posts.map((post, index) => index === 0 ? { ...post, status: "completed" } : post),
        },
        history: state.history.map((campaign) => campaign.id === active.id
          ? {
              ...campaign,
              completedAssignments: limit,
              assignments: campaign.assignments.map((item, index) => index < limit
                ? { ...item, status: "sent", actualAt: state.demoOperations.now, likeResult: campaign.actions.like ? "ok" : "not_requested", commentResult: campaign.actions.comment ? "ok" : "not_requested", attempts: 1, cleanup: "home_confirmed" }
                : { ...item, status: "running", actualAt: state.demoOperations.now, attempts: 1 })
            }
          : campaign),
      };
    }
    case "clear-campaign": {
      const next = createInitialState(state.demoOperations.now)[draftKey(action.platform)];
      return updateDraft(state, action.platform, () => ({
        ...next,
        id: state[draftKey(action.platform)].id,
        revision: state[draftKey(action.platform)].revision,
        selectedDeviceIds: [],
        urlInput: "",
        urls: [],
        distribution: [{ ...next.distribution[0], count: 0 }],
      }));
    }
    case "set-history-filter":
      return {
        ...state,
        demoOperations: {
          ...state.demoOperations,
          historyFilters: { ...state.demoOperations.historyFilters, [action.field]: action.value },
        },
      };
    case "open-history":
      return { ...state, activeModal: { type: "history-detail", campaignId: action.campaignId } };
    case "request-abort":
      return {
        ...state,
        activeModal: { type: "abort-all" },
        demoOperations: { ...state.demoOperations, abort: { active: false, step: 0, deviceCleanup: {} } },
      };
    case "start-abort": {
      const busyDevices = state.devices.filter((item) => item.activity === "busy");
      return {
        ...state,
        facebookDraft: ["running", "preparing", "scheduled"].includes(state.facebookDraft.status) ? { ...state.facebookDraft, status: "cancellation_requested" } : state.facebookDraft,
        tiktokDraft: ["running", "preparing", "scheduled"].includes(state.tiktokDraft.status) ? { ...state.tiktokDraft, status: "cancellation_requested" } : state.tiktokDraft,
        history: state.history.map((item) => item.status === "running" ? { ...item, status: "cancellation_requested" } : item),
        demoOperations: {
          ...state.demoOperations,
          abort: { active: true, step: 0, deviceCleanup: Object.fromEntries(busyDevices.map((item) => [item.id, "pending"])) },
        },
      };
    }
    case "advance-abort":
      return {
        ...state,
        demoOperations: {
          ...state.demoOperations,
          abort: {
            ...state.demoOperations.abort,
            step: action.step,
            deviceCleanup: Object.fromEntries(Object.keys(state.demoOperations.abort.deviceCleanup).map((id, index) => [
              id,
              action.step < 2 ? "cancelling" : action.step < 4 ? "session_closed" : index === 0 ? "cleanup_unknown" : "home_confirmed",
            ])),
          },
        },
      };
    case "finish-abort":
      return {
        ...state,
        facebookDraft: state.facebookDraft.status === "cancellation_requested" ? { ...state.facebookDraft, status: "cancelled_with_cleanup_errors" } : state.facebookDraft,
        tiktokDraft: state.tiktokDraft.status === "cancellation_requested" ? { ...state.tiktokDraft, status: "cancelled_with_cleanup_errors" } : state.tiktokDraft,
        history: state.history.map((item) => item.status === "cancellation_requested"
          ? { ...item, status: "cancelled_with_cleanup_errors", cancellationReason: "Aborto global simulado; un cleanup quedó incierto." }
          : item),
        devices: state.devices.map((item) => item.activity === "busy" ? { ...item, activity: item.id === "device-01" ? "recovery_required" : "available" } : item),
        demoOperations: { ...state.demoOperations, abort: { ...state.demoOperations.abort, active: false, step: 5 } },
        notice: { kind: "error", title: "Aborto finalizado con una advertencia", message: "Una confirmación Home quedó incierta. GenFarmer no fue afectado." },
      };
    case "close-modal":
      return { ...state, activeModal: null, demoOperations: { ...state.demoOperations, deviceEditor: null } };
    default:
      return state;
  }
}

function navCount(state: ControlState, view: ViewId) {
  if (view === "devices") return state.devices.filter((item) => item.connection !== "connected" || item.preparation === "failed").length;
  if (view === "history") return state.history.filter((item) => item.status === "running" || item.status === "completed_with_issues").length;
  const draft = state[draftKey(view)];
  return draft.status === "draft" ? draft.urls.length : draft.assignments.length;
}

function NavIcon({ view }: { view: ViewId }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

  if (view === "devices") {
    return <svg viewBox="0 0 24 24"><rect {...common} x="6" y="2.5" width="12" height="19" rx="2" /><path {...common} d="M10 18.5h4" /></svg>;
  }
  if (view === "facebook") {
    return <svg viewBox="0 0 24 24"><path {...common} d="M5 5.5h14v10H9l-4 3v-13Z" /><path {...common} d="M10 9h4M10 12h2" /></svg>;
  }
  if (view === "tiktok") {
    return <svg viewBox="0 0 24 24"><path {...common} d="M14 4v10.5a3.5 3.5 0 1 1-2-3.16V7.5c2.6 0 4.6.64 6 2" /></svg>;
  }
  return <svg viewBox="0 0 24 24"><circle {...common} cx="12" cy="12" r="8" /><path {...common} d="M12 7v5l3 2" /></svg>;
}

export function ControlPanel() {
  const [state, rawDispatch] = useReducer(controlReducer, createInitialState("2026-09-03T16:20:00.000Z"));
  const [clearingDevices, setClearingDevices] = useState(false);
  const [clearDevicesError, setClearDevicesError] = useState<string | null>(null);
  const [hasUncertainDeviceSessions, setHasUncertainDeviceSessions] = useState(false);
  const [recoveringDeviceSessions, setRecoveringDeviceSessions] = useState(false);
  const [tiktokConfiguration, setTikTokConfiguration] = useState<TikTokConfiguration>({
    controlledAccount: null,
    postEffectsEnabled: false,
    liveEffectsEnabled: false,
    postSelectorsConfigured: false,
    commentSelectorsConfigured: false,
    liveSelectorsConfigured: false,
    liveCalibration: null,
    liveCalibrations: [],
  });
  const timers = useRef<number[]>([]);
  const dirtyFacebookFields = useRef(new Set<string>());
  const dirtyTikTokFields = useRef(new Set<string>());
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    let reportedError = false;
    let lastCampaignsAt = 0;
    let lastView = stateRef.current.activeView;
    const scheduledTimers = timers.current;
    const CAMPAIGN_POLL_MS = 30_000;
    const refresh = async (campaignsDue = false) => {
      if (refreshing) return;
      refreshing = true;
      try {
         const activeView = stateRef.current.activeView;
         const now = Date.now();
         const wantCampaigns = campaignsDue || now - lastCampaignsAt >= CAMPAIGN_POLL_MS;
         if (wantCampaigns) lastCampaignsAt = now;
         const [deviceData, campaignData, tiktokData] = await Promise.all([
           apiRequest<{ devices: DeviceSnapshot[] }>("/api/devices"),
           wantCampaigns && (activeView === "facebook" || activeView === "history")
             ? apiRequest<{ campaign: FacebookSnapshot | null; history: FacebookSnapshot[] }>("/api/facebook/campaigns")
             : Promise.resolve(null),
           wantCampaigns && (activeView === "tiktok" || activeView === "history")
             ? apiRequest<{ campaign: FacebookSnapshot | null; history: FacebookSnapshot[]; configuration: TikTokConfiguration }>("/api/tiktok/campaigns")
             : Promise.resolve(null),
         ]);
         if (!active) return;
         const devices = mapDeviceSnapshots(deviceData.devices);
         rawDispatch({ type: "hydrate-devices", devices });
         if (campaignData) rawDispatch({ type: "hydrate-history", platform: "facebook", history: mapCampaignHistory(campaignData.history, devices) });
         if (tiktokData) {
           rawDispatch({ type: "hydrate-history", platform: "tiktok", history: mapCampaignHistory(tiktokData.history, devices) });
           setTikTokConfiguration(tiktokData.configuration);
         }
         if (campaignData?.campaign) {
           const incoming = mapCampaignSnapshot(campaignData.campaign);
           rawDispatch({
             type: "hydrate-facebook",
             draft: preserveDirtyFacebookFields(stateRef.current.facebookDraft, incoming, dirtyFacebookFields.current),
             force: dirtyFacebookFields.current.size > 0,
           });
         }
         if (tiktokData?.campaign) {
           const incoming = mapCampaignSnapshot(tiktokData.campaign);
           rawDispatch({
             type: "hydrate-tiktok",
             draft: preserveDirtyFacebookFields(stateRef.current.tiktokDraft, incoming, dirtyTikTokFields.current),
             force: dirtyTikTokFields.current.size > 0,
           });
         }
        reportedError = false;
      } catch (error) {
        if (active && !reportedError) {
          reportedError = true;
          rawDispatch({
            type: "set-notice",
            notice: { kind: "error", title: "No se pudo actualizar el snapshot", message: error instanceof Error ? error.message : String(error) },
          });
        }
      } finally {
        refreshing = false;
      }
    };
    const tick = () => {
      if (document.hidden) return;
      const view = stateRef.current.activeView;
      const viewChanged = view !== lastView;
      lastView = view;
      rawDispatch({ type: "tick", now: new Date().toISOString() });
      void refresh(viewChanged);
    };
    const onVisibilityChange = () => {
      if (!document.hidden) void refresh(true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    rawDispatch({ type: "tick", now: new Date().toISOString() });
    void refresh(true);
    const timer = window.setInterval(tick, 5_000);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(timer);
      scheduledTimers.forEach(window.clearTimeout);
    };
  }, []);

  const later = (callback: () => void, delay: number) => {
    timers.current.push(window.setTimeout(callback, delay));
  };

  const hydrateFacebookWhenIdle = (campaign: FacebookSnapshot) => {
    const incoming = mapCampaignSnapshot(campaign);
    rawDispatch({
      type: "hydrate-facebook",
      draft: preserveDirtyFacebookFields(stateRef.current.facebookDraft, incoming, dirtyFacebookFields.current),
      force: dirtyFacebookFields.current.size > 0,
    });
  };

  const hydrateTikTokWhenIdle = (campaign: FacebookSnapshot) => {
    const incoming = mapCampaignSnapshot(campaign);
    rawDispatch({
      type: "hydrate-tiktok",
      draft: preserveDirtyFacebookFields(stateRef.current.tiktokDraft, incoming, dirtyTikTokFields.current),
      force: dirtyTikTokFields.current.size > 0,
    });
  };

  const pollOperation = (id: string, platform: Platform = "facebook") => {
    void apiRequest<{
      operation: {
        id: string;
        kind: string;
        status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";
        campaignId: string | null;
        error: string | null;
      };
    }>(`/api/operations/${id}`).then(({ operation }) => {
      if (["pending", "running"].includes(operation.status)) {
        later(() => pollOperation(id, platform), 1_000);
        return;
      }
      if (operation.campaignId) {
        void Promise.all([
          apiRequest<{ campaign: FacebookSnapshot }>(`/api/${platform}/campaigns/${operation.campaignId}`),
          apiRequest<{ history: FacebookSnapshot[] }>(`/api/${platform}/campaigns`),
        ]).then(([{ campaign }, { history }]) => {
          if (platform === "facebook") hydrateFacebookWhenIdle(campaign);
          else if (campaign.mode !== "live") hydrateTikTokWhenIdle(campaign);
          rawDispatch({ type: "hydrate-history", platform, history: mapCampaignHistory(history, stateRef.current.devices) });
        });
      }
      if (operation.status === "succeeded") {
        rawDispatch({
          type: "set-notice",
          notice: { kind: "status", title: "Operación completada", message: "El resultado y el cleanup quedaron persistidos." },
        });
        return;
      }
      if (operation.kind === "campaign.create") rawDispatch({ type: "campaign-request-failed", platform });
      rawDispatch({
        type: "set-notice",
        notice: {
          kind: "error",
          title: operation.status === "outcome_unknown"
            ? "Requiere reconciliación manual"
            : operation.status === "cancelled"
              ? "Operación cancelada"
              : "La operación no se completó",
          message: operation.error || (operation.status === "outcome_unknown"
            ? "Una acción pública pudo ocurrir. No se ofrecerá reintento automático."
            : "El worker detuvo la operación."),
        },
      });
    }).catch(() => later(() => pollOperation(id, platform), 1_000));
  };

  const dispatch: ControlDispatch = (action) => {
    if (action.type === "add-devices") {
      const parsed = parseDeviceInput(state.demoOperations.deviceImportText, state.devices);
      if (parsed.errors.length || parsed.serials.length === 0) {
        rawDispatch(action);
        return;
      }
      void apiRequest<{ devices: DeviceSnapshot[] }>("/api/devices", {
        method: "POST",
        headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
        body: JSON.stringify({ serials: parsed.serials }),
      }).then(({ devices }) => {
        rawDispatch({ type: "hydrate-devices", devices: mapDeviceSnapshots(devices) });
        rawDispatch({ type: "set-device-import", value: "" });
        rawDispatch({
          type: "set-notice",
          notice: { kind: "status", title: `${parsed.serials.length} dispositivos incorporados`, message: "La identidad física y el perfil quedaron persistidos en SQLite." },
        });
      }).catch((error: unknown) => rawDispatch({
        type: "set-notice",
        notice: { kind: "error", title: "No se pudieron incorporar los dispositivos", message: error instanceof Error ? error.message : String(error) },
      }));
      return;
    }

    if (action.type === "request-clear-devices") {
      setClearDevicesError(null);
      setHasUncertainDeviceSessions(false);
      rawDispatch(action);
      return;
    }

    if (action.type === "confirm-clear-devices") {
      if (clearingDevices) return;
      setClearingDevices(true);
      setClearDevicesError(null);
      void apiRequest<{ cleared: number; devices: DeviceSnapshot[] }>("/api/devices", {
        method: "DELETE",
        headers: { "x-control-panel-client": "control-panel" },
      }).then(({ cleared, devices }) => {
        setHasUncertainDeviceSessions(false);
        rawDispatch({ type: "close-modal" });
        rawDispatch({ type: "hydrate-devices", devices: mapDeviceSnapshots(devices) });
        rawDispatch({
          type: "set-notice",
          notice: { kind: "status", title: "Lista de dispositivos borrada", message: `${cleared} equipo(s) se retiraron de la lista. El historial se conserva.` },
        });
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setClearDevicesError(message);
        setHasUncertainDeviceSessions(message.includes("resultado incierto"));
      }).finally(() => setClearingDevices(false));
      return;
    }

    if (action.type === "recover-device-sessions") {
      if (recoveringDeviceSessions) return;
      setRecoveringDeviceSessions(true);
      setClearDevicesError(null);
      void apiRequest<{ queued: boolean; devices: DeviceSnapshot[] }>("/api/devices/recover", {
        method: "POST",
        headers: { "x-control-panel-client": "control-panel" },
      }).then(({ devices, queued }) => {
        rawDispatch({ type: "hydrate-devices", devices: mapDeviceSnapshots(devices) });
        rawDispatch({ type: "set-notice", notice: queued
          ? { kind: "status", title: "Recuperación solicitada", message: "El worker recuperará solo sesiones inciertas. Después puedes volver a borrar la lista." }
          : { kind: "status", title: "Sesiones recuperadas", message: "El resultado incierto sigue disponible para reconciliarse desde Historial." },
        });
      }).catch((error: unknown) => {
        setClearDevicesError(error instanceof Error ? error.message : String(error));
      }).finally(() => setRecoveringDeviceSessions(false));
      return;
    }

    if (action.type === "request-start-campaign" && action.platform === "facebook") {
      const draft = state.facebookDraft;
      if (dirtyFacebookFields.current.size) {
        rawDispatch({
          type: "set-notice",
          notice: { kind: "error", title: "Hay cambios sin guardar", message: "Guarda el contexto y el comentario antes de publicar." },
        });
        return;
      }
      if (!draft.id || !draft.revision || !draft.assignments.length) return;
      const deadlineValue = draft.scheduleDeadline ? new Date(draft.scheduleDeadline).getTime() : null;
      const scheduledByDevice = randomDeviceSchedule(draft.selectedDeviceIds, Date.now(), deadlineValue);
      const confirmations = draft.assignments.map((assignment) => {
        const post = draft.posts.find((item) => item.id === assignment.postId);
        const device = state.devices.find((item) => item.id === assignment.deviceId);
        const comment = post?.comments.find((item) => item.assignmentId === assignment.id);
        const targetText = post?.context.trim().slice(0, 500) ?? "";
        if (!post || targetText.length < 5 || !device?.facebookAccount
          || (draft.actions.comment && (!comment?.version || !comment.textHash))) return null;
        return {
          assignmentId: assignment.id,
          postId: post.id,
          deviceId: assignment.deviceId,
          expectedAccount: device.facebookAccount,
          expectedPostUrl: post.finalUrl || post.url,
          expectedTargetText: targetText,
          scheduledAt: scheduledByDevice.get(assignment.deviceId) ?? Date.now(),
          expectedComment: comment
            ? { id: comment.id, version: comment.version!, textHash: comment.textHash! }
            : null,
        };
      });
      if (confirmations.some((confirmation) => !confirmation)) {
        rawDispatch({
          type: "set-notice",
          notice: { kind: "error", title: "Falta completar la publicación", message: "Verifica la cuenta de cada dispositivo y el texto visible (mínimo 5 caracteres) de cada publicación." },
        });
        return;
      }
      const validConfirmations = confirmations as Array<NonNullable<(typeof confirmations)[number]>>;
      const sharedAccounts = new Set(validConfirmations.map((confirmation) => confirmation.expectedAccount.normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase("es")))
        .size < new Set(validConfirmations.map((confirmation) => confirmation.deviceId)).size;
      void apiRequest<{ operation: { id: string } }>(`/api/facebook/campaigns/${draft.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          expectedRevision: draft.revision,
          expectedActions: draft.actions,
          assignments: validConfirmations,
          allowSharedAccounts: sharedAccounts,
          sharedAccountsConfirmed: sharedAccounts,
          confirmed: true,
          controlledAccount: true,
          controlledContent: true,
        }),
      }).then(({ operation }) => {
        pollOperation(operation.id);
        rawDispatch({
          type: "set-notice",
          notice: { kind: "status", title: "Campaña publicada", message: "El worker revalidará cada dispositivo, cuenta y publicación antes de cualquier efecto." },
        });
      }).catch((error: unknown) => rawDispatch({
        type: "set-notice",
        notice: { kind: "error", title: "No se pudo publicar la campaña", message: error instanceof Error ? error.message : String(error) },
      }));
      return;
    }

    if (action.type === "request-start-campaign" && action.platform === "tiktok") {
      const draft = state.tiktokDraft;
      if (dirtyTikTokFields.current.size) {
        rawDispatch({ type: "set-notice", notice: { kind: "error", title: "Hay cambios sin guardar", message: "Guarda el contexto y el comentario antes de publicar." } });
        return;
      }
      if (!draft.id || !draft.revision || !draft.assignments.length || !tiktokConfiguration.controlledAccount) {
        rawDispatch({ type: "set-notice", notice: { kind: "error", title: "Falta configuración TikTok", message: "Configura la cuenta controlada, los selectores y completa los comentarios." } });
        return;
      }
      if (!tiktokConfiguration.postEffectsEnabled || !tiktokConfiguration.postSelectorsConfigured
        || (draft.actions.comment && !tiktokConfiguration.commentSelectorsConfigured)) {
        rawDispatch({ type: "set-notice", notice: { kind: "error", title: "Efectos TikTok bloqueados", message: "Habilita TIKTOK_PUBLIC_EFFECTS_ENABLED y configura los selectores verificados." } });
        return;
      }
      const confirmations = draft.assignments.map((assignment) => {
        const post = draft.posts.find((item) => item.id === assignment.postId);
        const device = state.devices.find((item) => item.id === assignment.deviceId);
        const comment = post?.comments.find((item) => item.assignmentId === assignment.id);
        const targetText = post?.context.trim().slice(0, 500) ?? "";
        if (!post || !device || targetText.length < 5
          || (draft.actions.comment && (!comment?.version || !comment.textHash))) return null;
        return {
          assignmentId: assignment.id,
          postId: post.id,
          deviceId: assignment.deviceId,
          expectedAccount: tiktokConfiguration.controlledAccount,
          expectedPostUrl: post.finalUrl || post.url,
          expectedTargetText: targetText,
          expectedComment: comment
            ? { id: comment.id, version: comment.version!, textHash: comment.textHash! }
            : null,
        };
      });
      if (confirmations.some((confirmation) => !confirmation)) {
        rawDispatch({ type: "set-notice", notice: { kind: "error", title: "Falta completar TikTok", message: "Genera o edita el comentario exacto de cada asignación y revisa el texto visible de cada publicación." } });
        return;
      }
      void apiRequest<{ operation: { id: string } }>(`/api/tiktok/campaigns/${draft.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          expectedRevision: draft.revision,
          expectedActions: draft.actions,
          assignments: confirmations as Array<NonNullable<(typeof confirmations)[number]>>,
          confirmed: true,
          controlledAccount: true,
          controlledContent: true,
        }),
      }).then(({ operation }) => {
        pollOperation(operation.id, "tiktok");
        rawDispatch({ type: "set-notice", notice: { kind: "status", title: "Ejecución TikTok en cola", message: "El worker revalidará cada dispositivo, cuenta, publicación y estado del Like." } });
      }).catch((error: unknown) => rawDispatch({ type: "set-notice", notice: { kind: "error", title: "No se pudo publicar TikTok", message: error instanceof Error ? error.message : String(error) } }));
      return;
    }

    if (action.type === "reconcile-assignment") {
      const platform = action.platform;
      void apiRequest<{ campaign: FacebookSnapshot }>(`/api/${platform}/assignments/${action.assignmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          operationId: action.operationId,
          action: action.action,
          resolution: action.resolution,
        }),
      }).then(({ campaign }) => {
        if (platform === "facebook") hydrateFacebookWhenIdle(campaign);
        else hydrateTikTokWhenIdle(campaign);
        void apiRequest<{ history: FacebookSnapshot[] }>(`/api/${platform}/campaigns`).then(({ history }) => {
          rawDispatch({ type: "hydrate-history", platform, history: mapCampaignHistory(history, stateRef.current.devices) });
        });
        rawDispatch({ type: "set-notice", notice: { kind: "status", title: "Reconciliación guardada", message: "No se creó ni reintentó ninguna acción móvil." } });
      }).catch((error: unknown) => rawDispatch({
        type: "set-notice",
        notice: { kind: "error", title: "No se pudo reconciliar", message: error instanceof Error ? error.message : String(error) },
      }));
      return;
    }

    if (action.type === "cancel-assignment") {
      void apiRequest(`/api/operations/${action.operationId}`, {
        method: "DELETE",
        headers: { "x-control-panel-client": "control-panel" },
      }).then(() => rawDispatch({
        type: "set-notice",
        notice: { kind: "status", title: "Cancelación registrada", message: "La asignación se detendrá sin bloquear otros dispositivos." },
      })).catch((error: unknown) => rawDispatch({
        type: "set-notice",
        notice: { kind: "error", title: "No se pudo cancelar la asignación", message: error instanceof Error ? error.message : String(error) },
      }));
      return;
    }

    if (action.type === "edit-context") {
      (action.platform === "facebook" ? dirtyFacebookFields : dirtyTikTokFields).current.add(`context:${action.postId}`);
      rawDispatch(action);
      return;
    }
    if (action.type === "edit-comment" || action.type === "update-comment-profile") {
      (action.platform === "facebook" ? dirtyFacebookFields : dirtyTikTokFields).current.add(`comment:${action.commentId}`);
      rawDispatch(action);
      return;
    }
    if ((action.type === "clear-campaign"
      || action.type === "set-campaign-devices"
      || action.type === "set-campaign-urls"
      || action.type === "toggle-campaign-action")
      ) {
      (action.platform === "facebook" ? dirtyFacebookFields : dirtyTikTokFields).current.clear();
    }

    if (action.type === "prepare-campaign") {
      const draft = state[draftKey(action.platform)];
      rawDispatch({ type: "campaign-requested", platform: action.platform });
      void apiRequest<{ operation: { id: string } }>(`/api/${action.platform}/campaigns`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          urls: draft.urls,
          deviceIds: draft.selectedDeviceIds,
          actions: draft.actions,
          distribution: draft.distribution.map(({ intention, tone, count }) => ({ intention, tone, count })),
        }),
      }).then(({ operation }) => {
        pollOperation(operation.id, action.platform);
        rawDispatch({
          type: "set-notice",
          notice: { kind: "status", title: "Campaña aceptada", message: action.platform === "tiktok" ? "El worker está creando el plan persistente TikTok N×M." : "El worker está creando el plan persistente read-only." },
        });
      }).catch((error: unknown) => {
        rawDispatch({ type: "campaign-request-failed", platform: action.platform });
        rawDispatch({
          type: "set-notice",
          notice: { kind: "error", title: "No se pudo crear la campaña", message: error instanceof Error ? error.message : String(error) },
        });
      });
      return;
    }

    if (action.type === "save-context") {
      const post = state[draftKey(action.platform)].posts.find((item) => item.id === action.postId);
      if (!post) return;
      void apiRequest<{ campaign: FacebookSnapshot }>(`/api/${action.platform}/posts/${post.id}/context`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
        body: JSON.stringify({ context: post.context }),
      }).then(({ campaign }) => {
        (action.platform === "facebook" ? dirtyFacebookFields : dirtyTikTokFields).current.delete(`context:${post.id}`);
        if (action.platform === "facebook") hydrateFacebookWhenIdle(campaign);
        else hydrateTikTokWhenIdle(campaign);
        rawDispatch({ type: "set-notice", notice: { kind: "status", title: "Contexto guardado", message: "Los comentarios anteriores quedaron desactualizados." } });
      }).catch((error: unknown) => rawDispatch({
        type: "set-notice",
        notice: { kind: "error", title: "No se pudo guardar el contexto", message: error instanceof Error ? error.message : String(error) },
      }));
      return;
    }

    if (action.type === "restore-context" && action.platform === "facebook") {
      void apiRequest<{ campaign: FacebookSnapshot }>(`/api/facebook/posts/${action.postId}/context`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
        body: JSON.stringify({ restoreExtracted: true }),
      }).then(({ campaign }) => {
        dirtyFacebookFields.current.delete(`context:${action.postId}`);
        hydrateFacebookWhenIdle(campaign);
      })
        .catch((error: unknown) => rawDispatch({
          type: "set-notice",
          notice: { kind: "error", title: "No se pudo restaurar el contexto", message: error instanceof Error ? error.message : String(error) },
        }));
      return;
    }

    if (action.type === "retry-context" && action.platform === "facebook") {
      void apiRequest<{ operation: { id: string } }>(`/api/facebook/posts/${action.postId}/extract`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      }).then(({ operation }) => {
        pollOperation(operation.id);
        rawDispatch({
          type: "set-notice",
          notice: { kind: "status", title: "Extracción en cola", message: "Se usará únicamente el perfil Edge dedicado." },
        });
      }).catch((error: unknown) => rawDispatch({
        type: "set-notice",
        notice: { kind: "error", title: "No se pudo iniciar la extracción", message: error instanceof Error ? error.message : String(error) },
      }));
      return;
    }

    if (action.type === "save-comment") {
      const comment = state[draftKey(action.platform)].posts.find((item) => item.id === action.postId)
        ?.comments.find((item) => item.id === action.commentId);
      if (!comment || (comment.text.trim().length > 0 && comment.text.trim().length < 2) || comment.text.length > 500) return;
      void apiRequest<{ campaign: FacebookSnapshot }>(`/api/${action.platform}/comments/${comment.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
        body: JSON.stringify({ text: comment.text, intention: comment.intention, tone: comment.tone }),
      }).then(({ campaign }) => {
        (action.platform === "facebook" ? dirtyFacebookFields : dirtyTikTokFields).current.delete(`comment:${comment.id}`);
        if (action.platform === "facebook") hydrateFacebookWhenIdle(campaign);
        else hydrateTikTokWhenIdle(campaign);
      })
        .catch((error: unknown) => rawDispatch({
          type: "set-notice",
          notice: { kind: "error", title: "No se pudo guardar el comentario", message: error instanceof Error ? error.message : String(error) },
        }));
      return;
    }

    if (action.type === "request-regenerate-post" || action.type === "start-comment-regeneration") {
      const dirty = action.platform === "facebook" ? dirtyFacebookFields : dirtyTikTokFields;
      if (dirty.current.size) {
        rawDispatch({ type: "set-notice", notice: { kind: "error", title: "Hay cambios sin guardar", message: "Guarda el contexto y comentario antes de generar." } });
        return;
      }
      const post = state[draftKey(action.platform)].posts.find((item) => item.id === action.postId);
      if (!post) return;
      const hasManualComments = post.comments.some((comment) => comment.source === "manual" || comment.status === "edited");
      if (action.type === "request-regenerate-post" && hasManualComments) {
        rawDispatch(action);
        return;
      }
      rawDispatch({ type: "close-modal" });
      void apiRequest<{ operation: { id: string } }>(`/api/${action.platform}/posts/${post.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), overwriteManual: hasManualComments }),
      }).then(({ operation }) => {
        pollOperation(operation.id, action.platform);
        rawDispatch({
          type: "set-notice",
          notice: { kind: "status", title: "Generación en cola", message: action.platform === "tiktok" ? "DeepSeek generará exactamente un comentario desde el contexto manual." : "DeepSeek recibirá una sola solicitud para todas las asignaciones del post." },
        });
      }).catch((error: unknown) => rawDispatch({
        type: "set-notice",
        notice: { kind: "error", title: "No se pudo iniciar la generación", message: error instanceof Error ? error.message : String(error) },
      }));
      return;
    }

    if (action.type === "start-abort") {
      void apiRequest<{ cancelled: number }>("/api/operations", {
        method: "DELETE",
        headers: { "x-control-panel-client": "control-panel" },
      }).then(({ cancelled }) => {
        rawDispatch({ type: "close-modal" });
        rawDispatch({
          type: "set-notice",
          notice: { kind: "status", title: "Cancelación registrada", message: `${cancelled} trabajo(s) propios fueron cancelados o notificados.` },
        });
      }).catch((error: unknown) => rawDispatch({
        type: "set-notice",
        notice: { kind: "error", title: "No se pudo cancelar", message: error instanceof Error ? error.message : String(error) },
      }));
      return;
    }

    if (action.type === "start-device-preparation") {
      rawDispatch(action);
      void Promise.all(action.deviceIds.map((deviceId) => apiRequest("/api/devices/prepare", {
        method: "POST",
        headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
        body: JSON.stringify({ deviceId, idempotencyKey: crypto.randomUUID() }),
      }))).then(() => rawDispatch({
        type: "set-notice",
        notice: { kind: "status", title: "Comprobación Appium en cola", message: `${action.deviceIds.length} dispositivo(s) mostrarán cada paso mientras el worker los valida.` },
      })).catch((error: unknown) => rawDispatch({
        type: "set-notice",
        notice: { kind: "error", title: "No se pudo preparar el dispositivo", message: error instanceof Error ? error.message : String(error) },
      }));
      return;
    }

    if (action.type === "retry-context") {
      rawDispatch(action);
      later(() => rawDispatch({ type: "advance-post", platform: action.platform, postId: action.postId, stage: "context" }), 450);
      later(() => rawDispatch({ type: "advance-post", platform: action.platform, postId: action.postId, stage: "comments" }), 950);
      return;
    }

    rawDispatch(action);
  };

  const runTikTokLive = async (input: TikTokLiveInput) => {
    try {
      const { operation } = await apiRequest<{ operation: { id: string } }>("/api/tiktok/live", {
      method: "POST",
      headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
      body: JSON.stringify(input),
      });
      pollOperation(operation.id, "tiktok");
      rawDispatch({ type: "set-notice", notice: { kind: "status", title: "TikTok Live en cola", message: "Cada ronda tendrá checkpoint y no se reintentará si su efecto queda incierto." } });
    } catch (error) {
      rawDispatch({ type: "set-notice", notice: { kind: "error", title: "TikTok Live sigue bloqueado", message: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  };

  const calibrateTikTokLive = async (deviceId: string, x: number, y: number) => {
    const { calibration } = await apiRequest<{ calibration: { deviceId: string; x: number; y: number; calibratedAt: number } }>("/api/tiktok/live/calibration", {
      method: "POST",
      headers: { "content-type": "application/json", "x-control-panel-client": "control-panel" },
      body: JSON.stringify({ deviceId, x, y, confirmed: true }),
    });
    setTikTokConfiguration((current) => ({
      ...current,
      liveCalibrations: [
        ...current.liveCalibrations.filter((item) => item.deviceId !== calibration.deviceId),
        { deviceId: calibration.deviceId, x: calibration.x, y: calibration.y, calibratedAt: calibration.calibratedAt },
      ],
    }));
    rawDispatch({ type: "set-notice", notice: { kind: "status", title: "Calibración Live guardada", message: `Punto (${calibration.x}, ${calibration.y}) registrado para ${calibration.deviceId}.` } });
  };

  const activeCampaigns = state.history.filter((item) => ["running", "cancellation_requested"].includes(item.status)).length;
  const busyDevices = state.devices.filter((item) => item.activity === "busy").length;
  const modal = state.activeModal;
  const hasUnknownClearError = hasUncertainDeviceSessions;
  const editedDevice = modal?.type === "edit-device" ? state.devices.find((item) => item.id === modal.deviceId) : undefined;
  const editor = state.demoOperations.deviceEditor;
  const regeneratePost = modal?.type === "regenerate-post" ? state[draftKey(modal.platform)].posts.find((item) => item.id === modal.postId) : undefined;
  const abort = state.demoOperations.abort;

  return (
    <main className="console-frame">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">FA</span>
          <div>
            <strong>Control local</strong>
            <small>Farm Appium / estación 01</small>
          </div>
        </div>
        <Badge className="prototype-badge" variant="filled">FASE 6 · TIKTOK</Badge>
        <div className="health-strip" aria-label="Salud del runtime">
          {state.runtimeHealth.slice(0, 3).map((service) => (
            <div className="health-item" key={service.id} data-status={service.status}>
              <span className="status-dot" aria-hidden="true" />
              <span><strong>{service.label}</strong><small>{statusLabels[service.status]}</small></span>
            </div>
          ))}
        </div>
        <div className="topbar-metrics">
          <span><strong>{activeCampaigns}</strong> campañas activas</span>
          <span><strong>{busyDevices}</strong> equipos ocupados</span>
        </div>
        <time className="local-clock" dateTime={state.demoOperations.now}>
          {new Intl.DateTimeFormat("es-PE", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(state.demoOperations.now))}
          <small>hora local</small>
        </time>
        <Button color="red" variant="filled" onClick={() => dispatch({ type: "request-abort" })}>
          Abortar todo en Farm Appium
        </Button>
      </header>

      {state.notice && (
        <Alert
          className="global-notice"
          color={state.notice.kind === "error" ? "red" : "lime"}
          role={state.notice.kind === "error" ? "alert" : "status"}
          title={state.notice.title}
          withCloseButton
          onClose={() => dispatch({ type: "clear-notice" })}
        >
          {state.notice.message}
        </Alert>
      )}

      <div className="console-shell">
        <nav className="side-nav" aria-label="Navegación principal">
          <div className="nav-label">Áreas operativas</div>
          {navItems.map((item) => (
            <button
              className="nav-item"
              data-platform={item.id}
              aria-current={state.activeView === item.id ? "page" : undefined}
              key={item.id}
              onClick={() => dispatch({ type: "navigate", view: item.id })}
            >
              <span className="nav-icon" aria-hidden="true"><NavIcon view={item.id} /></span>
              <span className="nav-copy"><small>{item.index}</small><strong>{item.label}</strong></span>
              <b>{navCount(state, item.id)}</b>
            </button>
          ))}
          <div className="nav-footnote">
            <span className="status-dot" aria-hidden="true" />
            <p><strong>Publicación directa</strong>Facebook y TikTok N×M se publican con un solo botón y quedan bajo protección de efecto incierto.</p>
          </div>
        </nav>

        <section className="view-stage">
          {state.activeView === "devices" && <DevicesView state={state} dispatch={dispatch} />}
          {state.activeView === "facebook" && (
            <CampaignView
              platform="facebook"
              label="Facebook"
              accent="facebook"
              allowedHosts="facebook.com · fb.watch"
              requiredCapability="Sesión Facebook preparada"
              experimentalActions={[]}
              state={state}
              dispatch={dispatch}
            />
          )}
          {state.activeView === "tiktok" && (
            <>
              <CampaignView
                platform="tiktok"
                label="TikTok"
                accent="tiktok"
                allowedHosts="tiktok.com"
                requiredCapability="Aplicación TikTok preparada"
                experimentalActions={[]}
                configuration={tiktokConfiguration}
                state={state}
                dispatch={dispatch}
              />
              <TikTokLivePanel devices={state.devices} configuration={tiktokConfiguration} onRun={runTikTokLive} onCalibrate={calibrateTikTokLive} />
            </>
          )}
          {state.activeView === "history" && <HistoryView state={state} dispatch={dispatch} />}
        </section>
      </div>

      <Drawer opened={modal?.type === "edit-device"} onClose={() => dispatch({ type: "close-modal" })} position="right" size="md" title="Editar dispositivo">
        {editedDevice && editor && (
          <Stack gap="md">
            <div className="drawer-ident">
              <span>HARDWARE ID</span>
              <code>{editedDevice.hardwareId}</code>
            </div>
            <TextInput label="Alias" value={editor.alias} error={editor.errors.alias} onChange={(event) => dispatch({ type: "update-device-editor", field: "alias", value: event.currentTarget.value })} />
            <NumberInput label="Orden físico" min={1} value={editor.order} error={editor.errors.order} onChange={(value) => dispatch({ type: "update-device-editor", field: "order", value: Number(value) || 0 })} />
            <TextInput label="Serial ADB" value={editor.serial} error={editor.errors.serial} onChange={(event) => dispatch({ type: "update-device-editor", field: "serial", value: event.currentTarget.value })} />
            <NumberInput label="systemPort" min={8200} max={8299} value={editor.systemPort} error={editor.errors.systemPort} onChange={(value) => dispatch({ type: "update-device-editor", field: "systemPort", value: Number(value) || 0 })} />
            <TextInput label="Cuenta Facebook esperada" description="Nombre estable que Facebook muestra en el indicador de cuenta activa." value={editor.facebookAccount} error={editor.errors.facebookAccount} onChange={(event) => dispatch({ type: "update-device-editor", field: "facebookAccount", value: event.currentTarget.value })} />
            <dl className="detail-list">
              <div><dt>Última preparación</dt><dd>{formatDate(editedDevice.lastPreparation)}</dd></div>
              <div><dt>Verificación Facebook</dt><dd>{formatDate(editedDevice.lastPlatformCheck.facebook)}</dd></div>
              <div><dt>Verificación TikTok</dt><dd>{formatDate(editedDevice.lastPlatformCheck.tiktok)}</dd></div>
            </dl>
            <Alert color="yellow">Cambiar serial o puerto marca la preparación como desactualizada.</Alert>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => dispatch({ type: "close-modal" })}>Cancelar</Button>
              <Button onClick={() => dispatch({ type: "save-device" })}>Guardar cambios</Button>
            </Group>
          </Stack>
        )}
      </Drawer>

      <Modal opened={modal?.type === "retire-device"} onClose={() => dispatch({ type: "close-modal" })} title="Retirar dispositivo ocupado">
        <Stack>
          <Text>El dispositivo está ocupado por Farm Appium. La campaña actual no se cancelará silenciosamente.</Text>
          <Text size="sm" c="dimmed">Se marcará “Retirar al finalizar” y sus asignaciones históricas se conservarán.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => dispatch({ type: "close-modal" })}>Conservar</Button>
            <Button color="red" onClick={() => dispatch({ type: "confirm-device-retirement" })}>Retirar al finalizar</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={modal?.type === "clear-devices"} onClose={() => dispatch({ type: "close-modal" })} title="Borrar todos los dispositivos" closeOnClickOutside={!clearingDevices && !recoveringDeviceSessions} closeOnEscape={!clearingDevices && !recoveringDeviceSessions}>
        <Stack>
          <Text>Se quitarán todos los equipos de la lista para poder incorporarlos de nuevo.</Text>
          <Text size="sm" c="dimmed">El historial y la evidencia se conservarán. Esta acción solo está disponible sin trabajos ni sesiones Appium activos.</Text>
          {clearDevicesError && <Alert color="red" title="No se pudo borrar">{clearDevicesError}</Alert>}
          <Group justify="flex-end">
            {hasUnknownClearError && <Button color="yellow" loading={recoveringDeviceSessions} disabled={clearingDevices} onClick={() => dispatch({ type: "recover-device-sessions" })}>Recuperar sesiones</Button>}
            {hasUnknownClearError && <Button variant="default" disabled={clearingDevices || recoveringDeviceSessions} onClick={() => {
              dispatch({ type: "close-modal" });
              dispatch({ type: "navigate", view: "history" });
              dispatch({ type: "set-history-filter", field: "status", value: "outcome_unknown" });
            }}>Ver y reconciliar</Button>}
            <Button variant="default" disabled={clearingDevices || recoveringDeviceSessions} onClick={() => dispatch({ type: "close-modal" })}>Cancelar</Button>
            <Button color="red" loading={clearingDevices} disabled={recoveringDeviceSessions} onClick={() => dispatch({ type: "confirm-clear-devices" })}>Borrar todos</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={modal?.type === "regenerate-post"} onClose={() => dispatch({ type: "close-modal" })} title="Sobrescribir comentarios editados">
        {modal?.type === "regenerate-post" && regeneratePost && (
          <Stack>
            <Text>{regeneratePost.comments.filter((item) => item.status === "edited").length} comentarios tienen edición manual.</Text>
            <Text size="sm" c="dimmed">Regenerar todos reemplazará esas versiones solo en esta publicación.</Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => dispatch({ type: "close-modal" })}>Conservar ediciones</Button>
              <Button color="red" onClick={() => dispatch({ type: "start-comment-regeneration", platform: modal.platform, postId: modal.postId, commentIds: regeneratePost.comments.map((item) => item.id) })}>Regenerar y sobrescribir</Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal opened={modal?.type === "abort-all"} onClose={() => dispatch({ type: "close-modal" })} title="Abortar todo en Farm Appium" size="lg" closeOnClickOutside={!abort.active} closeOnEscape={!abort.active}>
        <Stack>
          {!abort.active && abort.step === 0 && (
            <>
              <Alert color="red" title="Solo recursos propios de Farm Appium">GenFarmer no será cerrado, sondeado ni administrado. Los resultados existentes se conservarán.</Alert>
              <dl className="abort-impact">
                <div><dt>Campañas afectadas</dt><dd>{activeCampaigns}</dd></div>
                <div><dt>Dispositivos en uso</dt><dd>{busyDevices}</dd></div>
                <div><dt>Trabajos propios</dt><dd>Preparación, extracción, generación y ejecuciones N×M</dd></div>
              </dl>
              <Text size="sm">Se detendrán nuevos trabajos, se cerrarán únicamente sesiones propias y se simulará Home por dispositivo.</Text>
              <Group justify="flex-end">
                <Button variant="default" onClick={() => dispatch({ type: "close-modal" })}>No abortar</Button>
                <Button color="red" onClick={() => dispatch({ type: "start-abort" })}>Confirmar aborto</Button>
              </Group>
            </>
          )}
          {(abort.active || abort.step > 0) && (
            <>
              <ol className="abort-sequence">
                {abortSteps.map((step, index) => <li key={step} data-active={index === abort.step} data-done={index < abort.step}>{step}</li>)}
              </ol>
              {Object.entries(abort.deviceCleanup).map(([id, cleanup]) => {
                const device = state.devices.find((item) => item.id === id);
                return <div className="cleanup-row" key={id}><span>{device?.alias ?? id}</span><Badge color={cleanup === "cleanup_unknown" || cleanup === "failed" ? "red" : "gray"}>{cleanup.replaceAll("_", " ")}</Badge></div>;
              })}
              {!abort.active && <Button onClick={() => dispatch({ type: "close-modal" })}>Cerrar resumen</Button>}
            </>
          )}
        </Stack>
      </Modal>
    </main>
  );
}
