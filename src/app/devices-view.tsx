import {
  Accordion,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Progress,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";

import type { ControlDispatch, ControlState, Device } from "./control-panel.types";
import { formatDate, statusLabels } from "./demo-state";

interface DevicesViewProps {
  state: ControlState;
  dispatch: ControlDispatch;
}

const activityLabels: Record<Device["activity"], string> = {
  available: "Disponible para Farm Appium",
  busy: "Ocupado por Farm Appium",
  recovery_required: "Recuperación requerida",
};

function statusColor(status: string) {
  if (["ready", "connected", "available"].includes(status)) return "lime";
  if (["offline", "not_ready", "session_required", "preparing"].includes(status)) return "yellow";
  return "red";
}

export function DevicesView({ state, dispatch }: DevicesViewProps) {
  const query = state.demoOperations.deviceSearch.trim().toLowerCase();
  const visible = state.devices
    .filter((device) => [device.order, device.alias, device.model, device.serial].join(" ").toLowerCase().includes(query))
    .sort((a, b) => a.order - b.order);
  const selected = state.demoOperations.selectedDeviceIds;
  const allVisibleSelected = visible.length > 0 && visible.every((device) => selected.includes(device.id));
  const connected = state.devices.filter((device) => device.connection === "connected").length;
  const facebookReady = state.devices.filter((device) => device.capabilities.facebook === "ready" && device.preparation === "ready").length;
  const tiktokReady = state.devices.filter((device) => device.capabilities.tiktok === "ready" && device.preparation === "ready").length;
  const busy = state.devices.filter((device) => device.activity === "busy").length;

  return (
    <div className="view-content">
      <header className="view-heading">
        <div>
          <span className="section-code">01 / INVENTARIO LOCAL</span>
          <Title order={1}>Dispositivos</Title>
          <Text>Allowlist explícita, preparación aislada y puertos exclusivos.</Text>
        </div>
        <div className="refresh-stamp">
          <span>ÚLTIMA ACTUALIZACIÓN</span>
          <strong>{formatDate(state.demoOperations.now, true)}</strong>
        </div>
      </header>

      <section className="metric-rail" aria-label="Resumen de dispositivos">
        <div><span>Total registrado</span><strong>{state.devices.length}</strong></div>
        <div><span>Conectados</span><strong>{connected}</strong></div>
        <div><span>Listos Facebook</span><strong>{facebookReady}</strong></div>
        <div><span>Listos TikTok</span><strong>{tiktokReady}</strong></div>
        <div><span>Ocupados</span><strong>{busy}</strong></div>
      </section>

      <Alert className="external-contract" color="gray" title="Límite de responsabilidad">
        GenFarmer es externo. Farm Appium no inicia, detiene ni administra su proceso.
      </Alert>

      <Accordion className="industrial-accordion" defaultValue="add-device" variant="contained">
        <Accordion.Item value="add-device">
          <Accordion.Control>
            <span className="accordion-title"><b>INCORPORACIÓN</b> Agregar seriales a la allowlist</span>
          </Accordion.Control>
          <Accordion.Panel>
            <div className="import-grid">
              <Textarea
                label="Seriales ADB"
                description="Un serial por línea. Deben estar conectados y autorizados para registrar su identidad física."
                placeholder={"R58M72K1A7X\nemulator-5554\n192.168.0.42:5555"}
                autosize
                minRows={4}
                maxRows={8}
                value={state.demoOperations.deviceImportText}
                onChange={(event) => dispatch({ type: "set-device-import", value: event.currentTarget.value })}
                error={state.demoOperations.deviceImportErrors.length ? "Hay líneas por corregir" : undefined}
                aria-describedby="device-import-errors"
              />
              <div className="import-aside">
                <Text size="sm">ADB verifica identidad, modelo y aplicaciones antes de persistir cada perfil. Las sesiones se validan durante la preparación.</Text>
                <Button onClick={() => dispatch({ type: "add-devices" })}>Agregar dispositivos</Button>
              </div>
            </div>
            {state.demoOperations.deviceImportErrors.length > 0 && (
              <ul className="form-errors" id="device-import-errors">
                {state.demoOperations.deviceImportErrors.map((error) => (
                  <li key={`${error.line}-${error.value}`}><strong>Línea {error.line}:</strong> {error.message} <code>{error.value}</code></li>
                ))}
              </ul>
            )}
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      <section className="work-section" aria-labelledby="device-table-title">
        <div className="section-toolbar">
          <div>
            <span className="section-code">ALLOWLIST / {visible.length} VISIBLES</span>
            <Title order={2} id="device-table-title">Banco de equipos</Title>
          </div>
          <Group align="flex-end" wrap="nowrap">
            <TextInput
              className="device-search"
              label="Buscar equipo"
              placeholder="Orden, alias, modelo o serial"
              value={state.demoOperations.deviceSearch}
              onChange={(event) => dispatch({ type: "set-device-search", value: event.currentTarget.value })}
            />
            <Button
              disabled={selected.length === 0}
              onClick={() => dispatch({ type: "start-device-preparation", deviceIds: selected })}
            >
              Preparar {selected.length || "N"} dispositivos
            </Button>
          </Group>
        </div>

        <div className="table-scroll">
          <table className="data-table device-table">
            <thead>
              <tr>
                <th>
                  <Checkbox
                    aria-label="Seleccionar equipos visibles"
                    checked={allVisibleSelected}
                    indeterminate={!allVisibleSelected && visible.some((device) => selected.includes(device.id))}
                    onChange={(event) => dispatch({ type: "select-visible-devices", deviceIds: visible.map((device) => device.id), selected: event.currentTarget.checked })}
                  />
                </th>
                <th>Orden</th>
                <th>Alias / modelo</th>
                <th>Serial ADB</th>
                <th>Conexión</th>
                <th>Appium</th>
                <th>Facebook</th>
                <th>TikTok</th>
                <th>Actividad</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((device) => (
                <tr key={device.id} data-problem={device.connection !== "connected" || device.preparation === "failed"}>
                  <td><Checkbox aria-label={`Seleccionar ${device.alias}`} checked={selected.includes(device.id)} onChange={() => dispatch({ type: "toggle-device-selection", deviceId: device.id })} /></td>
                  <td><strong className="order-cell">{String(device.order).padStart(2, "0")}</strong></td>
                  <td><strong>{device.alias}</strong><small>{device.model}</small>{device.retireAfterCampaign && <Badge color="orange" size="xs">Retirar al finalizar</Badge>}</td>
                  <td><code>{device.serial}</code><small>Puerto {device.systemPort}</small></td>
                  <td><Badge color={statusColor(device.connection)} variant="light">{statusLabels[device.connection]}</Badge></td>
                  <td>
                    <Badge color={statusColor(device.preparation)} variant="light">{statusLabels[device.preparation]}</Badge>
                    {device.preparation === "preparing" && <Progress value={preparationProgress(device.preparationStep)} size="xs" mt={6} animated />}
                    {device.preparationStep && <small>{device.preparationStep}</small>}
                  </td>
                  <td><Badge color={statusColor(device.capabilities.facebook)} variant="outline">{statusLabels[device.capabilities.facebook]}</Badge></td>
                  <td><Badge color={statusColor(device.capabilities.tiktok)} variant="outline">{statusLabels[device.capabilities.tiktok]}</Badge></td>
                  <td><Badge color={statusColor(device.activity)} variant="dot">{activityLabels[device.activity]}</Badge></td>
                  <td>
                    <Group gap={5} wrap="nowrap">
                      <Button size="compact-xs" variant="default" onClick={() => dispatch({ type: "open-device-editor", deviceId: device.id })}>Editar</Button>
                      <Button size="compact-xs" variant="light" onClick={() => dispatch({ type: "start-device-preparation", deviceIds: [device.id] })}>Preparar</Button>
                      <Button size="compact-xs" color="red" variant="subtle" onClick={() => dispatch({ type: "request-device-retirement", deviceId: device.id })}>Retirar</Button>
                    </Group>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && <tr><td colSpan={10} className="empty-cell">No hay equipos que coincidan con la búsqueda.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function preparationProgress(step?: string) {
  const steps = ["Validando ADB", "Comprobando Appium", "Leyendo jerarquía", "Volviendo a Inicio", "Listo"];
  return Math.max(8, ((steps.indexOf(step ?? "") + 1) / steps.length) * 100);
}
