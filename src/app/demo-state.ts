import type {
  AssignmentStatus,
  CampaignAssignment,
  CampaignDraft,
  CampaignPost,
  CampaignStatus,
  CapabilityStatus,
  CommentStatus,
  ConnectionStatus,
  ContextStatus,
  ControlState,
  Device,
  DeviceLineError,
  HealthStatus,
  HistoryAssignment,
  HistoryCampaign,
  Platform,
  PostStatus,
  PreparationStatus,
  Tone,
  UrlLineError,
} from "./control-panel.types";

export const toneOptions: Tone[] = ["Cercano", "Entusiasta", "Informativo", "Breve"];

export const statusLabels: Record<
  HealthStatus | ConnectionStatus | PreparationStatus | CapabilityStatus | CampaignStatus | PostStatus | AssignmentStatus | CommentStatus | ContextStatus,
  string
> = {
  checking: "Comprobando",
  degraded: "Degradado",
  unavailable: "No disponible",
  connected: "Conectado",
  offline: "Offline",
  unauthorized: "No autorizado",
  not_ready: "Pendiente",
  preparing: "Preparando",
  failed: "Fallo",
  not_installed: "No instalada",
  session_required: "Requiere sesión",
  draft: "Borrador",
  scheduled: "Programada",
  running: "En ejecución",
  completed: "Completada",
  completed_with_issues: "Completada con incidencias",
  cancellation_requested: "Cancelación solicitada",
  cancelled: "Cancelada",
  cancelled_with_cleanup_errors: "Cancelada · cleanup pendiente",
  queued: "En cola",
  extracting: "Extrayendo",
  context_ready: "Contexto listo",
  generating: "Generando",
  partial_failed: "Fallo parcial",
  outcome_unknown: "Resultado incierto",
  pending: "Pendiente",
  edited: "Editado",
  regenerating: "Regenerando",
  cached: "Obtenido de caché",
  intervention_required: "Requiere intervención",
  approved: "Aprobada",
  sent: "Enviada",
  recovery_required: "Requiere recuperación",
  ready: "Listo",
};

export function parseDeviceInput(input: string, devices: Device[]) {
  const errors: DeviceLineError[] = [];
  const serials: string[] = [];
  const seen = new Set<string>();
  const registered = new Set(devices.map((device) => device.serial.toLowerCase()));

  input.split(/\r?\n/).forEach((raw, index) => {
    const value = raw.replace(/^ +| +$/g, "");
    if (!value) return;
    const key = value.toLowerCase();
    let message = "";
    if (/[\u0000-\u001f\u007f]/.test(value)) message = "Contiene caracteres de control";
    else if (value.length > 120) message = "Supera el máximo de 120 caracteres";
    else if (seen.has(key)) message = "Duplicado en esta lista";
    else if (registered.has(key)) message = "Ya está registrado";

    seen.add(key);
    if (message) errors.push({ line: index + 1, value, message });
    else serials.push(value);
  });

  return { serials, errors };
}

export function parseCampaignUrls(input: string, platform: Platform) {
  const errors: UrlLineError[] = [];
  const urls: string[] = [];
  const seen = new Set<string>();

  input.split(/\r?\n/).forEach((raw, index) => {
    const value = raw.trim();
    if (!value) return;
    let normalized = value;
    let message = "";

    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const allowed =
        platform === "facebook"
          ? host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch"
          : host === "tiktok.com" || host.endsWith(".tiktok.com");
      if (url.protocol !== "https:") message = "Debe usar HTTPS";
      else if (!allowed) message = `Dominio no permitido para ${platform === "facebook" ? "Facebook" : "TikTok"}`;
      url.hash = "";
      normalized = url.toString();
    } catch {
      message = "URL no válida";
    }

    if (!message && seen.has(normalized)) message = "URL duplicada";
    if (!message && urls.length >= 10) message = "Máximo 10 publicaciones";
    seen.add(normalized);
    if (message) errors.push({ line: index + 1, value, message });
    else urls.push(normalized);
  });

  return { urls, errors };
}

export function isDeviceEligible(device: Device, platform: Platform) {
  return device.connection === "connected" && device.preparation === "ready" && device.capabilities[platform] === "ready";
}

export function campaignCanPrepare(state: ControlState, platform: Platform) {
  const draft = platform === "facebook" ? state.facebookDraft : state.tiktokDraft;
  const selectedAreEligible = draft.selectedDeviceIds.length > 0 && draft.selectedDeviceIds.every((id) => {
    const selected = state.devices.find((item) => item.id === id);
    return selected ? isDeviceEligible(selected, platform) : false;
  });
  const distributionTotal = draft.distribution.reduce((total, row) => total + row.count, 0);
  return selectedAreEligible
    && draft.urls.length >= 1
    && draft.urls.length <= 10
    && draft.urlErrors.length === 0
    && (draft.actions.like || draft.actions.comment)
    && (!draft.actions.comment || (distributionTotal === draft.selectedDeviceIds.length && draft.distribution.every((row) => row.intention.trim() && row.count > 0)));
}

