import { Alert, Badge, Button, Text, TextInput, Title } from "@mantine/core";

import type { CampaignDraft, ControlDispatch, ControlState, Device, Platform } from "./control-panel.types";
import { formatDate } from "./demo-state";
import { isDeviceEligible } from "./campaign-view.utils";
import type { TikTokConfiguration } from "./tiktok-live-panel";

interface CampaignPlanningReviewProps {
  platform: Platform;
  draft: CampaignDraft;
  state: ControlState;
  dispatch: ControlDispatch;
  configuration?: TikTokConfiguration | null;
}

export function CampaignPlanningReview({ platform, draft, state, dispatch, configuration }: CampaignPlanningReviewProps) {
  const selectedDevices = draft.selectedDeviceIds.map((id) => state.devices.find((device) => device.id === id)).filter((device): device is Device => Boolean(device));
  const selectedInvalid = selectedDevices.some((device) => !isDeviceEligible(device, platform));
  const staleComments = draft.posts.flatMap((post) => post.comments).filter((comment) => comment.stale).length;
  const invalidComments = draft.posts.flatMap((post) => post.comments).filter((comment) => comment.text.trim().length < 2 || comment.text.length > 500 || ["failed", "generating", "regenerating", "pending"].includes(comment.status)).length;
  const failedPosts = draft.posts.filter((post) => ["failed", "session_required", "intervention_required"].includes(post.contextStatus)).length;
  const deadlineValid = !draft.scheduleDeadline || !Number.isNaN(new Date(draft.scheduleDeadline).getTime());
  const targetTextsValid = draft.posts.every((post) => post.context.trim().length >= 5);
  const executionBlocked = draft.assignments.some((assignment) => ["running", "cancellation_requested", "sent", "outcome_unknown"].includes(assignment.status));
  const scheduledDevices = selectedDevices.filter((device) =>
    draft.assignments.some((assignment) => assignment.deviceId === device.id && assignment.scheduledAt));
  const actionsLabel = [draft.actions.like && "Like", draft.actions.comment && "Comentario", draft.actions.share && "Compartir"].filter(Boolean).join(" + ") || "Ninguna";

  if (platform === "facebook") {
    const missingAccounts = selectedDevices.filter((device) => !device.facebookAccount).length;
    const canPublish = draft.status === "ready"
      && !selectedInvalid
      && failedPosts === 0
      && staleComments === 0
      && (!draft.actions.comment || invalidComments === 0)
      && deadlineValid
      && targetTextsValid
      && missingAccounts === 0
      && !executionBlocked;
    const blockers = [
      selectedInvalid && "dispositivo preparado",
      failedPosts > 0 && `${failedPosts} publicaciones con error`,
      staleComments > 0 && `${staleComments} comentarios desactualizados`,
      invalidComments > 0 && `${invalidComments} comentarios incompletos`,
      !deadlineValid && "hora máxima válida",
      !targetTextsValid && "texto visible de cada publicación (mínimo 5 caracteres)",
      missingAccounts > 0 && `${missingAccounts} cuentas sin asociar`,
      executionBlocked && "ejecución activa, enviada o incierta",
    ].filter(Boolean);

    return (
      <section className="planning-section" aria-labelledby="facebook-planning-title">
        <div className="section-toolbar compact">
          <div><span className="section-code">PROGRAMACIÓN / PASO 03</span><Title order={2} id="facebook-planning-title">Programar horarios</Title></div>
          {["scheduled", "running"].includes(draft.status) && <Badge color="blue" size="lg">Plan inmutable</Badge>}
        </div>
        <div className="planning-grid">
          <div className="schedule-controls">
            <TextInput
              type="datetime-local"
              label="Hora máxima (opcional)"
              description="Cada dispositivo se programa en un momento aleatorio entre ahora y esta hora."
              disabled={draft.status !== "ready"}
              value={draft.scheduleDeadline}
              onChange={(event) => dispatch({ type: "set-schedule-deadline", platform, value: event.currentTarget.value })}
            />
            <Alert color="blue" title="¿Cómo funciona?">
              Si dejas la hora vacía o ya pasó, los {draft.assignments.length} jobs se publican de inmediato. Cada equipo publica sus publicaciones en orden, en paralelo con los demás.
            </Alert>
            {draft.actions.share && <Alert color="red" title="Compartir es una acción pública">El worker abre el menú del post o reel, confirma “Compartir ahora” y exige una confirmación visible de Facebook. Si no puede confirmarla, la asignación quedará bloqueada para reconciliación manual.</Alert>}
            <Button size="lg" color="red" fullWidth disabled={!canPublish} onClick={() => dispatch({ type: "request-start-campaign", platform })}>
              Publicar {draft.assignments.length} ejecuciones
            </Button>
            {!canPublish && <Text className="review-blockers">Pendientes: {blockers.join(" · ") || "campaña lista"}</Text>}
          </div>
          <div className="schedule-explainer">
            <span>REPARTO ALEATORIO</span>
            <Title order={3}>Entre ahora y la hora máxima, cada equipo recibe su momento.</Title>
            <Text>La cola prioriza la primera publicación y no reclama dos jobs del mismo dispositivo al mismo tiempo.</Text>
            <dl>
              <div><dt>Dispositivos</dt><dd>{draft.selectedDeviceIds.length}</dd></div>
              <div><dt>Publicaciones</dt><dd>{draft.posts.length}</dd></div>
              <div><dt>Ejecuciones</dt><dd>{draft.assignments.length}</dd></div>
              <div><dt>Acciones</dt><dd>{actionsLabel}</dd></div>
            </dl>
          </div>
        </div>
        {scheduledDevices.length > 0 && (
          <div className="assignment-review">
            <span className="section-code">PLAN GENERADO</span>
            {scheduledDevices.map((device) => {
              const at = draft.assignments.find((assignment) => assignment.deviceId === device.id)?.scheduledAt;
              return (
                <div className="assignment-group" key={device.id}>
                  <strong>{device.alias}</strong>
                  <small>{at ? formatDate(at) : "De inmediato"}</small>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  const effectsEnabled = configuration?.postEffectsEnabled === true && configuration.postSelectorsConfigured
    && (!draft.actions.comment || configuration.commentSelectorsConfigured);
  const canPublish = draft.mode !== "live"
    && draft.status === "ready"
    && draft.posts.length >= 1
    && draft.assignments.length === draft.posts.length * draft.selectedDeviceIds.length
    && !selectedInvalid
    && failedPosts === 0
    && staleComments === 0
    && (!draft.actions.comment || invalidComments === 0)
    && targetTextsValid
    && !executionBlocked
    && Boolean(configuration?.controlledAccount)
    && effectsEnabled;
  const blockers = [
    !effectsEnabled && "efectos TikTok habilitados y selectores configurados",
    !configuration?.controlledAccount && "cuenta controlada configurada",
    selectedInvalid && "dispositivo preparado",
    draft.posts.length < 1 && "al menos una publicación",
    draft.assignments.length !== draft.posts.length * draft.selectedDeviceIds.length && "matriz completa",
    failedPosts > 0 && `${failedPosts} publicaciones con error`,
    staleComments > 0 && "comentarios desactualizados",
    draft.actions.comment && invalidComments > 0 && "comentarios incompletos",
    !targetTextsValid && "texto visible de cada publicación (mínimo 5 caracteres)",
    executionBlocked && "ejecución activa, enviada o incierta",
  ].filter(Boolean);

  return (
    <section className="planning-section" aria-labelledby="tiktok-publish-title">
      <div className="section-toolbar compact">
        <div><span className="section-code">PROGRAMACIÓN / PASO 03</span><Title order={2} id="tiktok-publish-title">Programar y publicar</Title></div>
        <Badge color="cyan" size="lg">{draft.posts.length} publicaciones × {draft.selectedDeviceIds.length} dispositivos</Badge>
      </div>
      <div className="planning-grid">
        <div className="schedule-controls">
          <Alert color="red" title="Publicación directa">El Like y comentario seleccionados pueden quedar visibles en TikTok de inmediato. Un resultado incierto se bloqueará hasta reconciliarlo manualmente.</Alert>
          <Button size="lg" color="red" fullWidth disabled={!canPublish} onClick={() => dispatch({ type: "request-start-campaign", platform })}>
            Publicar {draft.assignments.length} ejecuciones TikTok
          </Button>
          {!canPublish && <Text className="review-blockers">Pendientes: {blockers.join(" · ") || "campaña lista"}</Text>}
        </div>
        <div className="schedule-explainer">
          <span>EJECUCIÓN</span>
          <Title order={3}>Inmediata y secuencial por equipo.</Title>
          <Text>La cuenta controlada, las URLs y el texto objetivo se revalidan antes de cualquier efecto.</Text>
          <dl>
            <div><dt>Dispositivos</dt><dd>{draft.selectedDeviceIds.length}</dd></div>
            <div><dt>Publicaciones</dt><dd>{draft.posts.length}</dd></div>
            <div><dt>Ejecuciones</dt><dd>{draft.assignments.length}</dd></div>
            <div><dt>Acciones</dt><dd>{actionsLabel}</dd></div>
            <div><dt>Cuenta controlada</dt><dd>{draft.controlledAccount ?? "Sin configurar"}</dd></div>
          </dl>
        </div>
      </div>
    </section>
  );
}
