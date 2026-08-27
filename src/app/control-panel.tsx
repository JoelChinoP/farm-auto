"use client";

import {
  FormEvent,
  ReactNode,
  startTransition,
  useEffect,
  useEffectEvent,
  useState,
} from "react";

type Device = {
  id: string;
  state: string;
  model: string;
  genFarmer?: { serialNo: string; name?: string };
  capabilities: null | {
    tiktok: boolean;
    facebook: boolean;
    whatsapp: boolean;
    focusedPackage: string | null;
  };
};

type Draft = {
  id: string;
  kind: "social_comment" | "direct_message";
  platform: "tiktok" | "facebook" | "whatsapp";
  text: string;
  status: "draft" | "approved" | "sent" | "failed";
  consent_confirmed: number;
  recipient: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
};

type Operation = {
  id: string;
  kind: string;
  status: "starting" | "running" | "succeeded" | "failed";
  device_id: string;
  run_id: string | null;
  error: string | null;
  created_at: string;
};

type Snapshot = {
  health: { ok: boolean; version: string | null };
  deepSeek: { configured: boolean; model: string };
  devices: Device[];
  automations: Array<{ slug: string; device_id: string }>;
  drafts: Draft[];
  operations: Operation[];
  polledAt: string;
};

type ApiPayload<T> = {
  success: boolean;
  data: T;
  message?: string;
};

type AutomationSlug =
  | "device-home"
  | "open-social-content"
  | "facebook-post-like-comment"
  | "tiktok-live-tap-tap"
  | "tiktok-post-like-comment"
  | "whatsapp-consented";

type AutomationDefinition = {
  slug: AutomationSlug;
  code: string;
  group: string;
  title: string;
  description: string;
  file: string;
  accent: "system" | "neutral" | "facebook" | "live" | "tiktok" | "whatsapp";
};

type RunAction = (
  name: string,
  action: () => Promise<unknown>,
  successMessage: string,
) => Promise<void>;

type WorkspaceProps = {
  active: boolean;
  definition: AutomationDefinition;
  selectedDevice: string;
  ready: boolean;
  device: Device | undefined;
  snapshot: Snapshot | null;
  busy: string | null;
  runAction: RunAction;
};

const requiredAutomations = 6;

const automationDefinitions: AutomationDefinition[] = [
  {
    slug: "device-home",
    code: "HM",
    group: "Sistema",
    title: "Pantalla de inicio",
    description: "Cierra el contexto actual y deja Android en un estado conocido.",
    file: "device-home.genfarm",
    accent: "system",
  },
  {
    slug: "open-social-content",
    code: "AB",
    group: "Navegación",
    title: "Abrir contenido",
    description: "Abre un enlace sin dar like, comentar ni enviar nada.",
    file: "open-social-content.genfarm",
    accent: "neutral",
  },
  {
    slug: "facebook-post-like-comment",
    code: "FB",
    group: "Facebook",
    title: "Like y comentario",
    description: "Borrador, aprobación y publicación exclusiva para Facebook.",
    file: "facebook-post-like-comment.genfarm",
    accent: "facebook",
  },
  {
    slug: "tiktok-live-tap-tap",
    code: "LV",
    group: "TikTok Live",
    title: "Tap tap controlado",
    description: "Rondas y coordenadas propias para una transmisión en vivo.",
    file: "tiktok-live-tap-tap.genfarm",
    accent: "live",
  },
  {
    slug: "tiktok-post-like-comment",
    code: "TK",
    group: "TikTok",
    title: "Like y comentario",
    description: "Borrador, aprobación y publicación exclusiva para TikTok.",
    file: "tiktok-post-like-comment.genfarm",
    accent: "tiktok",
  },
  {
    slug: "whatsapp-consented",
    code: "WA",
    group: "WhatsApp",
    title: "Mensaje consentido",
    description: "Número, consentimiento y texto aislados de las redes sociales.",
    file: "whatsapp-send-consented.genfarm",
    accent: "whatsapp",
  },
];

const tones = [
  ["casual", "Casual"],
  ["amable", "Amable"],
  ["curioso", "Curioso"],
  ["entusiasta", "Entusiasta"],
] as const;

async function api<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const payload = (await response.json()) as ApiPayload<T>;
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || "No se pudo completar la acción.");
  }
  return payload.data;
}

function friendlyAction(kind: string) {
  return (
    {
      "device-home": "Pantalla de inicio",
      "facebook-post-like-comment": "Like y comentario en Facebook",
      "open-social-content": "Abrir contenido",
      "tiktok-live-tap-tap": "Tap tap en TikTok Live",
      "tiktok-post-like-comment": "Like y comentario en TikTok",
      "whatsapp-consented": "Mensaje WhatsApp",
    }[kind] || kind
  );
}

function friendlyStatus(status: Operation["status"] | Draft["status"]) {
  return (
    {
      starting: "Iniciando",
      running: "Ejecutando",
      succeeded: "Completada",
      failed: "Falló",
      draft: "Borrador",
      approved: "Aprobado",
      sent: "Enviado",
    }[status] || status
  );
}

function latestOperation(
  snapshot: Snapshot | null,
  slug: AutomationSlug,
  deviceId: string,
) {
  return snapshot?.operations.find(
    (operation) => operation.kind === slug && operation.device_id === deviceId,
  );
}

