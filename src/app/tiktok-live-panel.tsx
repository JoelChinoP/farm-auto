import { Alert, Badge, Button, Checkbox, Group, NumberInput, Stack, Text, TextInput, Textarea, Title } from "@mantine/core";
import { useState } from "react";

import type { Device } from "./control-panel.types";
import { isDeviceEligible } from "./campaign-view.utils";

export type TikTokConfiguration = {
  controlledAccount: string | null;
  postEffectsEnabled: boolean;
  liveEffectsEnabled: boolean;
  postSelectorsConfigured: boolean;
  commentSelectorsConfigured: boolean;
  liveSelectorsConfigured: boolean;
  liveCalibration: null | { deviceId: string; x: number; y: number };
  liveCalibrations: Array<{ deviceId: string; x: number; y: number; calibratedAt: number | null }>;
};

export type TikTokLiveInput = {
  deviceIds: string[];
  urls: string[];
  rounds: number;
  expectedAccount: string;
  targetTexts: string[];
  idempotencyKey: string;
  confirmed: true;
  controlledAccount: true;
  controlledContent: true;
  tapTapConfirmed: true;
};

function validLiveUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && (url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com"))
      && /^\/@[^/]+\/live\/?$/u.test(url.pathname);
  } catch {
    return false;
  }
}