export function formatDate(value: string | null, withSeconds = false) {
  if (!value) return "Sin registro";
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "short",
    timeStyle: withSeconds ? "medium" : "short",
  }).format(new Date(value));
}

export function buildAssignments(draft: CampaignDraft) {
  const posts: CampaignPost[] = draft.urls.map((url, postIndex) => {
    let distributionIndex = 0;
    let usedInRow = 0;
    const comments = draft.actions.comment
      ? draft.selectedDeviceIds.map((deviceId) => {
          const row = draft.distribution[distributionIndex] ?? draft.distribution[0];
          usedInRow += 1;
          if (row && usedInRow >= row.count) {
            distributionIndex += 1;
            usedInRow = 0;
          }
          const assignmentId = `${draft.platform}-assignment-${postIndex + 1}-${deviceId}`;
          return {
            id: `${assignmentId}-comment`,
            assignmentId,
            deviceId,
            intention: row?.intention || "Reacción general",
            tone: row?.tone || "Cercano",
            text: "",
            status: "pending" as const,
            stale: false,
          };
        })
      : [];

    return {
      id: `${draft.platform}-post-${postIndex + 1}`,
      position: postIndex + 1,
      url,
      status: draft.actions.comment ? (postIndex === 0 ? "extracting" : "queued") : "ready",
      contextStatus: draft.actions.comment ? (postIndex === 0 ? "extracting" : "queued") : "ready",
      context: draft.actions.comment ? "" : "No requerido: comentarios desactivados.",
      extractedContext: "",
      contextSource: null,
      extractedAt: null,
      elapsedSeconds: 0,
      comments,
    } satisfies CampaignPost;
  });

  const assignments: CampaignAssignment[] = posts.flatMap((post) =>
    draft.selectedDeviceIds.map((deviceId) => ({
      id: `${draft.platform}-assignment-${post.position}-${deviceId}`,
      postId: post.id,
      deviceId,
      status: draft.actions.comment ? "pending" : "approved",
      scheduledAt: null,
      actualAt: null,
    })),
  );

  return { posts, assignments };
}

export function scheduleAssignments(draft: CampaignDraft, now: string) {
  const requested = draft.scheduleStart === "custom" && draft.scheduleDateTime ? new Date(draft.scheduleDateTime) : new Date(now);
  const base = Number.isNaN(requested.getTime()) ? new Date(now) : requested;
  const stepMinutes = draft.posts.length > 1 ? Math.max(1, Math.floor(draft.maxWaitMinutes / (draft.posts.length - 1))) : 0;
  return draft.assignments.map((assignment) => {
    const post = draft.posts.find((item) => item.id === assignment.postId);
    const scheduled = new Date(base.getTime() + Math.max(0, (post?.position ?? 1) - 1) * stepMinutes * 60_000);
    return { ...assignment, scheduledAt: scheduled.toISOString(), status: "scheduled" as const };
  });
}

function device(
  id: string,
  order: number,
  alias: string,
  serial: string,
  model: string,
  connection: ConnectionStatus,
  preparation: PreparationStatus,
  facebook: CapabilityStatus,
  tiktok: CapabilityStatus,
  activity: Device["activity"] = "available",
): Device {
  return {
    id,
    order,
    alias,
    serial,
    model,
    connection,
    preparation,
    capabilities: { facebook, tiktok },
    activity,
    systemPort: 8199 + order,
    hardwareId: `HW-${serial.slice(-6).toUpperCase()}`,
    lastPreparation: preparation === "ready" ? "2026-09-03T14:22:00.000Z" : null,
    lastPlatformCheck: {
      facebook: facebook === "ready" ? "2026-09-03T14:24:00.000Z" : null,
      tiktok: tiktok === "ready" ? "2026-09-03T14:25:00.000Z" : null,
    },
  };
}

