import {
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Select,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";

import type { CampaignDraft, ControlDispatch, ControlState, Device, Platform, Tone } from "./control-panel.types";
import { campaignCanPrepare, toneOptions } from "./demo-state";
import { deviceReason, domainLabel, isDeviceEligible } from "./campaign-view.utils";

interface CampaignSetupProps {
  platform: Platform;
  label: string;
  allowedHosts: string;
  experimentalActions: ("tap_tap")[];
  draft: CampaignDraft;
  state: ControlState;
  dispatch: ControlDispatch;
}

export function CampaignSetup({ platform, label, allowedHosts, experimentalActions, draft, state, dispatch }: CampaignSetupProps) {
  const eligible = state.devices.filter((device) => isDeviceEligible(device, platform));
  const selectedDevices = draft.selectedDeviceIds.map((id) => state.devices.find((device) => device.id === id)).filter((device): device is Device => Boolean(device));
  const selectedInvalid = selectedDevices.some((device) => !isDeviceEligible(device, platform));
  const distributionTotal = draft.distribution.reduce((sum, row) => sum + row.count, 0);
  const assignmentCount = draft.selectedDeviceIds.length * draft.urls.length;

  return (
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
                    aria-label={`${checked ? "Deseleccionar" : "Seleccionar"} ${device.alias}`}
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
  );
}
