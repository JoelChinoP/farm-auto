import { Alert, Badge, Button, Group, NumberInput, Radio, SegmentedControl, Text, TextInput, Title } from "@mantine/core";

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
  const canStart = canSchedule && draft.scheduleStatus === "valid" && !selectedInvalid && draft.status !== "running";
  const schedules = draft.assignments.map((item) => item.scheduledAt).filter(Boolean).sort();
  const firstSchedule = schedules[0] ?? null;
  const lastSchedule = schedules.at(-1) ?? null;

  return (
    <>
      <section className="planning-section" aria-labelledby={`${platform}-planning-title`}>
        <div className="section-toolbar compact"><div><span className="section-code">PLANIFICACIÓN / PASO 03</span><Title order={2} id={`${platform}-planning-title`}>Generar horarios</Title></div>{draft.scheduleStatus === "stale" && <Badge color="red" size="lg">Planificación desactualizada</Badge>}{draft.scheduleStatus === "frozen" && <Badge color="blue" size="lg">Horario congelado</Badge>}</div>
        <div className="planning-grid">
          <div className="schedule-controls">
            <Radio.Group label="Inicio" value={draft.scheduleStart} onChange={(value) => dispatch({ type: "set-schedule", platform, field: "scheduleStart", value })}><Group mt="xs"><Radio value="now" label="Ahora" /><Radio value="custom" label="Fecha y hora local" /></Group></Radio.Group>
            <TextInput type="datetime-local" label="Fecha y hora" disabled={draft.scheduleStart !== "custom"} value={draft.scheduleDateTime} onChange={(event) => dispatch({ type: "set-schedule", platform, field: "scheduleDateTime", value: event.currentTarget.value })} />
            <NumberInput label="Máximo de espera (minutos)" min={0} max={1440} value={draft.maxWaitMinutes} onChange={(value) => dispatch({ type: "set-schedule", platform, field: "maxWaitMinutes", value: Number(value) || 0 })} />
            <Button disabled={!canSchedule || draft.scheduleStatus === "frozen"} onClick={() => dispatch({ type: "generate-schedule", platform })}>{draft.scheduleStatus === "valid" || draft.scheduleStatus === "stale" ? "Regenerar horarios" : "Generar horarios"}</Button>
            {!validStart && <Text className="inline-error">Indica una fecha y hora local válida.</Text>}
            {!canSchedule && <Text className="inline-error">Resuelve contexto y comentarios pendientes antes de planificar.</Text>}
          </div>
          <div className="schedule-explainer"><span>REGLA OPERATIVA</span><Title order={3}>Paralelo entre equipos.<br />Secuencial por equipo.</Title><Text>Dos dispositivos pueden coincidir. Un mismo equipo recibe cada publicación en un turno posterior.</Text><dl><div><dt>Primera ejecución</dt><dd>{formatDate(firstSchedule)}</dd></div><div><dt>Última ejecución</dt><dd>{formatDate(lastSchedule)}</dd></div></dl></div>
        </div>
      </section>

      <section className="review-section" aria-labelledby={`${platform}-review-title`}>
        <div className="section-toolbar compact"><div><span className="section-code">REVISIÓN / PASO 04</span><Title order={2} id={`${platform}-review-title`}>Confirmar campaña</Title></div><SegmentedControl value={draft.reviewGrouping} onChange={(value) => dispatch({ type: "set-review-group", platform, value: value as "post" | "device" })} data={[{ label: "Por publicación", value: "post" }, { label: "Por dispositivo", value: "device" }]} /></div>
        <div className="review-grid">
          <div className="review-summary">
            <dl><div><dt>Plataforma</dt><dd>{label}</dd></div><div><dt>Dispositivos</dt><dd>{draft.selectedDeviceIds.length}</dd></div><div><dt>Publicaciones</dt><dd>{draft.posts.length}</dd></div><div><dt>Ejecuciones</dt><dd>{draft.assignments.length}</dd></div><div><dt>Acciones</dt><dd>{[draft.actions.like && "Like", draft.actions.comment && "Comentario"].filter(Boolean).join(" + ")}</dd></div><div><dt>Comentarios</dt><dd>{draft.posts.flatMap((post) => post.comments).length}</dd></div><div><dt>Ventana</dt><dd>{firstSchedule ? `${formatDate(firstSchedule)} → ${formatDate(lastSchedule)}` : "Sin generar"}</dd></div></dl>
            <Alert color="red" title="Efectos públicos futuros">La implementación real requerirá confirmación explícita. Este modo no publica nada.</Alert>
            <Button size="lg" fullWidth disabled={!canStart} onClick={() => dispatch({ type: "request-start-campaign", platform })}>Iniciar campaña</Button>
            {!canStart && <Text className="review-blockers">Pendientes: {[selectedInvalid && "dispositivo inválido", failedPosts > 0 && `${failedPosts} contextos`, staleComments > 0 && `${staleComments} comentarios desactualizados`, invalidComments > 0 && `${invalidComments} comentarios incompletos`, draft.scheduleStatus !== "valid" && "horario válido"].filter(Boolean).join(" · ")}</Text>}
          </div>
          <div className="assignment-review"><span className="section-code">{draft.reviewGrouping === "post" ? "AGRUPADO POR PUBLICACIÓN" : "AGRUPADO POR DISPOSITIVO"}</span>{groupAssignments(draft, state.devices).map((group) => <div className="assignment-group" key={group.label}><strong>{group.label}</strong><small>{group.items.length} ejecuciones</small>{group.items.map((item) => <span key={item.id}><code>{formatDate(item.scheduledAt)}</code>{item.detail}</span>)}</div>)}{draft.assignments.length === 0 && <Text className="empty-inline">Prepara la campaña para crear las asignaciones.</Text>}</div>
        </div>
      </section>
    </>
  );
}