export const demoDevices: Device[] = [
  device("device-01", 1, "Norte 01", "R58M72K1A7X", "Galaxy A54", "connected", "ready", "ready", "ready", "busy"),
  device("device-02", 2, "Norte 02", "emulator-5554", "Pixel 7", "connected", "ready", "ready", "session_required"),
  device("device-03", 3, "Mesa TikTok", "RF8N31T9C2P", "Galaxy S21", "connected", "ready", "not_installed", "ready"),
  device("device-04", 4, "Reserva", "ZY22H8QPL5", "Moto G84", "offline", "not_ready", "session_required", "session_required"),
  device("device-05", 5, "Alta pendiente", "A9F3-UNAUTH-02", "Redmi Note 12", "unauthorized", "not_ready", "not_installed", "not_installed"),
  { ...device("device-06", 6, "Banco B", "192.168.0.42:5555", "POCO X6", "connected", "preparing", "session_required", "session_required"), preparationStep: "Leyendo jerarquía" },
  device("device-07", 7, "Diagnóstico", "R9WT40FAIL7", "Galaxy A34", "connected", "failed", "session_required", "not_installed", "recovery_required"),
];

function emptyDraft(platform: Platform): CampaignDraft {
  return {
    platform,
    status: "draft",
    selectedDeviceIds: [],
    urlInput: "",
    urls: [],
    urlErrors: [],
    actions: { like: true, comment: true },
    distribution: [{ id: `${platform}-intent-1`, intention: "Reacción natural", tone: "Cercano", count: 0 }],
    posts: [],
    assignments: [],
    selectedPostId: null,
    scheduleStart: "now",
    scheduleDateTime: "",
    maxWaitMinutes: 30,
    scheduleStatus: "none",
    reviewGrouping: "post",
  };
}

function preparedFacebookDraft(): CampaignDraft {
  const base: CampaignDraft = {
    ...emptyDraft("facebook"),
    status: "preparing",
    selectedDeviceIds: ["device-01", "device-02"],
    urlInput: [
      "https://www.facebook.com/demo/posts/primera-publicacion",
      "https://fb.watch/demo-segunda",
      "https://www.facebook.com/demo/posts/fallo-contexto",
    ].join("\n"),
    urls: [
      "https://www.facebook.com/demo/posts/primera-publicacion",
      "https://fb.watch/demo-segunda",
      "https://www.facebook.com/demo/posts/fallo-contexto",
    ],
    distribution: [
      { id: "facebook-intent-1", intention: "Afinidad con el producto", tone: "Cercano", count: 1 },
      { id: "facebook-intent-2", intention: "Interés por la novedad", tone: "Entusiasta", count: 1 },
    ],
    scheduleStatus: "stale",
  };
  const built = buildAssignments(base);
  const posts = built.posts.map((post, index) => {
    if (index === 0) {
      return {
        ...post,
        status: "ready" as const,
        contextStatus: "ready" as const,
        context: "Presentación local de una nueva línea de productos, con foco en disponibilidad y cercanía.",
        extractedContext: "Presentación local de una nueva línea de productos, con foco en disponibilidad y cercanía.",
        contextSource: "extracted" as const,
        extractedAt: "2026-09-03T15:02:00.000Z",
        elapsedSeconds: 7,
        comments: post.comments.map((comment, commentIndex) => ({
          ...comment,
          text: commentIndex === 0 ? "Se ve muy bien, gracias por compartir la novedad." : "Qué buena propuesta para la comunidad.",
          status: commentIndex === 0 ? ("edited" as const) : ("ready" as const),
        })),
      };
    }
    if (index === 1) return { ...post, status: "extracting" as const, contextStatus: "extracting" as const, elapsedSeconds: 3 };
    return {
      ...post,
      status: "partial_failed" as const,
      contextStatus: "failed" as const,
      error: "La sesión web simulada expiró durante la extracción.",
    };
  });
  return { ...base, ...built, posts, selectedPostId: posts[0]?.id ?? null };
}

function historyAssignment(
  campaign: string,
  deviceId: string,
  postUrl: string,
  status: AssignmentStatus,
  overrides: Partial<HistoryAssignment> = {},
): HistoryAssignment {
  const registered = demoDevices.find((item) => item.id === deviceId) ?? demoDevices[0];
  return {
    id: `${campaign}-${deviceId}`,
    postUrl,
    deviceId,
    deviceAlias: registered.alias,
    deviceSerial: registered.serial,
    plannedAt: "2026-09-03T12:00:00.000Z",
    actualAt: status === "pending" ? null : "2026-09-03T12:01:12.000Z",
    status,
    comment: "Una respuesta breve generada para esta publicación.",
    context: "Contexto extraído y conservado para auditoría.",
    likeResult: "ok",
    commentResult: "ok",
    attempts: 1,
    cleanup: "home_confirmed",
    ...overrides,
  };
}

