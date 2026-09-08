import type {
  AssignmentStatus,
  CampaignStatus,
  CommentStatus,
  ContextStatus,
  Platform,
  PostStatus,
  PreparationStatus,
  CleanupStatus,
  EffectPhase,
  OperationStatus,
  SessionStatus,
} from "@/lib/domain";

export type {
  AssignmentStatus,
  CampaignStatus,
  CommentStatus,
  ContextStatus,
  Platform,
  PostStatus,
  PreparationStatus,
  CleanupStatus,
  EffectPhase,
  OperationStatus,
  SessionStatus,
} from "@/lib/domain";

export type ViewId = "devices" | "facebook" | "tiktok" | "history";
export type HealthStatus = "checking" | "ready" | "degraded" | "unavailable";
export type ConnectionStatus = "connected" | "offline" | "unauthorized";
export type CapabilityStatus = "not_installed" | "session_required" | "ready";
export type Tone = "Cercano" | "Entusiasta" | "Informativo" | "Breve";

export interface RuntimeService {
  id: "adb" | "appium" | "ai" | "facebookWeb" | "updates";
  label: string;
  status: HealthStatus;
  detail: string;
  simulated: true;
}

export interface Device {
  id: string;
  order: number;
  alias: string;
  serial: string;
  model: string;
  connection: ConnectionStatus;
  preparation: PreparationStatus;
  preparationStep?: string;
  capabilities: Record<Platform, CapabilityStatus>;
  activity: "available" | "busy" | "recovery_required";
  systemPort: number;
  hardwareId: string;
  lastPreparation: string | null;
  lastPlatformCheck: Record<Platform, string | null>;
  facebookAccount?: string | null;
  retireAfterCampaign?: boolean;
}

export interface UrlLineError {
  line: number;
  value: string;
  message: string;
}

export type DeviceLineError = UrlLineError;

export interface IntentDistribution {
  id: string;
  intention: string;
  tone: Tone;
  count: number;
}

export interface CampaignComment {
  id: string;
  assignmentId: string;
  deviceId: string;
  intention: string;
  tone: Tone;
  text: string;
  status: CommentStatus;
  stale: boolean;
  source?: "generated" | "manual";
  version?: number;
  textHash?: string;
  error?: string;
}

export interface CampaignActionResult {
  status: "pending" | "effect_possible" | "confirmed" | "failed" | "outcome_unknown" | "cancelled" | "reconciled_not_sent";
  result: "already_active" | "activated" | "sent" | "preserved" | "not_sent" | null;
  error: string | null;
}

export interface CampaignExecution {
  operationId: string;
  status: OperationStatus;
  effectPhase: EffectPhase;
  sessionStatus: SessionStatus;
  cleanupStatus: CleanupStatus;
  attempts: number;
  confirmedRounds?: number;
  requestedRounds?: number;
  error: string | null;
  uncertainAction: "like" | "comment" | "share" | "live_round" | null;
  like: CampaignActionResult | null;
  comment: CampaignActionResult | null;
  share?: CampaignActionResult | null;
  checkpoints: Array<{ id: string; phase: string; sequence: number; createdAt: number }>;
  evidence: Array<{ checkpointId: string | null; kind: "metadata" | "screenshot" | "page_source"; path: string; createdAt: number }>;
}

export interface CampaignPost {
  id: string;
  position: number;
  url: string;
  finalUrl?: string | null;
  status: PostStatus;
  contextStatus: ContextStatus;
  context: string;
  extractedContext: string;
  contextSource: "extracted" | "cache" | "manual" | null;
  extractedAt: string | null;
  elapsedSeconds: number;
  comments: CampaignComment[];
  error?: string;
}

export interface CampaignAssignment {
  id: string;
  postId: string;
  deviceId: string;
  status: AssignmentStatus;
  scheduledAt: string | null;
  actualAt: string | null;
  execution: CampaignExecution | null;
}

