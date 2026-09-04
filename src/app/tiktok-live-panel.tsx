import { Alert, Badge, Button, Checkbox, Group, NumberInput, Select, Stack, Text, TextInput, Title } from "@mantine/core";
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
};

export type TikTokLiveInput = {
  deviceId: string;
  url: string;
  rounds: number;
  x: number;
  y: number;
  expectedAccount: string;
  expectedTargetText: string;
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
}: {
  devices: Device[];
  configuration: TikTokConfiguration;
  onRun: (input: TikTokLiveInput) => Promise<void>;
}) {
  const eligible = devices.filter((device) => isDeviceEligible(device, "tiktok"));
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [rounds, setRounds] = useState(10);
  const [x, setX] = useState(540);
  const [y, setY] = useState(960);
  const [targetText, setTargetText] = useState("");
  const [controlled, setControlled] = useState(false);
  const [calibrated, setCalibrated] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const invalidateConfirmation = () => {
    setControlled(false);
    setCalibrated(false);
  };
  const calibrationMatches = configuration.liveCalibration?.deviceId === deviceId
    && configuration.liveCalibration.x === x
    && configuration.liveCalibration.y === y;
  const enabled = configuration.liveEffectsEnabled
    && configuration.liveSelectorsConfigured
    && Boolean(configuration.controlledAccount)
    && Boolean(deviceId)
    && validLiveUrl(url)
    && Number.isInteger(rounds) && rounds >= 1 && rounds <= 50
    && Number.isInteger(x) && x >= 0 && x <= 5000
    && Number.isInteger(y) && y >= 0 && y <= 5000
    && targetText.trim().length >= 5
    && calibrationMatches
    && controlled
    && calibrated;

  return (
    <section className="work-section tiktok-live" aria-labelledby="tiktok-live-title">
      <div className="section-toolbar compact">
        <div><span className="section-code">TIKTOK LIVE / FLUJO INDEPENDIENTE</span><Title order={2} id="tiktok-live-title">Tap tap calibrado</Title></div>
        <Badge color={configuration.liveEffectsEnabled ? "pink" : "gray"} size="lg">{configuration.liveEffectsEnabled ? "Gate habilitado" : "Deshabilitado"}</Badge>
      </div>
      <Alert color="yellow" title="Requiere prueba física independiente">
        Una ronda emite exactamente un comando de doble toque. Si su resultado queda incierto, se bloquea sin reintento automático.
      </Alert>
      <div className="tiktok-live-grid">
        <Stack gap="sm">
          <Select label="Dispositivo controlado" placeholder="Selecciona uno" value={deviceId} onChange={(value) => { setDeviceId(value); invalidateConfirmation(); }} data={eligible.map((device) => ({ value: device.id, label: `${device.order} / ${device.alias} / ${device.serial}` }))} />
          <TextInput type="url" label="URL Live" description="Formato exacto: https://www.tiktok.com/@usuario/live" value={url} onChange={(event) => { setUrl(event.currentTarget.value); invalidateConfirmation(); }} error={url && !validLiveUrl(url) ? "Usa un Live de tiktok.com sin credenciales ni puerto." : undefined} />
          <TextInput label="Texto visible que identifica el Live" maxLength={500} value={targetText} onChange={(event) => { setTargetText(event.currentTarget.value); invalidateConfirmation(); }} />
        </Stack>
        <Stack gap="sm">
          <Group grow align="start"><NumberInput label="Rondas" min={1} max={50} value={rounds} onChange={(value) => { setRounds(Number(value) || 0); invalidateConfirmation(); }} /><NumberInput label="X" min={0} max={5000} value={x} onChange={(value) => { setX(Number(value) || 0); invalidateConfirmation(); }} /><NumberInput label="Y" min={0} max={5000} value={y} onChange={(value) => { setY(Number(value) || 0); invalidateConfirmation(); }} /></Group>
          <Text size="sm"><strong>{rounds} rondas</strong> · {rounds * 2} toques físicos solicitados · punto ({x}, {y})</Text>
          <Checkbox checked={controlled} onChange={(event) => setControlled(event.currentTarget.checked)} label="Confirmo que la cuenta y el Live son controlados." />
          <Checkbox disabled={!calibrationMatches} checked={calibrated} onChange={(event) => setCalibrated(event.currentTarget.checked)} label="Confirmo que estas coordenadas coinciden con la calibración física registrada para este dispositivo." />
          {!calibrationMatches && <Text className="inline-error">El dispositivo y X/Y no coinciden con `TIKTOK_LIVE_CALIBRATED_*`.</Text>}
          {!configuration.liveEffectsEnabled && <Text className="inline-error">Bloqueado por `TIKTOK_LIVE_EFFECTS_ENABLED`; no se enviarán gestos.</Text>}
          <Button color="pink" loading={submitting} disabled={!enabled || submitting} onClick={async () => {
            setSubmitting(true);
            try {
              await onRun({
            deviceId: deviceId!,
            url,
            rounds,
            x,
            y,
            expectedAccount: configuration.controlledAccount!,
            expectedTargetText: targetText.trim(),
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
          }}>Iniciar {rounds} rondas</Button>
        </Stack>
      </div>
    </section>
  );
}