function campaign(
  id: string,
  platform: Platform,
  status: CampaignStatus,
  assignments: HistoryAssignment[],
  startedAt: string,
  cancellationReason?: string,
): HistoryCampaign {
  return {
    id,
    platform,
    startedAt,
    deviceIds: [...new Set(assignments.map((item) => item.deviceId))],
    postUrls: [...new Set(assignments.map((item) => item.postUrl))],
    actions: { like: true, comment: true },
    status,
    completedAssignments: assignments.filter((item) => ["sent", "failed", "outcome_unknown", "cancelled"].includes(item.status)).length,
    totalAssignments: assignments.length,
    assignments,
    cancellationReason,
  };
}

const demoPost = "https://www.facebook.com/demo/posts/historial";
const demoTikTok = "https://www.tiktok.com/@demo/video/7410000000000000000";

export const demoHistory: HistoryCampaign[] = [
  campaign("CMP-260903-A1F4", "facebook", "running", [
    historyAssignment("A1F4", "device-01", demoPost, "sent"),
    historyAssignment("A1F4", "device-02", demoPost, "running", { actualAt: "2026-09-03T15:32:00.000Z" }),
    historyAssignment("A1F4", "device-01", "https://fb.watch/demo-activo", "pending", { actualAt: null, likeResult: "not_requested", commentResult: "not_requested" }),
  ], "2026-09-03T15:30:00.000Z"),
  campaign("CMP-260903-7C21", "facebook", "completed", [
    historyAssignment("7C21", "device-01", demoPost, "sent"),
    historyAssignment("7C21", "device-02", demoPost, "sent"),
  ], "2026-09-03T12:00:00.000Z"),
  campaign("CMP-260902-9E10", "tiktok", "completed_with_issues", [
    historyAssignment("9E10", "device-03", demoTikTok, "sent"),
    historyAssignment("9E10", "device-01", demoTikTok, "failed", { commentResult: "failed", error: "Comentario rechazado en la simulación." }),
  ], "2026-09-02T18:45:00.000Z"),
  campaign("CMP-260902-110B", "facebook", "completed_with_issues", [
    historyAssignment("110B", "device-01", demoPost, "outcome_unknown", {
      likeResult: "outcome_unknown",
      commentResult: "outcome_unknown",
      error: "Se perdió confirmación después de una posible acción pública.",
      cleanup: "unknown",
    }),
  ], "2026-09-02T16:20:00.000Z"),
  campaign("CMP-260901-80DD", "tiktok", "cancelled", [
    historyAssignment("80DD", "device-03", demoTikTok, "cancelled", { likeResult: "not_requested", commentResult: "not_requested" }),
  ], "2026-09-01T10:05:00.000Z", "Cancelación solicitada por el operador."),
  campaign("CMP-260831-5AF0", "facebook", "cancelled_with_cleanup_errors", [
    historyAssignment("5AF0", "device-07", demoPost, "cancelled", {
      likeResult: "not_requested",
      commentResult: "not_requested",
      cleanup: "unknown",
      error: "No se pudo confirmar Home; requiere recuperación manual.",
    }),
  ], "2026-08-31T19:10:00.000Z", "Aborto global; cleanup incierto en un dispositivo."),
];

export function createInitialState(now = new Date().toISOString()): ControlState {
  const tiktok = emptyDraft("tiktok");
  tiktok.selectedDeviceIds = ["device-01", "device-03"];
  tiktok.urlInput = demoTikTok;
  tiktok.urls = [demoTikTok];
  tiktok.distribution[0].count = 2;

  return {
    activeView: "devices",
    runtimeHealth: [
      { id: "adb", label: "ADB", status: "ready", detail: "3 conectados", simulated: true },
      { id: "appium", label: "Appium", status: "ready", detail: "Loopback", simulated: true },
      { id: "ai", label: "IA", status: "degraded", detail: "Latencia demo", simulated: true },
      { id: "facebookWeb", label: "Sesión Facebook", status: "ready", detail: "Perfil demo", simulated: true },
      { id: "updates", label: "Actualizaciones", status: "ready", detail: "Snapshot demo", simulated: true },
    ],
    devices: demoDevices,
    facebookDraft: preparedFacebookDraft(),
    tiktokDraft: tiktok,
    history: demoHistory,
    notice: {
      kind: "status",
      title: "Datos de demostración cargados",
      message: "Todo el panel opera en memoria. Ninguna acción sale de este navegador.",
    },
    activeModal: null,
    demoOperations: {
      now,
      deviceImportText: "",
      deviceImportErrors: [],
      deviceSearch: "",
      selectedDeviceIds: [],
      deviceEditor: null,
      historyFilters: { platform: "all", status: "all", deviceId: "all", date: "", query: "" },
      abort: { active: false, step: 0, deviceCleanup: {} },
    },
  };
}
