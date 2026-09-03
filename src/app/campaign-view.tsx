import {
  Accordion,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Radio,
  SegmentedControl,
  Select,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";

import type {
  CampaignDraft,
  CampaignPost,
  ControlDispatch,
  ControlState,
  Device,
  Platform,
  Tone,
} from "./control-panel.types";
import { campaignCanPrepare, formatDate, isDeviceEligible, statusLabels, toneOptions } from "./demo-state";

interface CampaignViewProps {
  platform: Platform;
  label: string;
  accent: "facebook" | "tiktok";
  allowedHosts: string;
  requiredCapability: string;
  experimentalActions: ("tap_tap")[];
  state: ControlState;
  dispatch: ControlDispatch;
}

const contextLabels: Record<CampaignPost["contextSource"] & string, string> = {
  extracted: "Extraído",
  cache: "Caché",
  manual: "Edición manual",
};

function deviceReason(device: Device, platform: Platform) {
  if (device.connection === "offline") return "Equipo desconectado";
  if (device.connection === "unauthorized") return "ADB no autorizado";
  if (device.preparation !== "ready") return `Appium: ${statusLabels[device.preparation].toLowerCase()}`;
  if (device.capabilities[platform] !== "ready") return statusLabels[device.capabilities[platform]];
  return "Elegible";
}

function domainLabel(url: string) {
  try {
    const parsed = new URL(url);
    const suffix = parsed.pathname.split("/").filter(Boolean).slice(-2).join("/");
    return `${parsed.hostname.replace("www.", "")} / ${suffix || "publicación"}`;
  } catch {
    return url;
  }
}

function draftFor(state: ControlState, platform: Platform) {
  return platform === "facebook" ? state.facebookDraft : state.tiktokDraft;
}

export function CampaignView({
  platform,
  label,
  accent,
  allowedHosts,
  requiredCapability,
  experimentalActions,
  state,
  dispatch,
}: CampaignViewProps) {
  const draft = draftFor(state, platform);
  const eligible = state.devices.filter((device) => isDeviceEligible(device, platform));
  const selectedDevices = draft.selectedDeviceIds.map((id) => state.devices.find((device) => device.id === id)).filter(Boolean) as Device[];
  const distributionTotal = draft.distribution.reduce((sum, row) => sum + row.count, 0);
  const selectedPost = draft.posts.find((post) => post.id === draft.selectedPostId) ?? draft.posts[0];
  const assignmentCount = draft.selectedDeviceIds.length * draft.urls.length;
  const selectedInvalid = selectedDevices.some((device) => !isDeviceEligible(device, platform));
  const staleComments = draft.posts.flatMap((post) => post.comments).filter((comment) => comment.stale).length;
  const invalidComments = draft.posts.flatMap((post) => post.comments).filter((comment) => comment.text.trim().length < 2 || comment.text.length > 500 || ["failed", "generating", "regenerating", "pending"].includes(comment.status)).length;
  const failedPosts = draft.posts.filter((post) => ["failed", "session_required", "intervention_required"].includes(post.contextStatus)).length;
  const validStart = draft.scheduleStart === "now" || Boolean(draft.scheduleDateTime && !Number.isNaN(new Date(draft.scheduleDateTime).getTime()));
  const canSchedule = draft.posts.length > 0 && failedPosts === 0 && staleComments === 0 && (!draft.actions.comment || invalidComments === 0) && validStart;
  const canStart = canSchedule && draft.scheduleStatus === "valid" && !selectedInvalid && draft.status !== "running";
  const firstSchedule = draft.assignments.map((item) => item.scheduledAt).filter(Boolean).sort()[0] ?? null;
  const lastSchedule = draft.assignments.map((item) => item.scheduledAt).filter(Boolean).sort().at(-1) ?? null;

  return (
    <div className="view-content campaign-view" data-accent={accent}>
      <header className="view-heading campaign-heading">
        <div>
          <span className="section-code">{platform === "facebook" ? "02" : "03"} / CONSTRUCTOR COMPARTIDO</span>
          <Title order={1}>{label}</Title>
          <Text>Todos los equipos seleccionados procesan todas las publicaciones.</Text>
        </div>
        <div className="campaign-state">
          <span>ESTADO DE CAMPAÑA</span>
          <Badge size="lg" variant="light">{statusLabels[draft.status]}</Badge>
          <small>{requiredCapability}</small>
        </div>
      </header>

      <Alert className="prototype-ribbon" color={platform === "facebook" ? "blue" : "cyan"}>
        MODO PROTOTIPO · no se ejecutarán acciones reales ni solicitudes HTTP.
      </Alert>

      <section className="campaign-config" aria-labelledby={`${platform}-configuration-title`}>
        <div className="section-toolbar compact">
          <div>
            <span className="section-code">CONFIGURACIÓN / PASO 01</span>
            <Title order={2} id={`${platform}-configuration-title`}>Preparar alcance</Title>
          </div>
          <Button variant="default" disabled={draft.status === "running"} onClick={() => dispatch({ type: "clear-campaign", platform })}>Limpiar formulario</Button>
        </div>

        <div className="config-grid">
          <article className="config-card device-picker">
            <div className="card-index"><span>A</span><div><strong>Dispositivos</strong><small>{draft.selectedDeviceIds.length} seleccionados</small></div></div>
            <Group gap="xs">
              <Button size="compact-sm" variant="light" onClick={() => dispatch({ type: "set-campaign-devices", platform, deviceIds: eligible.map((item) => item.id) })}>Seleccionar elegibles</Button>
              <Button size="compact-sm" variant="subtle" onClick={() => dispatch({ type: "set-campaign-devices", platform, deviceIds: [] })}>Limpiar selección</Button>
            </Group>
            <div className="device-choice-list">
              {state.devices.map((device) => {
                const canUse = isDeviceEligible(device, platform);
                const checked = draft.selectedDeviceIds.includes(device.id);
                return (
                  <label className="device-choice" data-invalid={checked && !canUse} key={device.id}>
                    <Checkbox
                      checked={checked}
                      disabled={!canUse && !checked}
                      onChange={(event) => dispatch({
                        type: "set-campaign-devices",
                        platform,
                        deviceIds: event.currentTarget.checked
                          ? [...draft.selectedDeviceIds, device.id]
                          : draft.selectedDeviceIds.filter((id) => id !== device.id),
                      })}
                      aria-label={`${eventLabel(checked)} ${device.alias}`}
                    />
                    <span><strong>{String(device.order).padStart(2, "0")} / {device.alias}</strong><small>{device.serial} · {deviceReason(device, platform)}</small></span>
                    <Badge size="xs" color={canUse ? "lime" : "gray"}>{canUse ? "Listo" : "No elegible"}</Badge>
                  </label>
                );
              })}
            </div>
            {selectedInvalid && <Text className="inline-error" role="alert">La selección conserva un equipo que perdió elegibilidad. Retíralo antes de iniciar.</Text>}
          </article>

          <article className="config-card url-builder">
            <div className="card-index"><span>B</span><div><strong>Publicaciones</strong><small>1–10 URLs · {allowedHosts}</small></div></div>
            <Textarea
              label={`URLs de ${label}`}
              description="Una URL HTTPS por línea"
              minRows={5}
              maxRows={10}
              autosize
              value={draft.urlInput}
              onChange={(event) => dispatch({ type: "set-campaign-urls", platform, value: event.currentTarget.value })}
              error={draft.urlErrors.length ? `${draft.urlErrors.length} líneas requieren revisión` : undefined}
              aria-describedby={`${platform}-url-errors`}
            />
            {draft.urlErrors.length > 0 && (
              <ul className="form-errors" id={`${platform}-url-errors`}>
                {draft.urlErrors.map((error) => <li key={`${error.line}-${error.value}`}><strong>Línea {error.line}:</strong> {error.message}</li>)}
              </ul>
            )}
            <div className="validated-urls" aria-label="Publicaciones validadas">
              {draft.urls.map((url, index) => (
                <div key={url} className="url-row">
                  <span className="row-number">{String(index + 1).padStart(2, "0")}</span>
                  <span><strong>{domainLabel(url)}</strong>{index === 0 && <Badge size="xs">Prioridad</Badge>}<small title={url}>{url}</small></span>
                  <Group gap={2} wrap="nowrap">
                    <Button aria-label={`Subir publicación ${index + 1}`} size="compact-xs" variant="subtle" disabled={index === 0} onClick={() => dispatch({ type: "move-campaign-url", platform, index, direction: -1 })}>↑</Button>
                    <Button aria-label={`Bajar publicación ${index + 1}`} size="compact-xs" variant="subtle" disabled={index === draft.urls.length - 1} onClick={() => dispatch({ type: "move-campaign-url", platform, index, direction: 1 })}>↓</Button>
                    <Button aria-label={`Retirar publicación ${index + 1}`} size="compact-xs" color="red" variant="subtle" onClick={() => dispatch({ type: "remove-campaign-url", platform, index })}>Retirar</Button>
                  </Group>
                </div>
              ))}
              {draft.urls.length === 0 && <Text className="empty-inline">Aún no hay publicaciones válidas.</Text>}
            </div>
          </article>

          <article className="config-card actions-card">
            <div className="card-index"><span>C</span><div><strong>Acciones</strong><small>Selecciones independientes</small></div></div>
            <label className="action-choice">
              <Checkbox checked={draft.actions.like} onChange={() => dispatch({ type: "toggle-campaign-action", platform, action: "like" })} />
              <span><strong>Like</strong><small>Disponible para la simulación</small></span>
              <Badge color="lime">Disponible</Badge>
            </label>
            <label className="action-choice">
              <Checkbox checked={draft.actions.comment} onChange={() => dispatch({ type: "toggle-campaign-action", platform, action: "comment" })} />
              <span><strong>Comentar</strong><small>Contexto y generación por publicación</small></span>
              <Badge color="lime">Disponible</Badge>
            </label>
            <label className="action-choice disabled">
              <Checkbox disabled />
              <span><strong>Compartir</strong><small>Contrato pendiente</small></span>
              <Badge color="gray">En definición</Badge>
            </label>
            {experimentalActions.includes("tap_tap") && (
              <label className="action-choice disabled">
                <Checkbox disabled />
                <span><strong>Tap tap Live</strong><small>Acción experimental</small></span>
                <Badge color="pink">En revisión</Badge>
              </label>
            )}
            {!draft.actions.like && !draft.actions.comment && <Text className="inline-error" role="alert">Selecciona al menos una acción disponible.</Text>}
          </article>

          <article className="config-card distribution-card" data-hidden={!draft.actions.comment}>
            <div className="card-index"><span>D</span><div><strong>Distribución predeterminada</strong><small>{draft.actions.comment ? `${distributionTotal} de ${draft.selectedDeviceIds.length} dispositivos` : "No aplica"}</small></div></div>
            {!draft.actions.comment ? (
              <div className="comment-disabled"><strong>Comentarios desactivados</strong><p>No se extraerá contexto ni se crearán comentarios. Podrás planificar likes directamente.</p></div>
            ) : (
              <>
                <div className="distribution-head"><span>Intención</span><span>Tono</span><span>Cantidad</span><span /></div>
                {draft.distribution.map((row) => (
                  <div className="distribution-row" key={row.id}>
                    <TextInput aria-label="Intención" value={row.intention} onChange={(event) => dispatch({ type: "update-distribution", platform, id: row.id, field: "intention", value: event.currentTarget.value })} />
                    <Select aria-label="Tono" value={row.tone} data={toneOptions} allowDeselect={false} onChange={(value) => dispatch({ type: "update-distribution", platform, id: row.id, field: "tone", value: value as Tone })} />
                    <NumberInput aria-label="Cantidad" min={0} value={row.count} onChange={(value) => dispatch({ type: "update-distribution", platform, id: row.id, field: "count", value: Number(value) || 0 })} />
                    <Button aria-label="Eliminar intención" color="red" variant="subtle" disabled={draft.distribution.length === 1} onClick={() => dispatch({ type: "remove-distribution", platform, id: row.id })}>×</Button>
                  </div>
                ))}
                <Group justify="space-between">
                  <Button size="compact-sm" variant="light" onClick={() => dispatch({ type: "add-distribution", platform })}>Agregar intención</Button>
                  <Button size="compact-sm" variant="default" onClick={() => dispatch({ type: "update-distribution", platform, id: draft.distribution[0].id, field: "count", value: draft.selectedDeviceIds.length })}>Aplicar como predeterminado</Button>
                </Group>
                {distributionTotal !== draft.selectedDeviceIds.length && <Text className="inline-error" role="alert">La suma debe coincidir con los {draft.selectedDeviceIds.length} dispositivos seleccionados.</Text>}
              </>
            )}
          </article>
        </div>

        <div className="impact-bar">
          <div><span>IMPACTO</span><strong>{draft.selectedDeviceIds.length} dispositivos × {draft.urls.length} publicaciones = {assignmentCount} ejecuciones</strong></div>
          <div><span>COMENTARIOS PREVISTOS</span><strong>{draft.actions.comment ? assignmentCount : 0}</strong></div>
          <div><span>ACCIONES POR EJECUCIÓN</span><strong>{[draft.actions.like && "Like", draft.actions.comment && "Comentario"].filter(Boolean).join(" + ") || "Ninguna"}</strong></div>
          <Button size="lg" disabled={!campaignCanPrepare(state, platform) || draft.status === "running"} onClick={() => dispatch({ type: "prepare-campaign", platform })}>Preparar campaña</Button>
        </div>
      </section>

      {draft.posts.length > 0 && (
        <>
          <section className="pipeline-section" aria-labelledby={`${platform}-pipeline-title`}>
            <div className="section-toolbar compact">
              <div>
                <span className="section-code">PIPELINE / PASO 02</span>
                <Title order={2} id={`${platform}-pipeline-title`}>Contexto y comentarios</Title>
              </div>
              <Group gap="xs">
                <Badge color="gray">{draft.posts.filter((post) => post.status === "queued").length} en cola</Badge>
                <Badge color="blue">{draft.posts.filter((post) => ["extracting", "generating"].includes(post.status)).length} activos</Badge>
                <Badge color="lime">{draft.posts.filter((post) => ["ready", "scheduled", "completed"].includes(post.status)).length} listos</Badge>
                <Badge color="red">{failedPosts} con error</Badge>
              </Group>
            </div>

            <div className="post-workspace">
              <div className="post-list" role="list" aria-label="Publicaciones de la campaña">
                {draft.posts.map((post) => {
                  const ready = post.comments.filter((comment) => ["ready", "edited"].includes(comment.status) && !comment.stale).length;
                  const scheduled = draft.assignments.find((item) => item.postId === post.id)?.scheduledAt;
                  return (
                    <button
                      role="listitem"
                      className="post-list-item"
                      aria-current={selectedPost?.id === post.id ? "true" : undefined}
                      key={post.id}
                      onClick={() => dispatch({ type: "select-post", platform, postId: post.id })}
                    >
                      <span className="post-position">{String(post.position).padStart(2, "0")}</span>
                      <span className="post-copy">
                        <strong>{domainLabel(post.url)}</strong>
                        <small>{statusLabels[post.contextStatus]} · {draft.actions.comment ? `${ready}/${post.comments.length} comentarios listos` : "Sin comentarios"}</small>
                        {scheduled && <time>{formatDate(scheduled)}</time>}
                      </span>
                      <span className="post-flags">
                        {post.position === 1 && <Badge size="xs">Prioridad</Badge>}
                        {post.error && <Badge color="red" size="xs">Error</Badge>}
                      </span>
                    </button>
                  );
                })}
              </div>

              {selectedPost && (
                <article className="post-detail">
                  <header className="post-detail-head">
                    <div><span>PUBLICACIÓN {String(selectedPost.position).padStart(2, "0")}</span><Title order={3} title={selectedPost.url}>{domainLabel(selectedPost.url)}</Title><span className="post-url" title={selectedPost.url}>{selectedPost.url}</span></div>
                    <div><Badge size="lg">{statusLabels[selectedPost.status]}</Badge><small>{selectedPost.elapsedSeconds}s simulados</small></div>
                  </header>

                  <Accordion className="detail-accordion" multiple defaultValue={["context", "comments"]}>
                    <Accordion.Item value="context">
                      <Accordion.Control>Contexto de publicación</Accordion.Control>
                      <Accordion.Panel>
                        <div className="context-meta">
                          <Badge color={selectedPost.contextStatus === "failed" ? "red" : "gray"}>{statusLabels[selectedPost.contextStatus]}</Badge>
                          <span>Fuente: {selectedPost.contextSource ? contextLabels[selectedPost.contextSource] : "Pendiente"}</span>
                          <span>Extracción: {formatDate(selectedPost.extractedAt)}</span>
                        </div>
                        {selectedPost.error && <Alert color="red" title="Extracción aislada">{selectedPost.error}</Alert>}
                        <Textarea
                          label="Contexto editable"
                          description="Editar después de generar marca los comentarios como desactualizados."
                          minRows={4}
                          maxRows={8}
                          autosize
                          value={selectedPost.context}
                          placeholder={selectedPost.contextStatus === "extracting" ? "Extrayendo contexto…" : "Escribe contexto manual para continuar"}
                          onChange={(event) => dispatch({ type: "edit-context", platform, postId: selectedPost.id, value: event.currentTarget.value })}
                        />
                        <Group mt="sm">
                          <Button size="compact-sm" disabled={selectedPost.context.trim().length < 2} onClick={() => dispatch({ type: "edit-context", platform, postId: selectedPost.id, value: selectedPost.context })}>Guardar edición</Button>
                          <Button size="compact-sm" variant="default" disabled={!selectedPost.extractedContext} onClick={() => dispatch({ type: "restore-context", platform, postId: selectedPost.id })}>Restaurar extraído</Button>
                          <Button size="compact-sm" variant="light" onClick={() => dispatch({ type: "retry-context", platform, postId: selectedPost.id })}>Reintentar extracción</Button>
                        </Group>
                      </Accordion.Panel>
                    </Accordion.Item>

                    {draft.actions.comment && (
                      <Accordion.Item value="comments">
                        <Accordion.Control>
                          Comentarios · {selectedPost.comments.filter((item) => ["ready", "edited"].includes(item.status) && !item.stale).length}/{selectedPost.comments.length} listos
                        </Accordion.Control>
                        <Accordion.Panel>
                          {selectedPost.comments.some((comment) => comment.stale) && <Alert color="yellow" title="Comentarios desactualizados">El contexto cambió. Regenera los comentarios marcados antes de planificar.</Alert>}
                          <div className="table-scroll comments-scroll">
                            <table className="data-table comments-table">
                              <thead><tr><th>Dispositivo</th><th>Intención / tono</th><th>Comentario</th><th>Longitud</th><th>Estado</th><th>Acción</th></tr></thead>
                              <tbody>
                                {selectedPost.comments.map((comment) => {
                                  const device = state.devices.find((item) => item.id === comment.deviceId);
                                  const invalid = comment.text.length > 0 && (comment.text.trim().length < 2 || comment.text.length > 500);
                                  return (
                                    <tr key={comment.id} data-stale={comment.stale}>
                                      <td><strong>{String(device?.order ?? 0).padStart(2, "0")} / {device?.alias ?? "Retirado"}</strong><small>{shortSerial(device?.serial)}</small></td>
                                      <td>
                                        <TextInput aria-label={`Intención para ${device?.alias ?? comment.deviceId}`} value={comment.intention} onChange={(event) => dispatch({ type: "update-comment-profile", platform, postId: selectedPost.id, commentId: comment.id, field: "intention", value: event.currentTarget.value })} />
                                        <Select mt={5} aria-label={`Tono para ${device?.alias ?? comment.deviceId}`} value={comment.tone} data={toneOptions} allowDeselect={false} onChange={(value) => dispatch({ type: "update-comment-profile", platform, postId: selectedPost.id, commentId: comment.id, field: "tone", value: (value ?? "Cercano") as Tone })} />
                                      </td>
                                      <td>
                                        <Textarea
                                          aria-label={`Comentario para ${device?.alias ?? comment.deviceId}`}
                                          minRows={2}
                                          maxRows={5}
                                          autosize
                                          value={comment.text}
                                          error={invalid ? "Usa entre 2 y 500 caracteres" : undefined}
                                          onChange={(event) => dispatch({ type: "edit-comment", platform, postId: selectedPost.id, commentId: comment.id, value: event.currentTarget.value })}
                                        />
                                      </td>
                                      <td><code className={comment.text.length > 500 ? "counter-error" : ""}>{comment.text.length}/500</code></td>
                                      <td><Badge color={comment.stale || comment.status === "failed" ? "red" : ["generating", "regenerating", "pending"].includes(comment.status) ? "blue" : "lime"}>{comment.stale ? "Desactualizado" : statusLabels[comment.status]}</Badge>{comment.error && <small>{comment.error}</small>}</td>
                                      <td><Button size="compact-xs" variant="light" onClick={() => dispatch({ type: "start-comment-regeneration", platform, postId: selectedPost.id, commentIds: [comment.id] })}>Regenerar</Button></td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                          <Group justify="flex-end" mt="sm">
                            <Button variant="default" onClick={() => dispatch({ type: "request-regenerate-post", platform, postId: selectedPost.id })}>Regenerar todos los comentarios de esta publicación</Button>
                          </Group>
                        </Accordion.Panel>
                      </Accordion.Item>
                    )}
                  </Accordion>
                </article>
              )}
            </div>
          </section>

          <section className="planning-section" aria-labelledby={`${platform}-planning-title`}>
            <div className="section-toolbar compact">
              <div><span className="section-code">PLANIFICACIÓN / PASO 03</span><Title order={2} id={`${platform}-planning-title`}>Generar horarios</Title></div>
              {draft.scheduleStatus === "stale" && <Badge color="red" size="lg">Planificación desactualizada</Badge>}
              {draft.scheduleStatus === "frozen" && <Badge color="blue" size="lg">Horario congelado</Badge>}
            </div>
            <div className="planning-grid">
              <div className="schedule-controls">
                <Radio.Group label="Inicio" value={draft.scheduleStart} onChange={(value) => dispatch({ type: "set-schedule", platform, field: "scheduleStart", value })}>
                  <Group mt="xs"><Radio value="now" label="Ahora" /><Radio value="custom" label="Fecha y hora local" /></Group>
                </Radio.Group>
                <TextInput
                  type="datetime-local"
                  label="Fecha y hora"
                  disabled={draft.scheduleStart !== "custom"}
                  value={draft.scheduleDateTime}
                  onChange={(event) => dispatch({ type: "set-schedule", platform, field: "scheduleDateTime", value: event.currentTarget.value })}
                />
                <NumberInput label="Máximo de espera (minutos)" min={0} max={1440} value={draft.maxWaitMinutes} onChange={(value) => dispatch({ type: "set-schedule", platform, field: "maxWaitMinutes", value: Number(value) || 0 })} />
                <Button disabled={!canSchedule || draft.scheduleStatus === "frozen"} onClick={() => dispatch({ type: "generate-schedule", platform })}>{draft.scheduleStatus === "valid" || draft.scheduleStatus === "stale" ? "Regenerar horarios" : "Generar horarios"}</Button>
                {!validStart && <Text className="inline-error">Indica una fecha y hora local válida.</Text>}
                {!canSchedule && <Text className="inline-error">Resuelve contexto y comentarios pendientes antes de planificar.</Text>}
              </div>
              <div className="schedule-explainer">
                <span>REGLA OPERATIVA</span>
                <Title order={3}>Paralelo entre equipos.<br />Secuencial por equipo.</Title>
                <Text>Dos dispositivos pueden coincidir. Un mismo equipo recibe cada publicación en un turno posterior.</Text>
                <dl><div><dt>Primera ejecución</dt><dd>{formatDate(firstSchedule)}</dd></div><div><dt>Última ejecución</dt><dd>{formatDate(lastSchedule)}</dd></div></dl>
              </div>
            </div>
          </section>

          <section className="review-section" aria-labelledby={`${platform}-review-title`}>
            <div className="section-toolbar compact">
              <div><span className="section-code">REVISIÓN / PASO 04</span><Title order={2} id={`${platform}-review-title`}>Confirmar campaña</Title></div>
              <SegmentedControl value={draft.reviewGrouping} onChange={(value) => dispatch({ type: "set-review-group", platform, value: value as "post" | "device" })} data={[{ label: "Por publicación", value: "post" }, { label: "Por dispositivo", value: "device" }]} />
            </div>
            <div className="review-grid">
              <div className="review-summary">
                <dl>
                  <div><dt>Plataforma</dt><dd>{label}</dd></div>
                  <div><dt>Dispositivos</dt><dd>{draft.selectedDeviceIds.length}</dd></div>
                  <div><dt>Publicaciones</dt><dd>{draft.posts.length}</dd></div>
                  <div><dt>Ejecuciones</dt><dd>{draft.assignments.length}</dd></div>
                  <div><dt>Acciones</dt><dd>{[draft.actions.like && "Like", draft.actions.comment && "Comentario"].filter(Boolean).join(" + ")}</dd></div>
                  <div><dt>Comentarios</dt><dd>{draft.posts.flatMap((post) => post.comments).length}</dd></div>
                  <div><dt>Ventana</dt><dd>{firstSchedule ? `${formatDate(firstSchedule)} → ${formatDate(lastSchedule)}` : "Sin generar"}</dd></div>
                </dl>
                <Alert color="red" title="Efectos públicos futuros">La implementación real requerirá confirmación explícita. Este modo no publica nada.</Alert>
                <Button size="lg" fullWidth disabled={!canStart} onClick={() => dispatch({ type: "request-start-campaign", platform })}>Iniciar campaña</Button>
                {!canStart && <Text className="review-blockers">Pendientes: {[
                  selectedInvalid && "dispositivo inválido",
                  failedPosts > 0 && `${failedPosts} contextos`,
                  staleComments > 0 && `${staleComments} comentarios desactualizados`,
                  invalidComments > 0 && `${invalidComments} comentarios incompletos`,
                  draft.scheduleStatus !== "valid" && "horario válido",
                ].filter(Boolean).join(" · ")}</Text>}
              </div>
              <div className="assignment-review">
                <span className="section-code">{draft.reviewGrouping === "post" ? "AGRUPADO POR PUBLICACIÓN" : "AGRUPADO POR DISPOSITIVO"}</span>
                {groupAssignments(draft, state.devices).map((group) => (
                  <div className="assignment-group" key={group.label}>
                    <strong>{group.label}</strong>
                    <small>{group.items.length} ejecuciones</small>
                    {group.items.map((item) => <span key={item.id}><code>{formatDate(item.scheduledAt)}</code>{item.detail}</span>)}
                  </div>
                ))}
                {draft.assignments.length === 0 && <Text className="empty-inline">Prepara la campaña para crear las asignaciones.</Text>}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function eventLabel(checked: boolean) {
  return checked ? "Deseleccionar" : "Seleccionar";
}

function shortSerial(serial?: string) {
  if (!serial) return "Sin serial";
  return serial.length > 12 ? `${serial.slice(0, 5)}…${serial.slice(-5)}` : serial;
}

function groupAssignments(draft: CampaignDraft, devices: Device[]) {
  if (draft.reviewGrouping === "post") {
    return draft.posts.map((post) => ({
      label: `${String(post.position).padStart(2, "0")} / ${domainLabel(post.url)}`,
      items: draft.assignments.filter((item) => item.postId === post.id).map((item) => ({
        ...item,
        detail: devices.find((device) => device.id === item.deviceId)?.alias ?? "Dispositivo retirado",
      })),
    }));
  }
  return draft.selectedDeviceIds.map((deviceId) => ({
    label: devices.find((device) => device.id === deviceId)?.alias ?? "Dispositivo retirado",
    items: draft.assignments.filter((item) => item.deviceId === deviceId).map((item) => ({
      ...item,
      detail: domainLabel(draft.posts.find((post) => post.id === item.postId)?.url ?? ""),
    })),
  }));
}