function appAvailable(definition: AutomationDefinition, device?: Device) {
  if (!device?.capabilities) return false;
  if (definition.accent === "facebook") return device.capabilities.facebook;
  if (["live", "tiktok"].includes(definition.accent)) {
    return device.capabilities.tiktok;
  }
  if (definition.accent === "whatsapp") return device.capabilities.whatsapp;
  if (definition.slug === "open-social-content") {
    return device.capabilities.tiktok || device.capabilities.facebook;
  }
  return true;
}

function WorkspaceShell({
  active,
  definition,
  ready,
  latest,
  children,
}: {
  active: boolean;
  definition: AutomationDefinition;
  ready: boolean;
  latest?: Operation;
  children: ReactNode;
}) {
  return (
    <section
      className={`automation-workspace accent-${definition.accent}`}
      hidden={!active}
      aria-labelledby={`workspace-${definition.slug}`}
    >
      <header className="workspace-header">
        <div className="workspace-identity">
          <span className="workspace-code">{definition.code}</span>
          <div>
            <p className="workspace-kicker">{definition.group}</p>
            <h2 id={`workspace-${definition.slug}`}>{definition.title}</h2>
            <p>{definition.description}</p>
          </div>
        </div>
        <div className="workspace-state">
          <span className={`pill ${latest?.status || (ready ? "succeeded" : "failed")}`}>
            {latest ? friendlyStatus(latest.status) : ready ? "Preparada" : "Sin preparar"}
          </span>
          <code>{definition.file}</code>
        </div>
      </header>
      {children}
    </section>
  );
}

function Requirement({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={`requirement ${ok ? "ok" : "missing"}`}>
      <span aria-hidden="true">{ok ? "OK" : "!"}</span>
      {children}
    </span>
  );
}