export interface CampaignDraft {
  id?: string | null;
  revision?: number;
  platform: Platform;
  mode?: "post" | "live";
  status: CampaignStatus;
  selectedDeviceIds: string[];
  urlInput: string;
  urls: string[];
  urlErrors: UrlLineError[];
  actions: { like: boolean; comment: boolean; share?: boolean };
  controlledAccount?: string | null;
  distribution: IntentDistribution[];
  posts: CampaignPost[];
  assignments: CampaignAssignment[];
  selectedPostId: string | null;
  scheduleDeadline: string;
}

export interface HistoryAssignment {
  id: string;
  operationId?: string | null;
  postUrl: string;
  deviceId: string;
  deviceAlias: string;
  deviceSerial: string;
  plannedAt: string;
  actualAt: string | null;
  status: AssignmentStatus;
  comment: string | null;
  context: string;
  likeResult: "ok" | "failed" | "not_requested" | "outcome_unknown";
  commentResult: "ok" | "failed" | "not_requested" | "outcome_unknown";
  shareResult: "ok" | "failed" | "not_requested" | "outcome_unknown";
  error?: string;
  attempts: number;
  confirmedRounds?: number;
  requestedRounds?: number;
  cleanup: "home_confirmed" | "session_closed" | "unknown" | "failed";
  uncertainAction?: "like" | "comment" | "share" | "live_round" | null;
  checkpoints?: CampaignExecution["checkpoints"];
  evidence?: CampaignExecution["evidence"];
}

export interface HistoryCampaign {
  id: string;
  platform: Platform;
  mode?: "post" | "live";
  startedAt: string;
  deviceIds: string[];
  postUrls: string[];
  actions: { like: boolean; comment: boolean; share?: boolean };
  status: CampaignStatus;
  completedAssignments: number;
  totalAssignments: number;
  assignments: HistoryAssignment[];
  cancellationReason?: string;
}

export interface Notice {
  kind: "status" | "error";
  title: string;
  message: string;
}

export type ActiveModal =
  | null
  | { type: "edit-device"; deviceId: string }
  | { type: "retire-device"; deviceId: string }
  | { type: "clear-devices" }
  | { type: "regenerate-post"; platform: Platform; postId: string }
  | { type: "abort-all" }
  | { type: "history-detail"; campaignId: string };

export interface DeviceEditor {
  alias: string;
  order: number;
  serial: string;
  systemPort: number;
  facebookAccount: string;
  errors: Partial<Record<"alias" | "order" | "serial" | "systemPort" | "facebookAccount", string>>;
}

export interface HistoryFilters {
  platform: "all" | Platform;
  status: "all" | CampaignStatus | "outcome_unknown";
  deviceId: "all" | string;
  date: string;
  query: string;
}

export interface AbortOperation {
  active: boolean;
  step: number;
  deviceCleanup: Record<string, "pending" | "cancelling" | "session_closed" | "home_confirmed" | "cleanup_unknown" | "failed">;
}

export interface DemoOperations {
  now: string;
  deviceImportText: string;
  deviceImportErrors: DeviceLineError[];
  deviceSearch: string;
  selectedDeviceIds: string[];
  deviceEditor: DeviceEditor | null;
  historyFilters: HistoryFilters;
  abort: AbortOperation;
}

export interface ControlState {
  activeView: ViewId;
  runtimeHealth: RuntimeService[];
  devices: Device[];
  facebookDraft: CampaignDraft;
  tiktokDraft: CampaignDraft;
  history: HistoryCampaign[];
  notice: Notice | null;
  activeModal: ActiveModal;
  demoOperations: DemoOperations;
}

