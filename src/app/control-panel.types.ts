export type ViewId = "devices" | "facebook" | "tiktok" | "history";
export type Platform = "facebook" | "tiktok";
export type HealthStatus = "checking" | "ready" | "degraded" | "unavailable";
export type ConnectionStatus = "connected" | "offline" | "unauthorized";
export type PreparationStatus = "not_ready" | "preparing" | "ready" | "failed";
export type CapabilityStatus = "not_installed" | "session_required" | "ready";
export type CampaignStatus =
  | "draft"
  | "preparing"
  | "ready"
  | "scheduled"
  | "running"
  | "completed"
  | "completed_with_issues"
  | "cancellation_requested"
  | "cancelled"
  | "cancelled_with_cleanup_errors";
export type PostStatus =
  | "queued"
  | "extracting"
  | "context_ready"
  | "generating"
  | "ready"
  | "scheduled"
  | "running"
  | "completed"
  | "partial_failed"
  | "outcome_unknown"
  | "cancelled";
export type CommentStatus =
  | "pending"
  | "generating"
  | "ready"
  | "edited"
  | "regenerating"
  | "failed"
  | "outcome_unknown";
export type ContextStatus =
  | "queued"
  | "extracting"
  | "ready"
  | "cached"
  | "edited"
  | "failed"
  | "session_required"
  | "intervention_required";
export type ScheduleStatus = "none" | "valid" | "stale" | "frozen";
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
  error?: string;
}

export interface CampaignPost {
  id: string;
  position: number;
  url: string;
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
  status: PostStatus;
  scheduledAt: string | null;
  actualAt: string | null;
}

export interface CampaignDraft {
  platform: Platform;
  status: CampaignStatus;
  selectedDeviceIds: string[];
  urlInput: string;
  urls: string[];
  urlErrors: UrlLineError[];
  actions: { like: boolean; comment: boolean };
  distribution: IntentDistribution[];
  posts: CampaignPost[];
  assignments: CampaignAssignment[];
  selectedPostId: string | null;
  scheduleStart: "now" | "custom";
  scheduleDateTime: string;
  maxWaitMinutes: number;
  scheduleStatus: ScheduleStatus;
  reviewGrouping: "post" | "device";
}

export interface HistoryAssignment {
  id: string;
  postUrl: string;
  deviceId: string;
  deviceAlias: string;
  deviceSerial: string;
  plannedAt: string;
  actualAt: string | null;
  status: PostStatus;
  comment: string | null;
  context: string;
  likeResult: "ok" | "failed" | "not_requested" | "outcome_unknown";
  commentResult: "ok" | "failed" | "not_requested" | "outcome_unknown";
  error?: string;
  attempts: number;
  cleanup: "home_confirmed" | "session_closed" | "unknown" | "failed";
}

export interface HistoryCampaign {
  id: string;
  platform: Platform;
  startedAt: string;
  deviceIds: string[];
  postUrls: string[];
  actions: { like: boolean; comment: boolean };
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
  | { type: "start-campaign"; platform: Platform }
  | { type: "regenerate-post"; platform: Platform; postId: string }
  | { type: "abort-all" }
  | { type: "history-detail"; campaignId: string };

export interface DeviceEditor {
  alias: string;
  order: number;
  serial: string;
  systemPort: number;
  errors: Partial<Record<"alias" | "order" | "serial" | "systemPort", string>>;
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
  | { type: "start-device-preparation"; deviceIds: string[] }
  | { type: "advance-device-preparation"; deviceId: string; step: string }
  | { type: "finish-device-preparation"; deviceId: string; failed?: boolean }
  | { type: "set-campaign-devices"; platform: Platform; deviceIds: string[] }
  | { type: "set-campaign-urls"; platform: Platform; value: string }
  | { type: "remove-campaign-url"; platform: Platform; index: number }
  | { type: "move-campaign-url"; platform: Platform; index: number; direction: -1 | 1 }
  | { type: "toggle-campaign-action"; platform: Platform; action: "like" | "comment" }
  | { type: "add-distribution"; platform: Platform }
  | { type: "remove-distribution"; platform: Platform; id: string }
  | { type: "update-distribution"; platform: Platform; id: string; field: "intention" | "tone" | "count"; value: string | number }
  | { type: "prepare-campaign"; platform: Platform }
  | { type: "advance-post"; platform: Platform; postId: string; stage: "context" | "comments" | "failed" }
  | { type: "select-post"; platform: Platform; postId: string }
  | { type: "edit-context"; platform: Platform; postId: string; value: string }
  | { type: "restore-context"; platform: Platform; postId: string }
  | { type: "retry-context"; platform: Platform; postId: string }
  | { type: "edit-comment"; platform: Platform; postId: string; commentId: string; value: string }
  | { type: "update-comment-profile"; platform: Platform; postId: string; commentId: string; field: "intention"; value: string }
  | { type: "update-comment-profile"; platform: Platform; postId: string; commentId: string; field: "tone"; value: Tone }
  | { type: "start-comment-regeneration"; platform: Platform; postId: string; commentIds: string[] }
  | { type: "finish-comment-regeneration"; platform: Platform; postId: string; commentIds: string[] }
  | { type: "request-regenerate-post"; platform: Platform; postId: string }
  | { type: "set-schedule"; platform: Platform; field: "scheduleStart" | "scheduleDateTime" | "maxWaitMinutes"; value: string | number }
  | { type: "generate-schedule"; platform: Platform }
  | { type: "set-review-group"; platform: Platform; value: "post" | "device" }
  | { type: "request-start-campaign"; platform: Platform }
  | { type: "start-campaign"; platform: Platform }
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