function WorkflowSteps({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <ol className="workflow-steps" aria-label="Progreso">
      {[
        [1, "Objetivo"],
        [2, "Borrador"],
        [3, "Aprobación"],
        [4, "Ejecución"],
      ].map(([step, label]) => (
        <li
          className={Number(step) < current ? "complete" : Number(step) === current ? "active" : ""}
          key={step}
        >
          <span>{step}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

function DraftHistory({
  drafts,
  onSelect,
}: {
  drafts: Draft[];
  onSelect: (draft: Draft) => void;
}) {
  if (!drafts.length) return null;
  return (
    <div className="draft-history">
      <div className="subheading">
        <div>
          <strong>Borradores recientes</strong>
          <span>Solo de esta interfaz</span>
        </div>
      </div>
      <div className="draft-history-list">
        {drafts.slice(0, 3).map((draft) => (
          <button type="button" key={draft.id} onClick={() => onSelect(draft)}>
            <span className={`activity-icon ${draft.status}`} />
            <span>{draft.text}</span>
            <small>{friendlyStatus(draft.status)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function HomeWorkspace(props: WorkspaceProps) {
  const latest = latestOperation(props.snapshot, props.definition.slug, props.selectedDevice);
  return (
    <WorkspaceShell {...props} latest={latest}>
      <div className="simple-workspace-grid">
        <div className="home-preview" aria-hidden="true">
          <div className="phone-outline">
            <span />
            <div className="home-glyph">⌂</div>
          </div>
        </div>
        <div className="action-brief">
          <p className="eyebrow">Acción segura</p>
          <h3>Recupera un punto de partida limpio.</h3>
          <p>
            Úsala cuando una app quedó en un diálogo, teclado o pantalla inesperada. No
            publica ni modifica contenido.
          </p>
          <div className="requirement-row">
            <Requirement ok={Boolean(props.selectedDevice)}>Dispositivo seleccionado</Requirement>
            <Requirement ok={props.ready}>Paquete preparado</Requirement>
          </div>
          <button
            type="button"
            className="button primary action-button"
            onClick={() =>
              props.runAction(
                "device-home",
                () =>
                  api("/api/automations/home", {
                    method: "POST",
                    body: JSON.stringify({
                      deviceId: props.selectedDevice,
                      idempotencyKey: crypto.randomUUID(),
                    }),
                  }),
                "El dispositivo volvió a la pantalla de inicio.",
              )
            }
            disabled={Boolean(props.busy) || !props.ready || !props.selectedDevice}
          >
            {props.busy === "device-home" ? "Volviendo..." : "Ir a inicio ahora"}
          </button>
        </div>
      </div>
    </WorkspaceShell>
  );
}

function OpenContentWorkspace(props: WorkspaceProps) {
  const [platform, setPlatform] = useState<"tiktok" | "facebook">("tiktok");
  const [url, setUrl] = useState("");
  const latest = latestOperation(props.snapshot, props.definition.slug, props.selectedDevice);
  const installed = Boolean(props.device?.capabilities?.[platform]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.runAction(
      "open-content",
      () =>
        api("/api/automations/open-content", {
          method: "POST",
          body: JSON.stringify({
            deviceId: props.selectedDevice,
            idempotencyKey: crypto.randomUUID(),
            platform,
            url,
          }),
        }),
      `Contenido abierto en ${platform === "tiktok" ? "TikTok" : "Facebook"}.`,
    );
  }

  return (
    <WorkspaceShell {...props} latest={latest}>
      <div className="workspace-body two-column-workspace">
        <div className="workspace-explainer">
          <p className="eyebrow">Navegación aislada</p>
          <h3>Primero observa. Después decide.</h3>
          <p>
            Este módulo solo abre el enlace. Es ideal para revisar una publicación antes
            de generar un comentario o configurar un Live.
          </p>
          <div className="action-boundary">
            <strong>No interactúa</strong>
            <span>Sin likes, comentarios, mensajes ni tap tap.</span>
          </div>
        </div>
        <form onSubmit={submit} className="workspace-form">
          <div className="platform-choice" aria-label="Plataforma objetivo">
            <button
              type="button"
              className={platform === "tiktok" ? "active tiktok" : "tiktok"}
              onClick={() => setPlatform("tiktok")}
            >
              <span>TK</span>
              <strong>TikTok</strong>
              <small>{props.device?.capabilities?.tiktok ? "Instalado" : "No instalado"}</small>
            </button>
            <button
              type="button"
              className={platform === "facebook" ? "active facebook" : "facebook"}
              onClick={() => setPlatform("facebook")}
            >
              <span>FB</span>
              <strong>Facebook</strong>
              <small>{props.device?.capabilities?.facebook ? "Instalado" : "No instalado"}</small>
            </button>
          </div>
          <label className="field">
            <span>Enlace de {platform === "tiktok" ? "TikTok" : "Facebook"}</span>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={
                platform === "tiktok"
                  ? "https://www.tiktok.com/@cuenta/video/..."
                  : "https://www.facebook.com/share/p/..."
              }
              maxLength={2048}
              required
            />
          </label>
          <div className="requirement-row">
            <Requirement ok={props.ready}>Paquete preparado</Requirement>
            <Requirement ok={installed}>{platform} instalado</Requirement>
          </div>
          <button
            className="button primary full"
            disabled={Boolean(props.busy) || !props.ready || !installed}
          >
            {props.busy === "open-content"
              ? "Abriendo..."
              : `Abrir sin interactuar en ${platform === "tiktok" ? "TikTok" : "Facebook"}`}
          </button>
        </form>
      </div>
    </WorkspaceShell>
  );
}

function SocialCommentWorkspace(
  props: WorkspaceProps & { platform: "tiktok" | "facebook" },
) {
  const [url, setUrl] = useState("");
  const [context, setContext] = useState("");
  const [intent, setIntent] = useState("");
  const [tone, setTone] = useState<(typeof tones)[number][0]>("casual");
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const latest = latestOperation(props.snapshot, props.definition.slug, props.selectedDevice);
  const drafts =
    props.snapshot?.drafts.filter(
      (draft) => draft.kind === "social_comment" && draft.platform === props.platform,
    ) ?? [];
  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) ?? null;
  const installed = Boolean(props.device?.capabilities?.[props.platform]);
  const platformName = props.platform === "tiktok" ? "TikTok" : "Facebook";
  const busyPrefix = `${props.platform}-`;
  const currentStep: 1 | 2 | 3 | 4 = !activeDraft
    ? 1
    : activeDraft.status === "draft"
      ? 2
      : activeDraft.status === "approved"
        ? 3
        : 4;

  function selectDraft(draft: Draft) {
    setActiveDraftId(draft.id);
    setDraftText(draft.text);
  }

  function startNewDraft() {
    setActiveDraftId(null);
    setDraftText("");
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.runAction(
      `${busyPrefix}generate`,
      async () => {
        const result = await api<{ draft: Draft }>("/api/messages/draft", {
          method: "POST",
          body: JSON.stringify({
            kind: "social_comment",
            platform: props.platform,
            context,
            intent,
            tone,
          }),
        });
        selectDraft(result.draft);
      },
      `Borrador de ${platformName} generado. Revísalo antes de aprobar.`,
    );
  }

  async function approve() {
    if (!activeDraft) return;
    await props.runAction(
      `${busyPrefix}approve`,
      async () => {
        const result = await api<{ draft: Draft }>(
          `/api/messages/${activeDraft.id}/approve`,
          {
            method: "PUT",
            body: JSON.stringify({
              text: draftText,
              consentConfirmed: false,
              recipient: "",
            }),
          },
        );
        setDraftText(result.draft.text);
      },
      `Comentario de ${platformName} aprobado y registrado.`,
    );
  }

  async function copyApproved() {
    await props.runAction(
      `${busyPrefix}copy`,
      () => navigator.clipboard.writeText(draftText),
      "Texto aprobado copiado.",
    );
  }

  async function send() {
    if (!activeDraft) return;
    await props.runAction(
      `${busyPrefix}send`,
      () =>
        api(`/api/messages/${activeDraft.id}/send`, {
          method: "POST",
          body: JSON.stringify({ deviceId: props.selectedDevice, contentUrl: url }),
        }),
      `Like y comentario publicados una sola vez en ${platformName}.`,
    );
  }

  return (
    <WorkspaceShell {...props} latest={latest}>
      <WorkflowSteps current={currentStep} />
      <div className="social-workspace-grid">
        <div className="target-column">
          <div className="subheading">
            <span>01</span>
            <div>
              <strong>Publicación objetivo</strong>
              <small>Exclusiva para {platformName}</small>
            </div>
          </div>
          <label className="field">
            <span>Enlace HTTPS</span>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={
                props.platform === "tiktok"
                  ? "https://www.tiktok.com/@cuenta/video/..."
                  : "https://www.facebook.com/share/p/..."
              }
              maxLength={2048}
              required
            />
          </label>
          <div className="platform-lock">
            <span>{props.definition.code}</span>
            <div>
              <strong>Destino bloqueado a {platformName}</strong>
              <small>El servidor rechazará enlaces de otra plataforma.</small>
            </div>
          </div>
          <div className="requirement-stack">
            <Requirement ok={props.ready}>Automatización preparada</Requirement>
            <Requirement ok={installed}>{platformName} instalado</Requirement>
            <Requirement ok={Boolean(url)}>Enlace ingresado</Requirement>
          </div>
        </div>

        <div className="draft-column">
          {!activeDraft ? (
            <>
              <form onSubmit={generate} className="workspace-form draft-generator">
                <div className="subheading">
                  <span>02</span>
                  <div>
                    <strong>Brief para DeepSeek</strong>
                    <small>Genera solo el texto, nunca lo publica.</small>
                  </div>
                </div>
                <label className="field">
                  <span>Contexto real</span>
                  <textarea
                    value={context}
                    onChange={(event) => setContext(event.target.value)}
                    placeholder="Describe qué aparece en la publicación y por qué importa."
                    minLength={5}
                    maxLength={1200}
                    rows={4}
                    required
                  />
                </label>
                <div className="form-row">
                  <label className="field">
                    <span>Intención</span>
                    <input
                      value={intent}
                      onChange={(event) => setIntent(event.target.value)}
                      placeholder="Ej. opinar y hacer una pregunta"
                      minLength={3}
                      maxLength={300}
                      required
                    />
                  </label>
                  <label className="field tone-field">
                    <span>Tono</span>
                    <select
                      value={tone}
                      onChange={(event) =>
                        setTone(event.target.value as (typeof tones)[number][0])
                      }
                    >
                      {tones.map(([value, label]) => (
                        <option value={value} key={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  className="button ink full"
                  disabled={Boolean(props.busy) || !props.snapshot?.deepSeek.configured}
                >
                  {props.busy === `${busyPrefix}generate`
                    ? "Redactando..."
                    : "Generar borrador con DeepSeek"}
                </button>
              </form>
              <DraftHistory drafts={drafts} onSelect={selectDraft} />
            </>
          ) : (
            <div className="draft-review independent-review">
              <div className="draft-meta">
                <div>
                  <span className={`pill ${activeDraft.status}`}>
                    {friendlyStatus(activeDraft.status)}
                  </span>
                  <small>{platformName} · {new Date(activeDraft.created_at).toLocaleString("es-PE")}</small>
                </div>
                <button type="button" className="text-button" onClick={startNewDraft}>
                  Nuevo borrador
                </button>
              </div>
              <label className="field">
                <span>Comentario editable</span>
                <textarea
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  rows={6}
                  minLength={2}
                  maxLength={500}
                  disabled={["sent", "failed"].includes(activeDraft.status)}
                />
                <small className="field-counter">{draftText.length}/500</small>
              </label>
              {activeDraft.error && <p className="inline-error">{activeDraft.error}</p>}
              {activeDraft.status === "draft" && (
                <div className="approval-box">
                  <div>
                    <strong>Revisión humana requerida</strong>
                    <span>El texto aún no puede salir del panel.</span>
                  </div>
                  <button
                    type="button"
                    className="button primary"
                    onClick={approve}
                    disabled={Boolean(props.busy) || draftText.trim().length < 2}
                  >
                    {props.busy === `${busyPrefix}approve` ? "Aprobando..." : "Aprobar este texto"}
                  </button>
                </div>
              )}
              {activeDraft.status === "approved" && (
                <div className="execution-box">
                  <div className="execution-warning">
                    <strong>Acción pública</strong>
                    <span>Dará like y publicará este comentario una sola vez.</span>
                  </div>
                  <div className="review-actions">
                    <button type="button" className="button secondary" onClick={copyApproved}>
                      Copiar texto
                    </button>
                    <button
                      type="button"
                      className="button danger"
                      onClick={send}
                      disabled={Boolean(props.busy) || !props.ready || !installed || !url}
                    >
                      {props.busy === `${busyPrefix}send`
                        ? "Publicando..."
                        : `Dar like y comentar en ${platformName}`}
                    </button>
                  </div>
                </div>
              )}
              {activeDraft.status === "sent" && (
                <div className="completion-box">
                  <strong>Publicación completada</strong>
                  <span>
                    El registro local marca este borrador como enviado y no lo repetirá.
                  </span>
                </div>
              )}
              {activeDraft.status === "failed" && (
                <div className="failure-box">
                  <strong>Esta ejecución quedó bloqueada</strong>
                  <span>Crea un borrador nuevo para evitar un envío duplicado accidental.</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </WorkspaceShell>
  );
}

function TikTokLiveWorkspace(props: WorkspaceProps) {
  const [url, setUrl] = useState("");
  const [tapRounds, setTapRounds] = useState("10");
  const [tapX, setTapX] = useState("540");
  const [tapY, setTapY] = useState("960");
  const latest = latestOperation(props.snapshot, props.definition.slug, props.selectedDevice);
  const installed = Boolean(props.device?.capabilities?.tiktok);
  const numericRounds = Number(tapRounds);
  const numericX = Number(tapX);
  const numericY = Number(tapY);
  const pointLeft = `${Math.max(4, Math.min(96, (numericX / 1080) * 100 || 50))}%`;
  const pointTop = `${Math.max(4, Math.min(96, (numericY / 2400) * 100 || 40))}%`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.runAction(
      "tiktok-live-run",
      () =>
        api("/api/automations/tiktok-live", {
          method: "POST",
          body: JSON.stringify({
            deviceId: props.selectedDevice,
            idempotencyKey: crypto.randomUUID(),
            url,
            tapRounds: numericRounds,
            tapX: numericX,
            tapY: numericY,
          }),
        }),
      `${numericRounds} rondas de tap tap completadas; dispositivo devuelto a inicio.`,
    );
  }

  return (
    <WorkspaceShell {...props} latest={latest}>
      <div className="live-workspace-grid">
        <div className="live-preview-column">
          <div className="subheading">
            <div>
              <strong>Vista de coordenadas</strong>
              <span>Referencia vertical 1080 × 2400</span>
            </div>
          </div>
          <div className="tap-preview" aria-label={`Punto de toque X ${tapX}, Y ${tapY}`}>
            <div className="tap-preview-top" />
            <div className="tap-point" style={{ left: pointLeft, top: pointTop }}>
              <span />
            </div>
            <div className="tap-coordinate x">X {tapX || "-"}</div>
            <div className="tap-coordinate y">Y {tapY || "-"}</div>
          </div>
          <p className="helper-text">
            El punto es orientativo. Ajusta las coordenadas según la resolución real del
            dispositivo seleccionado.
          </p>
        </div>
        <form onSubmit={submit} className="workspace-form live-form">
          <div className="subheading">
            <span>LIVE</span>
            <div>
              <strong>Sesión de tap tap</strong>
              <small>Cada ronda ejecuta un gesto de doble toque.</small>
            </div>
          </div>
          <label className="field">
            <span>Enlace del Live de TikTok</span>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://www.tiktok.com/@usuario/live"
              maxLength={2048}
              required
            />
          </label>
          <div className="number-grid">
            <label className="field">
              <span>Rondas</span>
              <input
                type="number"
                value={tapRounds}
                onChange={(event) => setTapRounds(event.target.value)}
                min={1}
                max={50}
                step={1}
                required
              />
              <small>1 a 50</small>
            </label>
            <label className="field">
              <span>Coordenada X</span>
              <input
                type="number"
                value={tapX}
                onChange={(event) => setTapX(event.target.value)}
                min={0}
                max={5000}
                step={1}
                required
              />
              <small>Horizontal</small>
            </label>
            <label className="field">
              <span>Coordenada Y</span>
              <input
                type="number"
                value={tapY}
                onChange={(event) => setTapY(event.target.value)}
                min={0}
                max={5000}
                step={1}
                required
              />
              <small>Vertical</small>
            </label>
          </div>
          <div className="live-summary">
            <span>Resultado configurado</span>
            <strong>{Number.isFinite(numericRounds) ? numericRounds * 2 : 0} toques</strong>
            <small>{tapRounds || 0} rondas × 2 toques</small>
          </div>
          <div className="requirement-row">
            <Requirement ok={props.ready}>Paquete preparado</Requirement>
            <Requirement ok={installed}>TikTok instalado</Requirement>
          </div>
          <button
            className="button danger full"
            disabled={Boolean(props.busy) || !props.ready || !installed}
          >
            {props.busy === "tiktok-live-run"
              ? "Ejecutando tap tap..."
              : `Iniciar ${tapRounds || 0} rondas`}
          </button>
        </form>
      </div>
    </WorkspaceShell>
  );
}

function WhatsAppWorkspace(props: WorkspaceProps) {
  const [context, setContext] = useState("");
  const [intent, setIntent] = useState("");
  const [tone, setTone] = useState<(typeof tones)[number][0]>("amable");
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [consent, setConsent] = useState(false);
  const latest = latestOperation(props.snapshot, props.definition.slug, props.selectedDevice);
  const drafts =
    props.snapshot?.drafts.filter(
      (draft) => draft.kind === "direct_message" && draft.platform === "whatsapp",
    ) ?? [];
  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) ?? null;
  const installed = Boolean(props.device?.capabilities?.whatsapp);
  const currentStep: 1 | 2 | 3 | 4 = !activeDraft
    ? 1
    : activeDraft.status === "draft"
      ? 2
      : activeDraft.status === "approved"
        ? 3
        : 4;

  function selectDraft(draft: Draft) {
    setActiveDraftId(draft.id);
    setDraftText(draft.text);
    setRecipient(draft.recipient || "");
    setConsent(Boolean(draft.consent_confirmed));
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.runAction(
      "whatsapp-generate",
      async () => {
        const result = await api<{ draft: Draft }>("/api/messages/draft", {
          method: "POST",
          body: JSON.stringify({
            kind: "direct_message",
            platform: "whatsapp",
            context,
            intent,
            tone,
          }),
        });
        selectDraft(result.draft);
      },
      "Borrador de WhatsApp generado. Revisa destinatario, texto y consentimiento.",
    );
  }

  async function approve() {
    if (!activeDraft) return;
    await props.runAction(
      "whatsapp-approve",
      () =>
        api(`/api/messages/${activeDraft.id}/approve`, {
          method: "PUT",
          body: JSON.stringify({
            text: draftText,
            consentConfirmed: consent,
            recipient,
          }),
        }),
      "Mensaje y consentimiento aprobados.",
    );
  }

  async function send() {
    if (!activeDraft) return;
    await props.runAction(
      "whatsapp-send",
      () =>
        api(`/api/messages/${activeDraft.id}/send`, {
          method: "POST",
          body: JSON.stringify({ deviceId: props.selectedDevice }),
        }),
      "Mensaje de WhatsApp enviado una sola vez.",
    );
  }

  return (
    <WorkspaceShell {...props} latest={latest}>
      <WorkflowSteps current={currentStep} />
      <div className="whatsapp-workspace-grid">
        <div className="workspace-explainer whatsapp-explainer">
          <p className="eyebrow">Canal directo</p>
          <h3>Consentimiento antes que envío.</h3>
          <p>
            Esta interfaz nunca usa enlaces sociales. El número internacional y la
            confirmación de consentimiento pertenecen solo a este mensaje.
          </p>
          <div className="consent-boundary">
            <span>WA</span>
            <div>
              <strong>Bloqueo obligatorio</strong>
              <small>Sin consentimiento no se puede aprobar.</small>
            </div>
          </div>
          <div className="requirement-stack">
            <Requirement ok={props.ready}>Automatización preparada</Requirement>
            <Requirement ok={installed}>WhatsApp instalado</Requirement>
          </div>
        </div>
        <div className="draft-column">
          {!activeDraft ? (
            <>
              <form onSubmit={generate} className="workspace-form draft-generator">
                <div className="subheading">
                  <span>01</span>
                  <div>
                    <strong>Brief del mensaje</strong>
                    <small>DeepSeek no recibe ni necesita el número.</small>
                  </div>
                </div>
                <label className="field">
                  <span>Contexto real</span>
                  <textarea
                    value={context}
                    onChange={(event) => setContext(event.target.value)}
                    placeholder="Explica la conversación previa y la relación con el destinatario."
                    minLength={5}
                    maxLength={1200}
                    rows={4}
                    required
                  />
                </label>
                <div className="form-row">
                  <label className="field">
                    <span>Intención</span>
                    <input
                      value={intent}
                      onChange={(event) => setIntent(event.target.value)}
                      placeholder="Ej. confirmar la hora acordada"
                      minLength={3}
                      maxLength={300}
                      required
                    />
                  </label>
                  <label className="field tone-field">
                    <span>Tono</span>
                    <select
                      value={tone}
                      onChange={(event) =>
                        setTone(event.target.value as (typeof tones)[number][0])
                      }
                    >
                      {tones.map(([value, label]) => (
                        <option value={value} key={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  className="button ink full"
                  disabled={Boolean(props.busy) || !props.snapshot?.deepSeek.configured}
                >
                  {props.busy === "whatsapp-generate"
                    ? "Redactando..."
                    : "Generar mensaje con DeepSeek"}
                </button>
              </form>
              <DraftHistory drafts={drafts} onSelect={selectDraft} />
            </>
          ) : (
            <div className="draft-review independent-review">
              <div className="draft-meta">
                <div>
                  <span className={`pill ${activeDraft.status}`}>
                    {friendlyStatus(activeDraft.status)}
                  </span>
                  <small>WhatsApp · {new Date(activeDraft.created_at).toLocaleString("es-PE")}</small>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setActiveDraftId(null);
                    setDraftText("");
                    setRecipient("");
                    setConsent(false);
                  }}
                >
                  Nuevo borrador
                </button>
              </div>
              <label className="field">
                <span>Número internacional, sin +</span>
                <input
                  inputMode="numeric"
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value)}
                  placeholder="51987654321"
                  maxLength={24}
                  disabled={activeDraft.status !== "draft"}
                />
              </label>
              <label className="field">
                <span>Mensaje editable</span>
                <textarea
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  rows={6}
                  minLength={2}
                  maxLength={500}
                  disabled={["sent", "failed"].includes(activeDraft.status)}
                />
                <small className="field-counter">{draftText.length}/500</small>
              </label>
              {activeDraft.status === "draft" && (
                <label className="consent-check consent-card">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  <span>
                    <strong>Confirmo el consentimiento</strong>
                    Esta persona aceptó recibir este mensaje por WhatsApp.
                  </span>
                </label>
              )}
              {activeDraft.error && <p className="inline-error">{activeDraft.error}</p>}
              {activeDraft.status === "draft" && (
                <button
                  type="button"
                  className="button primary full"
                  onClick={approve}
                  disabled={
                    Boolean(props.busy) ||
                    !consent ||
                    recipient.trim().length < 8 ||
                    draftText.trim().length < 2
                  }
                >
                  {props.busy === "whatsapp-approve"
                    ? "Aprobando..."
                    : "Aprobar número, texto y consentimiento"}
                </button>
              )}
              {activeDraft.status === "approved" && (
                <div className="execution-box whatsapp-execution">
                  <div className="execution-warning">
                    <strong>Envío directo</strong>
                    <span>Destinatario: +{activeDraft.recipient}</span>
                  </div>
                  <button
                    type="button"
                    className="button danger"
                    onClick={send}
                    disabled={Boolean(props.busy) || !props.ready || !installed}
                  >
                    {props.busy === "whatsapp-send" ? "Enviando..." : "Enviar una sola vez"}
                  </button>
                </div>
              )}
              {activeDraft.status === "sent" && (
                <div className="completion-box">
                  <strong>Mensaje enviado</strong>
                  <span>El registro impide repetir este borrador accidentalmente.</span>
                </div>
              )}
              {activeDraft.status === "failed" && (
                <div className="failure-box">
                  <strong>Envío no completado</strong>
                  <span>Crea un borrador nuevo antes de intentar otra entrega.</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </WorkspaceShell>
  );
}

export function ControlPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [activeAutomation, setActiveAutomation] =
    useState<AutomationSlug>("open-social-content");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  async function loadSnapshot() {
    try {
      const data = await api<Snapshot>("/api/status");
      startTransition(() => {
        setSnapshot(data);
        setSelectedDevice((current) =>
          data.devices.some((device) => device.id === current)
            ? current
            : data.devices.find((device) => device.state === "device")?.id || "",
        );
      });
    } catch {
      // Keep the last useful snapshot during a transient polling failure.
    }
  }

  const pollStatus = useEffectEvent(loadSnapshot);

  useEffect(() => {
    void pollStatus();
    const interval = window.setInterval(() => void pollStatus(), 2_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const selectFromHash = () => {
      const slug = window.location.hash.slice(1) as AutomationSlug;
      if (automationDefinitions.some((definition) => definition.slug === slug)) {
        setActiveAutomation(slug);
      }
    };
    const timer = window.setTimeout(selectFromHash, 0);
    window.addEventListener("hashchange", selectFromHash);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", selectFromHash);
    };
  }, []);

  const device = snapshot?.devices.find((item) => item.id === selectedDevice);
  const registeredSlugs = new Set(
    snapshot?.automations
      .filter((item) => item.device_id === selectedDevice)
      .map((item) => item.slug) ?? [],
  );
  const setupCount = registeredSlugs.size;
  const isReady = setupCount >= requiredAutomations;

  function automationReady(slug: AutomationSlug) {
    if (slug === "device-home") return registeredSlugs.has(slug);
    return registeredSlugs.has(slug) && registeredSlugs.has("device-home");
  }

  const runAction: RunAction = async (name, action, successMessage) => {
    if (!selectedDevice) {
      setNotice({ type: "error", text: "Selecciona un dispositivo conectado." });
      return;
    }
    setBusy(name);
    setNotice(null);
    try {
      await action();
      await loadSnapshot();
      setNotice({ type: "success", text: successMessage });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Ocurrió un error.",
      });
    } finally {
      setBusy(null);
    }
  };

  async function prepareDevice() {
    await runAction(
      "setup",
      () =>
        api("/api/setup", {
          method: "POST",
          body: JSON.stringify({ deviceId: selectedDevice }),
        }),
      "Las seis automatizaciones quedaron preparadas para este dispositivo.",
    );
  }

  async function stopRun(runId: string) {
    await runAction(
      `stop-${runId}`,
      () => api(`/api/runs/${runId}`, { method: "DELETE" }),
      "Ejecución detenida.",
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">GF</span>
          <div>
            <strong>Control local</strong>
            <span>Un módulo por automatización</span>
          </div>
        </div>
        <div className="system-state">
          <span className={`status-dot ${snapshot?.health.ok ? "online" : ""}`} />
          {snapshot?.health.ok ? snapshot.health.version : "GenFarmer sin conexión"}
        </div>
      </header>

      <section className="intro independent-intro">
        <div>
          <p className="eyebrow">Seis paquetes · seis puestos de mando</p>
          <h1>Cada automatización, su propia interfaz.</h1>
          <p className="intro-copy">
            Los campos, borradores y acciones quedan aislados por `.genfarm`. Ves solo lo
            necesario y sabes qué ocurrirá antes de ejecutar.
          </p>
        </div>
        <div className="connection-card">
          <span className="connection-label">Asistente de redacción</span>
          <strong>{snapshot?.deepSeek.model || "Comprobando..."}</strong>
          <span className={snapshot?.deepSeek.configured ? "ok-text" : "error-text"}>
            {snapshot?.deepSeek.configured ? "DeepSeek disponible" : "Falta API_DEEPSEEK"}
          </span>
        </div>
      </section>

      <section className="device-strip compact-device-strip">
        <div className="device-heading">
          <span className="section-number">01</span>
          <div>
            <h2>Dispositivo activo</h2>
            <p>Todas las interfaces respetan esta selección.</p>
          </div>
        </div>
        <label className="device-select">
          <span>ADB conectado</span>
          <select
            value={selectedDevice}
            onChange={(event) => setSelectedDevice(event.target.value)}
          >
            {snapshot?.devices.length ? (
              snapshot.devices.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.model} · {item.id}
                </option>
              ))
            ) : (
              <option value="">Sin dispositivos</option>
            )}
          </select>
        </label>
        <div className="device-facts compact-facts">
          <div>
            <span>GenFarmer</span>
            <strong>{device?.genFarmer ? "Reconocido" : "No detectado"}</strong>
          </div>
          <div>
            <span>Paquetes</span>
            <strong>{isReady ? "6 de 6 listos" : `${setupCount} de 6`}</strong>
          </div>
          <div>
            <span>En pantalla</span>
            <strong>{device?.capabilities?.focusedPackage || "Sin lectura"}</strong>
          </div>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={prepareDevice}
          disabled={Boolean(busy) || !selectedDevice}
        >
          {busy === "setup" ? "Preparando seis paquetes..." : isReady ? "Verificar paquetes" : "Preparar los seis"}
        </button>
      </section>

      {notice && (
        <div className={`notice ${notice.type}`} role="status">
          <span>{notice.type === "success" ? "Listo" : "Atención"}</span>
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label="Cerrar">
            ×
          </button>
        </div>
      )}

      <section className="automation-console">
        <div className="console-heading">
          <div>
            <span className="section-number">02</span>
            <div>
              <p className="eyebrow">Control por paquete</p>
              <h2>Elige una automatización</h2>
            </div>
          </div>
          <span className="console-hint">Los formularios conservan su estado al cambiar.</span>
        </div>

        <div className="automation-layout">
          <nav className="automation-nav" aria-label="Automatizaciones disponibles">
            {automationDefinitions.map((definition) => {
              const ready = automationReady(definition.slug);
              const available = appAvailable(definition, device);
              return (
                <button
                  type="button"
                  className={`automation-nav-item accent-${definition.accent} ${
                    activeAutomation === definition.slug ? "active" : ""
                  }`}
                  onClick={() => {
                    setActiveAutomation(definition.slug);
                    window.history.replaceState(null, "", `#${definition.slug}`);
                  }}
                  aria-pressed={activeAutomation === definition.slug}
                  key={definition.slug}
                >
                  <span className="nav-code">{definition.code}</span>
                  <span className="nav-copy">
                    <small>{definition.group}</small>
                    <strong>{definition.title}</strong>
                    <span>{definition.description}</span>
                  </span>
                  <span
                    className={`nav-state ${ready && available ? "ready" : "missing"}`}
                    title={ready ? (available ? "Lista" : "Aplicación no instalada") : "Sin preparar"}
                  />
                </button>
              );
            })}
          </nav>

          <div className="automation-stage">
            {automationDefinitions.map((definition) => {
              const commonProps: WorkspaceProps = {
                active: activeAutomation === definition.slug,
                definition,
                selectedDevice,
                ready: automationReady(definition.slug),
                device,
                snapshot,
                busy,
                runAction,
              };
              if (definition.slug === "device-home") {
                return <HomeWorkspace {...commonProps} key={definition.slug} />;
              }
              if (definition.slug === "open-social-content") {
                return <OpenContentWorkspace {...commonProps} key={definition.slug} />;
              }
              if (definition.slug === "facebook-post-like-comment") {
                return (
                  <SocialCommentWorkspace
                    {...commonProps}
                    platform="facebook"
                    key={definition.slug}
                  />
                );
              }
              if (definition.slug === "tiktok-live-tap-tap") {
                return <TikTokLiveWorkspace {...commonProps} key={definition.slug} />;
              }
              if (definition.slug === "tiktok-post-like-comment") {
                return (
                  <SocialCommentWorkspace
                    {...commonProps}
                    platform="tiktok"
                    key={definition.slug}
                  />
                );
              }
              return <WhatsAppWorkspace {...commonProps} key={definition.slug} />;
            })}
          </div>
        </div>
      </section>

      <section className="activity">
        <div className="activity-heading">
          <div>
            <p className="eyebrow">Auditoría compartida</p>
            <h2>Actividad reciente</h2>
          </div>
          <span>
            SQLite · {snapshot ? new Date(snapshot.polledAt).toLocaleTimeString("es-PE") : "--:--"}
          </span>
        </div>
        <div className="activity-list">
          {snapshot?.operations.length ? (
            snapshot.operations.slice(0, 8).map((operation) => (
              <article className="activity-row" key={operation.id}>
                <span className={`activity-icon ${operation.status}`} />
                <div>
                  <strong>{friendlyAction(operation.kind)}</strong>
                  <span>{operation.device_id}</span>
                </div>
                <time>{new Date(operation.created_at).toLocaleString("es-PE")}</time>
                <span className={`pill ${operation.status}`}>
                  {friendlyStatus(operation.status)}
                </span>
                {operation.status === "running" && operation.run_id && (
                  <button
                    type="button"
                    className="text-button danger-text"
                    onClick={() => stopRun(operation.run_id!)}
                    disabled={Boolean(busy)}
                  >
                    Detener
                  </button>
                )}
              </article>
            ))
          ) : (
            <div className="empty-state">La primera ejecución aparecerá aquí.</div>
          )}
        </div>
      </section>
    </main>
  );
}
