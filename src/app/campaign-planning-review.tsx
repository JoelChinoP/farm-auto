import { Alert, Badge, Button, Group, Radio, SegmentedControl, Text, TextInput, Title } from "@mantine/core";

import type { CampaignDraft, ControlDispatch, ControlState, Device, Platform } from "./control-panel.types";
import { formatDate } from "./demo-state";
import { groupAssignments, isDeviceEligible } from "./campaign-view.utils";

interface CampaignPlanningReviewProps {
  platform: Platform;
  label: string;
  draft: CampaignDraft;
  state: ControlState;
  dispatch: ControlDispatch;
}

export function CampaignPlanningReview({ platform, label, draft, state, dispatch }: CampaignPlanningReviewProps) {
  const selectedDevices = draft.selectedDeviceIds.map((id) => state.devices.find((device) => device.id === id)).filter((device): device is Device => Boolean(device));
  const selectedInvalid = selectedDevices.some((device) => !isDeviceEligible(device, platform));
  const staleComments = draft.posts.flatMap((post) => post.comments).filter((comment) => comment.stale).length;
  const invalidComments = draft.posts.flatMap((post) => post.comments).filter((comment) => comment.text.trim().length < 2 || comment.text.length > 500 || ["failed", "generating", "regenerating", "pending"].includes(comment.status)).length;
  const failedPosts = draft.posts.filter((post) => ["failed", "session_required", "intervention_required"].includes(post.contextStatus)).length;
  const validStart = draft.scheduleStart === "now" || Boolean(draft.scheduleDateTime && !Number.isNaN(new Date(draft.scheduleDateTime).getTime()));
  const canSchedule = failedPosts === 0 && staleComments === 0 && (!draft.actions.comment || invalidComments === 0) && validStart;
  const schedules = draft.assignments.map((item) => item.scheduledAt).filter(Boolean).sort();
  const firstSchedule = schedules[0] ?? null;

  if (platform === "facebook") {
    const missingAccounts = selectedDevices.filter((device) => !device.facebookAccount).length;
    const normalizedAccounts = selectedDevices.map((device) => device.facebookAccount?.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("es"));
    const sharedAccounts = normalizedAccounts.filter(Boolean).length !== new Set(normalizedAccounts.filter(Boolean)).size;
    const executionBlocked = draft.assignments.some((assignment) => ["running", "cancellation_requested", "sent", "outcome_unknown"].includes(assignment.status));
    const canStartPhase5 = draft.scheduleStatus === "valid"
      && ["ready", "scheduled"].includes(draft.status)
      && !selectedInvalid
      && staleComments === 0
      && (!draft.actions.comment || invalidComments === 0)
      && missingAccounts === 0
      && !executionBlocked;
    const blockers = [
      selectedInvalid && "dispositivo preparado",
      staleComments > 0 && `${staleComments} comentarios desactualizados`,
      invalidComments > 0 && `${invalidComments} comentarios incompletos`,
      missingAccounts > 0 && `${missingAccounts} cuentas sin asociar`,
      draft.scheduleStatus !== "valid" && "horario válido",
      executionBlocked && "ejecución activa, enviada o incierta",
    ].filter(Boolean);

    return (
      <>
        <section className="planning-section" aria-labelledby="facebook-planning-title">
          <div className="section-toolbar compact"><div><span className="section-code">PLANIFICACIÓN / FASE 5</span><Title order={2} id="facebook-planning-title">Congelar horario multidispositivo</Title></div>{draft.scheduleStatus === "frozen" && <Badge color="blue" size="lg">Plan inmutable</Badge>}</div>
          <div className="planning-grid">
            <div className="schedule-controls">
              <Radio.Group label="Inicio" value={draft.scheduleStart} onChange={(value) => dispatch({ type: "set-schedule", platform, field: "scheduleStart", value })}><Group mt="xs"><Radio value="now" label="Ahora" /><Radio value="custom" label="Fecha y hora local" /></Group></Radio.Group>
              <TextInput type="datetime-local" label="Fecha y hora" disabled={draft.scheduleStart !== "custom"} value={draft.scheduleDateTime} onChange={(event) => dispatch({ type: "set-schedule", platform, field: "scheduleDateTime", value: event.currentTarget.value })} />
              <Button disabled={!canSchedule || draft.scheduleStatus === "frozen"} onClick={() => dispatch({ type: "generate-schedule", platform })}>{draft.scheduleStatus === "valid" || draft.scheduleStatus === "stale" ? "Regenerar plan" : "Generar plan N×M"}</Button>
              {!validStart && <Text className="inline-error">Indica una fecha y hora local válida.</Text>}
            </div>
            <div className="schedule-explainer"><span>REGLA OPERATIVA</span><Title order={3}>Paralelo entre equipos.<br />Secuencial por equipo.</Title><Text>Todos quedan disponibles en el mismo inicio. La cola prioriza la primera publicación y no reclama dos jobs del mismo dispositivo.</Text><dl><div><dt>Inicio</dt><dd>{formatDate(firstSchedule)}</dd></div><div><dt>Matriz</dt><dd>{draft.posts.length} × {draft.selectedDeviceIds.length} = {draft.assignments.length}</dd></div></dl></div>
          </div>
        </section>
        <section className="review-section" aria-labelledby="facebook-review-title">
          <div className="section-toolbar compact"><div><span className="section-code">REVISIÓN / FASE 5</span><Title order={2} id="facebook-review-title">Confirmar campaña pública</Title></div><SegmentedControl value={draft.reviewGrouping} onChange={(value) => dispatch({ type: "set-review-group", platform, value: value as "post" | "device" })} data={[{ label: "Por publicación", value: "post" }, { label: "Por dispositivo", value: "device" }]} /></div>
          <div className="review-grid">
            <div className="review-summary">
              <dl><div><dt>Dispositivos</dt><dd>{draft.selectedDeviceIds.length}</dd></div><div><dt>Publicaciones</dt><dd>{draft.posts.length}</dd></div><div><dt>Ejecuciones</dt><dd>{draft.assignments.length}</dd></div><div><dt>Acciones</dt><dd>{[draft.actions.like && "Like", draft.actions.comment && "Comentario"].filter(Boolean).join(" + ")}</dd></div><div><dt>Inicio</dt><dd>{formatDate(firstSchedule)}</dd></div></dl>
              {sharedAccounts && <Alert color="yellow" title="Cuenta repetida">La autorización final exigirá una decisión explícita para compartir una cuenta entre dispositivos.</Alert>}
              <Alert color="red" title="Puede producir efectos públicos">La confirmación final muestra cuentas, URLs, textos objetivo y comentarios antes de crear {draft.assignments.length} jobs.</Alert>
              <Button size="lg" fullWidth disabled={!canStartPhase5} onClick={() => dispatch({ type: "request-start-campaign", platform })}>Revisar y autorizar {draft.assignments.length} ejecuciones</Button>
              {!canStartPhase5 && <Text className="review-blockers">Pendientes: {blockers.join(" · ") || "campaña lista"}</Text>}
            </div>
            <div className="assignment-review"><span className="section-code">PLAN CONGELABLE</span>{groupAssignments(draft, state.devices).map((group) => <div className="assignment-group" key={group.label}><strong>{group.label}</strong><small>{group.items.length} ejecuciones</small>{group.items.map((item) => <span key={item.id}><code>{formatDate(item.scheduledAt)}</code>{item.detail}</span>)}</div>)}</div>
          </div>
        </section>
      </>
    );
  }

  const executionBlocked = draft.assignments.some((assignment) => ["running", "cancellation_requested", "sent", "outcome_unknown"].includes(assignment.status));
  const canStartTikTok = draft.mode !== "live"
    && draft.status === "ready"
    && draft.posts.length === 1
    && draft.assignments.length === 1
    && !selectedInvalid
    && staleComments === 0
    && (!draft.actions.comment || invalidComments === 0)
    && !executionBlocked;
  const blockers = [
    selectedInvalid && "dispositivo preparado",
    draft.posts.length !== 1 && "una publicación",
    draft.assignments.length !== 1 && "una asignación",
    staleComments > 0 && "comentario desactualizado",
    draft.actions.comment && invalidComments > 0 && "comentario incompleto",
    executionBlocked && "ejecución activa, enviada o incierta",
  ].filter(Boolean);

  return (
    <section className="review-section" aria-labelledby="tiktok-review-title">
      <div className="section-toolbar compact"><div><span className="section-code">REVISIÓN / TIKTOK POST 1×1</span><Title order={2} id="tiktok-review-title">Autorizar una ejecución</Title></div><Badge color="cyan" size="lg">1 publicación × 1 dispositivo</Badge></div>
      <div className="review-grid">
        <div className="review-summary">
          <dl><div><dt>Plataforma</dt><dd>{label}</dd></div><div><dt>Dispositivo</dt><dd>{selectedDevices[0]?.alias ?? "Sin seleccionar"}</dd></div><div><dt>Publicación</dt><dd>{draft.posts[0]?.url ?? "Sin preparar"}</dd></div><div><dt>Acciones</dt><dd>{[draft.actions.like && "Like", draft.actions.comment && "Comentario"].filter(Boolean).join(" + ")}</dd></div></dl>
          <Alert color="red" title="Puede producir efectos públicos">Se volverán a verificar app, cuenta, publicación, Like y comentario antes de cada frontera de efecto.</Alert>
          <Button size="lg" fullWidth disabled={!canStartTikTok} onClick={() => dispatch({ type: "request-start-campaign", platform })}>Revisar y autorizar 1 ejecución</Button>
          {!canStartTikTok && <Text className="review-blockers">Pendientes: {blockers.join(" · ") || "campaña lista"}</Text>}
        </div>
        <div className="assignment-review"><span className="section-code">OBJETIVO PERSISTIDO</span>{groupAssignments(draft, state.devices).map((group) => <div className="assignment-group" key={group.label}><strong>{group.label}</strong><small>1 ejecución</small>{group.items.map((item) => <span key={item.id}>{item.detail}</span>)}</div>)}</div>
      </div>
    </section>
  );
}