export function TikTokLivePanel({
  devices,
  configuration,
  onRun,
  onCalibrate,
}: {
  devices: Device[];
  configuration: TikTokConfiguration;
  onRun: (input: TikTokLiveInput) => Promise<void>;
  onCalibrate: (deviceId: string, x: number, y: number) => Promise<void>;
}) {
  const eligible = devices.filter((device) => isDeviceEligible(device, "tiktok"));
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [rounds, setRounds] = useState(10);
  const [points, setPoints] = useState<Record<string, { x: number; y: number }>>({});
  const [targetTexts, setTargetTexts] = useState<Record<string, string>>({});
  const [controlled, setControlled] = useState(false);
  const [calibrated, setCalibrated] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savingCalibration, setSavingCalibration] = useState<string | null>(null);
  const invalidateConfirmation = () => {
    setControlled(false);
    setCalibrated(false);
  };
  const urls = urlInput.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 10);
  const invalidUrls = urls.filter((url) => !validLiveUrl(url));
  const savedCalibration = (deviceId: string) => configuration.liveCalibrations.find((item) => item.deviceId === deviceId);
  const calibrationSaved = (deviceId: string) => {
    const saved = savedCalibration(deviceId);
    const point = points[deviceId];
    return Boolean(saved && point && saved.x === point.x && saved.y === point.y);
  };
  const enabled = configuration.liveEffectsEnabled
    && configuration.liveSelectorsConfigured
    && Boolean(configuration.controlledAccount)
    && selectedDeviceIds.length >= 1
    && urls.length >= 1
    && invalidUrls.length === 0
    && Number.isInteger(rounds) && rounds >= 1 && rounds <= 50
    && selectedDeviceIds.every((deviceId) => calibrationSaved(deviceId))
    && urls.every((url) => (targetTexts[url]?.trim().length ?? 0) >= 5)
    && controlled
    && calibrated;

  const setPoint = (deviceId: string, field: "x" | "y", value: number) => {
    setPoints((current) => ({
      ...current,
      [deviceId]: { ...(current[deviceId] ?? { x: 540, y: 960 }), [field]: value },
    }));
    invalidateConfirmation();
  };

  return (
    <section className="work-section tiktok-live" aria-labelledby="tiktok-live-title">
      <div className="section-toolbar compact">
        <div><span className="section-code">TIKTOK LIVE / TAP TAP N×M</span><Title order={2} id="tiktok-live-title">Tap tap calibrado</Title></div>
        <Badge color={configuration.liveEffectsEnabled ? "pink" : "gray"} size="lg">{configuration.liveEffectsEnabled ? "Gate habilitado" : "Deshabilitado"}</Badge>
      </div>
      <Alert color="yellow" title="Requiere prueba física independiente">
        Una ronda emite exactamente un comando de doble toque por dispositivo. Si su resultado queda incierto, se bloquea sin reintento automático.
      </Alert>
      <div className="tiktok-live-grid">
        <Stack gap="sm">
          <div className="device-choice-list">
            {eligible.map((device) => {
              const checked = selectedDeviceIds.includes(device.id);
              return (
                <label className="device-choice" key={device.id}>
                  <Checkbox
                    checked={checked}
                    onChange={(event) => {
                      setSelectedDeviceIds((current) => event.currentTarget.checked
                        ? [...current, device.id]
                        : current.filter((id) => id !== device.id));
                      invalidateConfirmation();
                    }}
                    aria-label={`${checked ? "Deseleccionar" : "Seleccionar"} ${device.alias}`}
                  />
                  <span><strong>{String(device.order).padStart(2, "0")} / {device.alias}</strong><small>{device.serial}</small></span>
                  <Badge size="xs" color={calibrationSaved(device.id) ? "lime" : "yellow"}>{calibrationSaved(device.id) ? "Calibrado" : "Sin calibrar"}</Badge>
                </label>
              );
            })}
            {eligible.length === 0 && <Text className="empty-inline">No hay dispositivos elegibles para TikTok Live.</Text>}
          </div>
          <Textarea
            label="URLs Live (1–10)"
            description="Una URL por línea con formato https://www.tiktok.com/@usuario/live"
            minRows={3}
            maxRows={6}
            autosize
            value={urlInput}
            onChange={(event) => { setUrlInput(event.currentTarget.value); invalidateConfirmation(); }}
            error={invalidUrls.length ? `${invalidUrls.length} línea(s) no son un Live válido de tiktok.com.` : undefined}
          />
          {urls.map((url, index) => (
            <TextInput key={url} label={`Texto visible del Live ${index + 1}`} maxLength={500} value={targetTexts[url] ?? ""} onChange={(event) => { setTargetTexts((current) => ({ ...current, [url]: event.currentTarget.value })); invalidateConfirmation(); }} />
          ))}
        </Stack>
        <Stack gap="sm">
          {selectedDeviceIds.map((deviceId) => {
            const device = devices.find((item) => item.id === deviceId);
            const saved = savedCalibration(deviceId);
            const point = points[deviceId];
            return (
              <Stack gap="xs" key={deviceId}>
                <Text size="sm" fw={700}>{device?.alias ?? deviceId}</Text>
                <Group grow align="start">
                  <NumberInput label="X" min={0} max={5000} value={point?.x ?? saved?.x ?? 540} onChange={(value) => setPoint(deviceId, "x", Number(value) || 0)} />
                  <NumberInput label="Y" min={0} max={5000} value={point?.y ?? saved?.y ?? 960} onChange={(value) => setPoint(deviceId, "y", Number(value) || 0)} />
                </Group>
                <Button size="compact-sm" variant="light" loading={savingCalibration === deviceId} disabled={calibrationSaved(deviceId) || !point} onClick={async () => {
                  setSavingCalibration(deviceId);
                  try {
                    await onCalibrate(deviceId, point!.x, point!.y);
                  } finally {
                    setSavingCalibration(null);
                  }
                }}>{calibrationSaved(deviceId) ? "Calibración guardada" : "Guardar calibración física"}</Button>
              </Stack>
            );
          })}
          <Group grow align="start">
            <NumberInput label="Rondas por dispositivo" min={1} max={50} value={rounds} onChange={(value) => { setRounds(Number(value) || 0); invalidateConfirmation(); }} />
          </Group>
          <Text size="sm"><strong>{selectedDeviceIds.length} dispositivos × {urls.length} Lives</strong> = {selectedDeviceIds.length * urls.length} ejecuciones · {rounds} rondas cada una · {rounds * 2} toques físicos por dispositivo</Text>
          <Checkbox checked={controlled} onChange={(event) => setControlled(event.currentTarget.checked)} label="Confirmo que la cuenta y los Lives son controlados." />
          <Checkbox checked={calibrated} onChange={(event) => setCalibrated(event.currentTarget.checked)} label="Confirmo que cada punto X/Y coincide con la calibración física guardada para su dispositivo." />
          {!configuration.liveEffectsEnabled && <Text className="inline-error">Bloqueado por `TIKTOK_LIVE_EFFECTS_ENABLED`; no se enviarán gestos.</Text>}
          <Button color="pink" loading={submitting} disabled={!enabled || submitting} onClick={async () => {
            setSubmitting(true);
            try {
              await onRun({
                deviceIds: selectedDeviceIds,
                urls,
                rounds,
                expectedAccount: configuration.controlledAccount!,
                targetTexts: urls.map((url) => targetTexts[url].trim()),
                idempotencyKey: crypto.randomUUID(),
                confirmed: true,
                controlledAccount: true,
                controlledContent: true,
                tapTapConfirmed: true,
              });
              setControlled(false);
              setCalibrated(false);
            } finally {
              setSubmitting(false);
            }
          }}>Iniciar {rounds} rondas × {selectedDeviceIds.length * urls.length} ejecuciones</Button>
        </Stack>
      </div>
    </section>
  );
}
