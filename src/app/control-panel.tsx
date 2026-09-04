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
import { useEffect, useReducer, useRef } from "react";

import { CampaignView } from "./campaign-view";
import type {
  CampaignDraft,
  ControlAction,
  ControlDispatch,
  ControlState,
  Device,
  Platform,
  ViewId,
} from "./control-panel.types";
import {
  buildAssignments,
  formatDate,
  createInitialState,
  parseCampaignUrls,
  parseDeviceInput,
  scheduleAssignments,
  statusLabels,
} from "./demo-state";
import { DevicesView } from "./devices-view";
import { HistoryView } from "./history-view";

const navItems: { id: ViewId; index: string; label: string }[] = [
  { id: "devices", index: "01", label: "Dispositivos" },
  { id: "facebook", index: "02", label: "Facebook" },
  { id: "tiktok", index: "03", label: "TikTok" },
  { id: "history", index: "04", label: "Historial" },
];

const preparationSteps = ["Validando ADB", "Comprobando Appium", "Leyendo jerarquía", "Volviendo a Inicio"];
const abortSteps = [
  "Solicitud registrada",
  "Deteniendo nuevos trabajos",
  "Cancelando tareas activas",
  "Cerrando sesiones propias",
  "Enviando Home por dispositivo",
  "Finalizado o requiere recuperación",
];

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
    scheduleStatus: draft.scheduleStatus === "none" ? "none" : "stale",
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
  };
  return { editor, errors, deviceId: modal.deviceId };
}

