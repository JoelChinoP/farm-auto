import {
  Accordion,
  Alert,
  Badge,
  Button,
  Drawer,
  Group,
  Select,
  Text,
  TextInput,
  Title,
} from "@mantine/core";

import type { ControlDispatch, ControlState, HistoryCampaign } from "./control-panel.types";
import { formatDate, statusLabels } from "./demo-state";

interface HistoryViewProps {
  state: ControlState;
  dispatch: ControlDispatch;
}

function hasUnknown(campaign: HistoryCampaign) {
  return campaign.assignments.some((assignment) => assignment.status === "outcome_unknown");
}

function campaignColor(campaign: HistoryCampaign) {
  if (hasUnknown(campaign) || campaign.status === "cancelled_with_cleanup_errors") return "red";
  if (campaign.status === "completed") return "lime";
  if (campaign.status === "running") return "blue";
  if (campaign.status === "cancelled") return "gray";
  return "yellow";
}

export function HistoryView({ state, dispatch }: HistoryViewProps) {
  const filters = state.demoOperations.historyFilters;
  const campaigns = state.history.filter((campaign) => {
    if (filters.platform !== "all" && campaign.platform !== filters.platform) return false;
    if (filters.status === "outcome_unknown" && !hasUnknown(campaign)) return false;
    if (filters.status !== "all" && filters.status !== "outcome_unknown" && campaign.status !== filters.status) return false;
    if (filters.deviceId !== "all" && !campaign.deviceIds.includes(filters.deviceId)) return false;
    if (filters.date && campaign.startedAt.slice(0, 10) !== filters.date) return false;
    const haystack = [campaign.id, ...campaign.postUrls, ...campaign.assignments.flatMap((item) => [item.deviceAlias, item.deviceSerial])].join(" ").toLowerCase();
    return haystack.includes(filters.query.trim().toLowerCase());
  });
  const historyModal = state.activeModal?.type === "history-detail" ? state.activeModal : null;
  const detail = historyModal ? state.history.find((item) => item.id === historyModal.campaignId) : undefined;
  const completed = state.history.filter((item) => item.status === "completed").length;
  const running = state.history.filter((item) => item.status === "running").length;
  const issues = state.history.filter((item) => item.status === "completed_with_issues").length;
  const cancelled = state.history.filter((item) => item.status === "cancelled" || item.status === "cancelled_with_cleanup_errors").length;
  const unknown = state.history.filter(hasUnknown).length;

  return (
    <div className="view-content history-view">
      <header className="view-heading">
        <div>
          <span className="section-code">04 / TRAZABILIDAD LOCAL</span>
          <Title order={1}>Historial</Title>
          <Text>Resultados preservados, incidencias por asignación y cleanup verificable.</Text>
        </div>
        <div className="refresh-stamp"><span>REGISTROS DE DEMOSTRACIÓN</span><strong>{state.history.length} campañas</strong></div>
      </header>

      <section className="metric-rail history-metrics" aria-label="Resumen histórico">
        <div><span>Completadas</span><strong>{completed}</strong></div>
        <div><span>En ejecución</span><strong>{running}</strong></div>
        <div><span>Con incidencias</span><strong>{issues}</strong></div>
        <div><span>Canceladas</span><strong>{cancelled}</strong></div>
        <div className="danger-metric"><span>Resultados inciertos</span><strong>{unknown}</strong></div>
      </section>

      <section className="history-filters" aria-labelledby="history-filter-title">
        <div><span className="section-code">FILTROS</span><Title order={2} id="history-filter-title">Acotar registros</Title></div>
        <Select label="Plataforma" value={filters.platform} allowDeselect={false} data={[{ value: "all", label: "Todas" }, { value: "facebook", label: "Facebook" }, { value: "tiktok", label: "TikTok" }]} onChange={(value) => dispatch({ type: "set-history-filter", field: "platform", value: value ?? "all" })} />
        <Select label="Estado" value={filters.status} allowDeselect={false} data={[
          { value: "all", label: "Todos" },
          { value: "running", label: "En ejecución" },
          { value: "completed", label: "Completada" },
          { value: "completed_with_issues", label: "Con incidencias" },
          { value: "cancelled", label: "Cancelada" },
          { value: "cancelled_with_cleanup_errors", label: "Cleanup pendiente" },
          { value: "outcome_unknown", label: "Resultado incierto" },
        ]} onChange={(value) => dispatch({ type: "set-history-filter", field: "status", value: value ?? "all" })} />
        <Select label="Dispositivo" searchable value={filters.deviceId} allowDeselect={false} data={[{ value: "all", label: "Todos" }, ...state.devices.map((item) => ({ value: item.id, label: `${item.order} / ${item.alias}` }))]} onChange={(value) => dispatch({ type: "set-history-filter", field: "deviceId", value: value ?? "all" })} />
        <TextInput type="date" label="Fecha" value={filters.date} onChange={(event) => dispatch({ type: "set-history-filter", field: "date", value: event.currentTarget.value })} />
        <TextInput label="Texto libre" placeholder="URL, alias o serial" value={filters.query} onChange={(event) => dispatch({ type: "set-history-filter", field: "query", value: event.currentTarget.value })} />
      </section>

      <section className="work-section history-table-section" aria-labelledby="history-table-title">
        <div className="section-toolbar compact"><div><span className="section-code">RESULTADOS / {campaigns.length} VISIBLES</span><Title order={2} id="history-table-title">Campañas</Title></div></div>
        <div className="table-scroll">
          <table className="data-table history-table">
            <thead><tr><th>Campaña</th><th>Inicio</th><th>Alcance</th><th>Acciones</th><th>Progreso</th><th>Estado</th><th>Acción</th></tr></thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.id} data-unknown={hasUnknown(campaign)}>
                  <td><strong><span className={`platform-pip ${campaign.platform}`} />{campaign.id}</strong><small>{campaign.platform === "facebook" ? "Facebook" : "TikTok"}</small></td>
                  <td>{formatDate(campaign.startedAt)}</td>
                  <td><strong>{campaign.deviceIds.length} × {campaign.postUrls.length}</strong><small>{campaign.totalAssignments} ejecuciones</small></td>
                  <td>{[campaign.actions.like && "Like", campaign.actions.comment && "Comentario"].filter(Boolean).join(" + ")}</td>
                  <td><strong>{campaign.completedAssignments}/{campaign.totalAssignments}</strong><small>ejecuciones completadas</small></td>
                  <td><Badge color={campaignColor(campaign)} variant="light">{hasUnknown(campaign) ? "Resultado incierto" : statusLabels[campaign.status]}</Badge></td>
                  <td><Button size="compact-sm" variant="default" onClick={() => dispatch({ type: "open-history", campaignId: campaign.id })}>Abrir detalle</Button></td>
                </tr>
              ))}
              {campaigns.length === 0 && <tr><td className="empty-cell" colSpan={7}>No hay campañas que coincidan con los filtros.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <Drawer opened={Boolean(detail)} onClose={() => dispatch({ type: "close-modal" })} position="right" size="xl" title={detail ? `Detalle ${detail.id}` : "Detalle de campaña"}>
        {detail && (
          <div className="history-detail">
            <div className="detail-hero">
              <div><span>RESULTADO GENERAL</span><Title order={2}>{hasUnknown(detail) ? "Requiere reconciliación manual" : statusLabels[detail.status]}</Title></div>
              <Badge size="lg" color={campaignColor(detail)}>{detail.platform === "facebook" ? "Facebook" : "TikTok"}</Badge>
            </div>
            {hasUnknown(detail) && (
              <Alert color="red" title="Resultado público no verificable">
                No se ofrece reintento automático. Un futuro control permitirá revisar el estado manualmente sin repetir la acción.
              </Alert>
            )}
            {detail.cancellationReason && <Alert color="yellow" title="Motivo de cancelación">{detail.cancellationReason}</Alert>}
            <dl className="detail-list wide">
              <div><dt>Inicio</dt><dd>{formatDate(detail.startedAt, true)}</dd></div>
              <div><dt>Plataforma</dt><dd>{detail.platform}</dd></div>
              <div><dt>Alcance original</dt><dd>{detail.deviceIds.length} dispositivos × {detail.postUrls.length} publicaciones</dd></div>
              <div><dt>Acciones</dt><dd>{[detail.actions.like && "Like", detail.actions.comment && "Comentario"].filter(Boolean).join(" + ")}</dd></div>
            </dl>

            <Accordion multiple defaultValue={["assignments"]} variant="contained">
              <Accordion.Item value="posts">
                <Accordion.Control>Publicaciones y contextos</Accordion.Control>
                <Accordion.Panel>
                  {detail.postUrls.map((url, index) => {
                    const assignment = detail.assignments.find((item) => item.postUrl === url);
                    return <div className="history-post" key={url}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{url}</strong><p>{assignment?.context ?? "Sin contexto conservado"}</p></div></div>;
                  })}
                </Accordion.Panel>
              </Accordion.Item>
              <Accordion.Item value="assignments">
                <Accordion.Control>Resultados por asignación ({detail.assignments.length})</Accordion.Control>
                <Accordion.Panel>
                  <div className="table-scroll">
                    <table className="data-table detail-results">
                      <thead><tr><th>Dispositivo</th><th>Plan / real</th><th>Acciones</th><th>Intentos</th><th>Cleanup</th><th>Evidencia</th></tr></thead>
                      <tbody>
                        {detail.assignments.map((assignment) => (
                          <tr key={assignment.id} data-unknown={assignment.status === "outcome_unknown"}>
                            <td><strong>{assignment.deviceAlias}</strong><small>{assignment.deviceSerial}</small><small title={assignment.postUrl}>{assignment.postUrl}</small></td>
                            <td><span>Plan {formatDate(assignment.plannedAt)}</span><small>Real {formatDate(assignment.actualAt)}</small></td>
                            <td><Badge color={assignment.likeResult === "ok" ? "lime" : assignment.likeResult === "not_requested" ? "gray" : "red"}>Like: {resultLabel(assignment.likeResult)}</Badge><Badge color={assignment.commentResult === "ok" ? "lime" : assignment.commentResult === "not_requested" ? "gray" : "red"}>Comentario: {resultLabel(assignment.commentResult)}</Badge>{assignment.comment && <small>“{assignment.comment}”</small>}{assignment.error && <Text c="red" size="xs">{assignment.error}</Text>}</td>
                            <td>{assignment.attempts}</td>
                            <td><Badge color={assignment.cleanup === "home_confirmed" ? "lime" : assignment.cleanup === "session_closed" ? "blue" : "red"}>{assignment.cleanup.replaceAll("_", " ")}</Badge></td>
                            <td><div className="evidence-placeholder">Screenshot<br /><span>No disponible en demo</span></div><div className="evidence-placeholder">Page source<br /><span>No disponible en demo</span></div></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
            <Group justify="space-between" mt="lg">
              <Text size="xs" c="dimmed">Datos ficticios · sin persistencia</Text>
              <Button variant="default" onClick={() => dispatch({ type: "close-modal" })}>Cerrar detalle</Button>
            </Group>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function resultLabel(result: "ok" | "failed" | "not_requested" | "outcome_unknown") {
  return { ok: "OK", failed: "falló", not_requested: "no solicitada", outcome_unknown: "incierto" }[result];
}
