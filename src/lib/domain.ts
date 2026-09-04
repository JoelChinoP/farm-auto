export const PLATFORMS = ["facebook", "tiktok"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CAMPAIGN_STATUSES = [
  "draft",
  "preparing",
  "ready",
  "scheduled",
  "running",
  "completed",
  "completed_with_issues",
  "cancellation_requested",
  "cancelled",
  "cancelled_with_cleanup_errors",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const POST_STATUSES = [
  "queued",
  "extracting",
  "context_ready",
  "generating",
  "ready",
  "scheduled",
  "running",
  "completed",
  "partial_failed",
  "outcome_unknown",
  "cancelled",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const ASSIGNMENT_STATUSES = [
  "pending",
  "generating",
  "draft",
  "approved",
  "scheduled",
  "running",
  "sent",
  "failed",
  "outcome_unknown",
  "cancellation_requested",
  "cancelled",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const OPERATION_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const PREPARATION_STATUSES = [
  "not_ready",
  "preparing",
  "ready",
  "failed",
  "recovery_required",
] as const;
export type PreparationStatus = (typeof PREPARATION_STATUSES)[number];

export const SESSION_STATUSES = [
  "not_started",
  "starting",
  "active",
  "closing",
  "closed",
  "failed",
  "outcome_unknown",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const CLEANUP_STATUSES = [
  "not_required",
  "pending",
  "session_closed",
  "home_confirmed",
  "failed",
  "outcome_unknown",
] as const;
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

export const COMMENT_STATUSES = [
  "pending",
  "generating",
  "ready",
  "edited",
  "regenerating",
  "failed",
  "outcome_unknown",
] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const CONTEXT_STATUSES = [
  "queued",
  "extracting",
  "ready",
  "cached",
  "edited",
  "failed",
  "session_required",
  "intervention_required",
] as const;
export type ContextStatus = (typeof CONTEXT_STATUSES)[number];

export const EFFECT_PHASES = ["none", "before_effect", "effect_possible", "effect_confirmed"] as const;
export type EffectPhase = (typeof EFFECT_PHASES)[number];

export const OPERATION_KINDS = [
  "campaign.create",
  "device.prepare",
  "post.extract",
  "comments.generate",
  "assignment.execute",
  "campaign.cancel",
  "operation.reconcile",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];