// ponytail: the prototype keeps transitions in memory; split by domain when persisted runtime services replace this demo state.
function controlReducer(state: ControlState, action: ControlAction): ControlState {
  switch (action.type) {
    case "tick":
      return { ...state, demoOperations: { ...state.demoOperations, now: action.now } };
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
      const usedPorts = new Set(state.devices.map((item) => item.systemPort));
      const availablePorts = Array.from({ length: 100 }, (_, index) => 8200 + index).filter((port) => !usedPorts.has(port));
      if (parsed.serials.length > availablePorts.length) {
        return {
          ...state,
          notice: { kind: "error", title: "Sin puertos disponibles", message: "El rango exclusivo 8200–8299 no alcanza para toda la lista." },
        };
      }
      const maxOrder = Math.max(0, ...state.devices.map((item) => item.order));
      const added: Device[] = parsed.serials.map((serial, index) => ({
        id: `device-demo-${Date.now()}-${index}`,
        order: maxOrder + index + 1,
        alias: `Equipo ${maxOrder + index + 1}`,
        serial,
        model: "Pendiente de lectura",
        connection: "offline",
        preparation: "not_ready",
        capabilities: { facebook: "session_required", tiktok: "session_required" },
        activity: "available",
        systemPort: availablePorts[index],
        hardwareId: `PENDIENTE-${maxOrder + index + 1}`,
        lastPreparation: null,
        lastPlatformCheck: { facebook: null, tiktok: null },
      }));
      return {
        ...state,
        devices: [...state.devices, ...added],
        notice: { kind: "status", title: `${added.length} dispositivos agregados`, message: "Ya aparecen en la allowlist; la preparación continúa pendiente." },
        demoOperations: { ...state.demoOperations, deviceImportText: "", deviceImportErrors: [] },
      };
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
          deviceEditor: { alias: device.alias, order: device.order, serial: device.serial, systemPort: device.systemPort, errors: {} },
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
            preparation: changedIdentity ? "not_ready" : item.preparation,
            preparationStep: changedIdentity ? undefined : item.preparationStep,
          };
        }),
        activeModal: null,
        notice: { kind: "status", title: "Dispositivo actualizado", message: "Los cambios solo existen en esta sesión de demostración." },
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
    case "start-device-preparation":
      return {
        ...state,
        devices: state.devices.map((item) => action.deviceIds.includes(item.id)
          ? { ...item, preparation: "preparing", preparationStep: preparationSteps[0] }
          : item),
        notice: { kind: "status", title: "Preparación simulada iniciada", message: `${action.deviceIds.length} equipos avanzan de forma independiente.` },
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
          scheduleStatus: draft.scheduleStatus === "none" ? "none" : "stale",
        };
      });
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
        scheduleStatus: draft.scheduleStatus === "none" ? "none" : "stale",
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
    case "restore-context":
      return updateDraft(state, action.platform, (draft) => ({
        ...draft,
        scheduleStatus: draft.scheduleStatus === "none" ? "none" : "stale",
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
        scheduleStatus: draft.scheduleStatus === "none" ? "none" : "stale",
        posts: draft.posts.map((post) => post.id === action.postId
          ? { ...post, comments: post.comments.map((comment) => comment.id === action.commentId ? { ...comment, text: action.value, status: "edited", stale: false } : comment) }
          : post),
      }));
    case "update-comment-profile":
      return updateDraft(state, action.platform, (draft) => ({
        ...draft,
        scheduleStatus: draft.scheduleStatus === "none" ? "none" : "stale",
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
        scheduleStatus: draft.scheduleStatus === "none" ? "none" : "stale",
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
                ? { ...comment, text: `Nueva versión ${comment.tone.toLowerCase()} para esta publicación.`, status: "ready", stale: false, error: undefined }
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
    case "set-schedule":
      return updateDraft(state, action.platform, (draft) => ({
        ...draft,
        [action.field]: action.field === "maxWaitMinutes"
          ? Math.min(1440, Math.max(0, Number(action.value) || 0))
          : action.value,
        scheduleStatus: draft.scheduleStatus === "none" ? "none" : "stale",
      } as CampaignDraft));
    case "generate-schedule":
      return updateDraft(state, action.platform, (draft) => ({
        ...draft,
        assignments: scheduleAssignments(draft, state.demoOperations.now),
        posts: draft.posts.map((post) => ({ ...post, status: post.status === "ready" ? "scheduled" : post.status })),
        status: "scheduled",
        scheduleStatus: "valid",
      }));
    case "set-review-group":
      return updateDraft(state, action.platform, (draft) => ({ ...draft, reviewGrouping: action.value }));
    case "request-start-campaign":
      return { ...state, activeModal: { type: "start-campaign", platform: action.platform } };
    case "start-campaign": {
      const key = draftKey(action.platform);
      const draft = state[key];
      const id = `CMP-DEMO-${action.platform === "facebook" ? "FB" : "TT"}-${state.history.length + 1}`;
      const assignments = draft.assignments.map((assignment) => {
        const post = draft.posts.find((item) => item.id === assignment.postId);
        const device = state.devices.find((item) => item.id === assignment.deviceId);
        const comment = post?.comments.find((item) => item.deviceId === assignment.deviceId);
        return {
          id: assignment.id,
          postUrl: post?.url ?? "",
          deviceId: assignment.deviceId,
          deviceAlias: device?.alias ?? "Dispositivo retirado",
          deviceSerial: device?.serial ?? "—",
          plannedAt: assignment.scheduledAt ?? state.demoOperations.now,
          actualAt: null,
          status: "pending" as const,
          comment: comment?.text ?? null,
          context: post?.context ?? "No requerido",
          likeResult: "not_requested" as const,
          commentResult: "not_requested" as const,
          attempts: 0,
          cleanup: "session_closed" as const,
        };
      });
      return {
        ...state,
        [key]: {
          ...draft,
          status: "running",
          scheduleStatus: "frozen",
          posts: draft.posts.map((post) => ({ ...post, status: "running" })),
          assignments: draft.assignments.map((assignment) => ({ ...assignment, status: "running", actualAt: state.demoOperations.now })),
        },
        devices: state.devices.map((item) => draft.selectedDeviceIds.includes(item.id) ? { ...item, activity: "busy" } : item),
        history: [{
          id,
          platform: action.platform,
          startedAt: state.demoOperations.now,
          deviceIds: draft.selectedDeviceIds,
          postUrls: draft.urls,
          actions: draft.actions,
          status: "running",
          completedAssignments: 0,
          totalAssignments: assignments.length,
          assignments,
        }, ...state.history],
        activeModal: null,
        notice: { kind: "status", title: "Campaña simulada iniciada", message: "MODO PROTOTIPO: no se realizó ninguna solicitud HTTP ni acción pública." },
      };
    }
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
  const timers = useRef<number[]>([]);

  useEffect(() => {
    rawDispatch({ type: "tick", now: new Date().toISOString() });
    const timer = window.setInterval(() => rawDispatch({ type: "tick", now: new Date().toISOString() }), 1_000);
    return () => {
      window.clearInterval(timer);
      timers.current.forEach(window.clearTimeout);
    };
  }, []);

  const later = (callback: () => void, delay: number) => {
    timers.current.push(window.setTimeout(callback, delay));
  };

  const dispatch: ControlDispatch = (action) => {
    if (action.type === "start-device-preparation") {
      rawDispatch(action);
      action.deviceIds.forEach((deviceId, deviceIndex) => {
        preparationSteps.slice(1).forEach((step, stepIndex) => later(
          () => rawDispatch({ type: "advance-device-preparation", deviceId, step }),
          350 * (stepIndex + 1) + deviceIndex * 90,
        ));
        later(
          () => rawDispatch({ type: "finish-device-preparation", deviceId, failed: deviceId === "device-07" }),
          1_650 + deviceIndex * 90,
        );
      });
      return;
    }

    if (action.type === "prepare-campaign") {
      const draft = state[draftKey(action.platform)];
      rawDispatch(action);
      if (!draft.actions.comment) return;
      draft.urls.forEach((url, index) => {
        const postId = `${action.platform}-post-${index + 1}`;
        const offset = index === 0 ? 420 : 800 + index * 380;
        if (url.includes("fallo")) {
          later(() => rawDispatch({ type: "advance-post", platform: action.platform, postId, stage: "failed" }), offset);
          return;
        }
        later(() => rawDispatch({ type: "advance-post", platform: action.platform, postId, stage: "context" }), offset);
        later(() => rawDispatch({ type: "advance-post", platform: action.platform, postId, stage: "comments" }), offset + 520);
      });
      return;
    }

    if (action.type === "retry-context") {
      rawDispatch(action);
      later(() => rawDispatch({ type: "advance-post", platform: action.platform, postId: action.postId, stage: "context" }), 450);
      later(() => rawDispatch({ type: "advance-post", platform: action.platform, postId: action.postId, stage: "comments" }), 950);
      return;
    }

    if (action.type === "request-regenerate-post") {
      const post = state[draftKey(action.platform)].posts.find((item) => item.id === action.postId);
      if (!post) return;
      const ids = post.comments.map((comment) => comment.id);
      if (post.comments.some((comment) => comment.status === "edited")) rawDispatch(action);
      else dispatch({ type: "start-comment-regeneration", platform: action.platform, postId: action.postId, commentIds: ids });
      return;
    }

    if (action.type === "start-comment-regeneration") {
      rawDispatch(action);
      later(() => rawDispatch({ type: "finish-comment-regeneration", platform: action.platform, postId: action.postId, commentIds: action.commentIds }), 650);
      return;
    }

    if (action.type === "start-campaign") {
      rawDispatch(action);
      later(() => rawDispatch({ type: "advance-running-campaign", platform: action.platform }), 900);
      return;
    }

    if (action.type === "start-abort") {
      timers.current.forEach(window.clearTimeout);
      timers.current = [];
      rawDispatch(action);
      abortSteps.slice(1, -1).forEach((_, index) => later(() => rawDispatch({ type: "advance-abort", step: index + 1 }), 360 * (index + 1)));
      later(() => rawDispatch({ type: "finish-abort" }), 1_950);
      return;
    }

    rawDispatch(action);
  };

  const activeCampaigns = state.history.filter((item) => ["running", "cancellation_requested"].includes(item.status)).length;
  const busyDevices = state.devices.filter((item) => item.activity === "busy").length;
  const modal = state.activeModal;
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
        <Badge className="prototype-badge" variant="filled">MODO PROTOTIPO</Badge>
        <div className="health-strip" aria-label="Salud simulada del runtime">
          {state.runtimeHealth.slice(0, 3).map((service) => (
            <div className="health-item" key={service.id} data-status={service.status}>
              <span className="status-dot" aria-hidden="true" />
              <span><strong>{service.label}</strong><small>{statusLabels[service.status]} · simulado</small></span>
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
            <p><strong>Solo demostración</strong>Ningún control ejecuta acciones reales.</p>
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
            <CampaignView
              platform="tiktok"
              label="TikTok"
              accent="tiktok"
              allowedHosts="tiktok.com"
              requiredCapability="Aplicación TikTok preparada"
              experimentalActions={["tap_tap"]}
              state={state}
              dispatch={dispatch}
            />
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

      <Modal opened={modal?.type === "start-campaign"} onClose={() => dispatch({ type: "close-modal" })} title="Confirmar inicio simulado">
        {modal?.type === "start-campaign" && (
          <Stack>
            <Alert color="red" title="Efectos públicos futuros">En la implementación real esta acción podrá publicar likes y comentarios. Este prototipo no realizará ninguna solicitud.</Alert>
            <Text>Se añadirá una campaña simulada al historial y algunos trabajos avanzarán visualmente.</Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => dispatch({ type: "close-modal" })}>Volver a revisión</Button>
              <Button onClick={() => dispatch({ type: "start-campaign", platform: modal.platform })}>Iniciar campaña simulada</Button>
            </Group>
          </Stack>
        )}
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
                <div><dt>Tareas demo</dt><dd>Extracción y generación</dd></div>
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