export type ControlAction =
  | { type: "tick"; now: string }
  | { type: "hydrate-devices"; devices: Device[] }
  | { type: "hydrate-facebook"; draft: CampaignDraft; force?: boolean }
  | { type: "hydrate-tiktok"; draft: CampaignDraft; force?: boolean }
  | { type: "hydrate-history"; platform: Platform; history: HistoryCampaign[] }
  | { type: "set-notice"; notice: Notice }
  | { type: "navigate"; view: ViewId }
  | { type: "clear-notice" }
  | { type: "set-device-import"; value: string }
  | { type: "add-devices" }
  | { type: "set-device-search"; value: string }
  | { type: "toggle-device-selection"; deviceId: string }
  | { type: "select-visible-devices"; deviceIds: string[]; selected: boolean }
  | { type: "open-device-editor"; deviceId: string }
  | { type: "update-device-editor"; field: keyof Omit<DeviceEditor, "errors">; value: string | number }
  | { type: "save-device" }
  | { type: "request-device-retirement"; deviceId: string }
  | { type: "confirm-device-retirement" }
  | { type: "request-clear-devices" }
  | { type: "confirm-clear-devices" }
  | { type: "recover-device-sessions" }
  | { type: "start-device-preparation"; deviceIds: string[] }
  | { type: "advance-device-preparation"; deviceId: string; step: string }
  | { type: "finish-device-preparation"; deviceId: string; failed?: boolean }
  | { type: "set-campaign-devices"; platform: Platform; deviceIds: string[] }
  | { type: "set-campaign-urls"; platform: Platform; value: string }
  | { type: "remove-campaign-url"; platform: Platform; index: number }
  | { type: "move-campaign-url"; platform: Platform; index: number; direction: -1 | 1 }
  | { type: "toggle-campaign-action"; platform: Platform; action: "like" | "comment" | "share" }
  | { type: "add-distribution"; platform: Platform }
  | { type: "remove-distribution"; platform: Platform; id: string }
  | { type: "update-distribution"; platform: Platform; id: string; field: "intention" | "tone" | "count"; value: string | number }
  | { type: "prepare-campaign"; platform: Platform }
  | { type: "campaign-requested"; platform: Platform }
  | { type: "campaign-request-failed"; platform: Platform }
  | { type: "advance-post"; platform: Platform; postId: string; stage: "context" | "comments" | "failed" }
  | { type: "select-post"; platform: Platform; postId: string }
  | { type: "edit-context"; platform: Platform; postId: string; value: string }
  | { type: "save-context"; platform: Platform; postId: string }
  | { type: "restore-context"; platform: Platform; postId: string }
  | { type: "retry-context"; platform: Platform; postId: string }
  | { type: "edit-comment"; platform: Platform; postId: string; commentId: string; value: string }
  | { type: "save-comment"; platform: Platform; postId: string; commentId: string }
  | { type: "update-comment-profile"; platform: Platform; postId: string; commentId: string; field: "intention"; value: string }
  | { type: "update-comment-profile"; platform: Platform; postId: string; commentId: string; field: "tone"; value: Tone }
  | { type: "start-comment-regeneration"; platform: Platform; postId: string; commentIds: string[] }
  | { type: "finish-comment-regeneration"; platform: Platform; postId: string; commentIds: string[] }
  | { type: "request-regenerate-post"; platform: Platform; postId: string }
  | { type: "set-schedule-deadline"; platform: Platform; value: string }
  | { type: "request-schedule-campaign"; platform: "facebook" }
  | { type: "request-publish-executions"; platform: "facebook" }
  | { type: "request-execute-now"; platform: "facebook" }
  | { type: "request-start-campaign"; platform: Platform }
  | { type: "cancel-assignment"; operationId: string }
  | { type: "reconcile-assignment"; platform: Platform; assignmentId: string; operationId: string; action: "like" | "comment" | "share"; resolution: "sent" | "not_sent" }
  | { type: "advance-running-campaign"; platform: Platform }
  | { type: "clear-campaign"; platform: Platform }
  | { type: "set-history-filter"; field: keyof HistoryFilters; value: string }
  | { type: "open-history"; campaignId: string }
  | { type: "request-abort" }
  | { type: "start-abort" }
  | { type: "advance-abort"; step: number }
  | { type: "finish-abort" }
  | { type: "close-modal" };

export type ControlDispatch = (action: ControlAction) => void;
