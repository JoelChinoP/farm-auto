"use client";

import {
  FormEvent,
  ReactNode,
  startTransition,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";

import {
  facebookIntentOptions,
  facebookToneOptions,
} from "@/lib/facebook-copy-options";

type Device = {
  id: string;
  state: string;
  model: string;
  profile: null | {
    hardware_id: string;
    device_id: string;
    alias: string;
    physical_order: number;
    system_port: number;
  };
  capabilities: null | {
    tiktok: boolean;
    facebook: boolean;
    hardwareId: string;
    focusedPackage: string | null;
  };
};

type Draft = {
  id: string;
  kind: "social_comment";
  platform: "tiktok" | "facebook";
  text: string;
  status: "draft" | "approved" | "running" | "sent" | "failed" | "outcome_unknown";
  error: string | null;
  created_at: string;
  sent_at: string | null;
};

type Operation = {
  id: string;
  kind: string;
  status: "starting" | "running" | "succeeded" | "failed" | "cancelled";
  device_id: string;
  error: string | null;
  created_at: string;
};

type FacebookBrowserSnapshot = {
  status: "closed" | "login_required" | "ready" | "extracting";
  browserOpen: boolean;
  loggedIn: boolean;
  extracting: boolean;
  lastError: string | null;
};

type Snapshot = {
  health: { ok: boolean; version: string | null };
  deepSeek: { configured: boolean; model: string };
  facebookBrowser: FacebookBrowserSnapshot;
  setup: {
    revision: number;
    devices: Array<{
      device_id: string;
      status: "running" | "ready" | "not_ready";
      problem: string | null;
      setup_revision: number;
      updated_at: string;
    }>;
  };
  devices: Device[];
  drafts: Draft[];
  operations: Operation[];
  facebookBatch: FacebookBatch | null;
  polledAt: string;
};

type FacebookAssignment = {
  id: string;
  device_id: string;
  intent: string;
  tone: (typeof tones)[number][0];
  status:
    | "pending"
    | "generating"
    | "draft"
    | "approved"
    | "running"
    | "sent"
    | "failed"
    | "outcome_unknown";
  error: string | null;
  round_index: number | null;
  sequence_index: number | null;
  draft: Draft | null;
};

type FacebookPost = {
  id: string;
  position: number;
  url: string;
  extracted_context: string | null;
  context: string | null;
  status:
    | "queued"
    | "extracting"
    | "context_ready"
    | "generating"
    | "drafts_ready"
    | "approving"
    | "approved"
    | "running"
    | "completed"
    | "partial_failed"
    | "outcome_unknown"
    | "skipped";
  error: string | null;
  updated_at: string;
  planned_device_ids: string[];
  assignments: FacebookAssignment[];
};

type FacebookBatch = {
  id: string;
  status: "active" | "completed" | "cancelled";
  plan_version: "legacy" | "rotation_v1";
  current_round: number;
  total_rounds: number;
  execution_status: "idle" | "running";
  next_execution_at: string | null;
  execution_started: boolean;
  device_ids: string[];
  progress: {
    prepared_posts: number;
    completed_assignments: number;
    total_assignments: number;
  };
  posts: FacebookPost[];
};

type FacebookAllocation = {
  id: string;
  intent: string;
  tone: (typeof tones)[number][0];
  count: number;
};

type ApiPayload<T> = {
  success: boolean;
  data: T;
  code?: string;
  message?: string;
};

type SetupResult = {
  status: "pending" | "running" | "ready" | "not_ready";
  problem: string | null;
};

type AutomationSlug =
  | "device-home"
  | "open-social-content"
  | "facebook-post-like-comment"
  | "tiktok-live-tap-tap"
  | "tiktok-post-like-comment";

type AutomationDefinition = {
  slug: AutomationSlug;
  code: string;
  group: string;
  title: string;
  description: string;
  accent: "system" | "neutral" | "facebook" | "live" | "tiktok";
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

const automationDefinitions: AutomationDefinition[] = [
  {
    slug: "device-home",
    code: "HM",
    group: "Sistema",
    title: "Pantalla de inicio",
    description: "Cierra el contexto actual y deja Android en un estado conocido.",
    accent: "system",
  },
  {
    slug: "open-social-content",
    code: "AB",
    group: "Navegación",
    title: "Abrir contenido",
    description: "Abre un enlace sin dar like, comentar ni enviar nada.",
    accent: "neutral",
  },
  {
    slug: "facebook-post-like-comment",
    code: "FB",
    group: "Facebook",
    title: "Like y comentario",
    description: "Borrador, aprobación y publicación exclusiva para Facebook.",
    accent: "facebook",
  },
  {
    slug: "tiktok-live-tap-tap",
    code: "LV",
    group: "TikTok Live",
    title: "Tap tap controlado",
    description: "Rondas y coordenadas propias para una transmisión en vivo.",
    accent: "live",
  },
  {
    slug: "tiktok-post-like-comment",
    code: "TK",
    group: "TikTok",
    title: "Like y comentario",
    description: "Borrador, aprobación y publicación exclusiva para TikTok.",
    accent: "tiktok",
  },
];

const tones = facebookToneOptions;

async function api<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Control-Panel-Client": "control-panel",
      ...init?.headers,
    },
  });
  const payload = (await response.json()) as ApiPayload<T>;
  if (!response.ok || !payload.success) {
    const message = payload.message || "No se pudo completar la acción.";
    throw new Error(payload.code ? `${message} [${payload.code}]` : message);
  }
  return payload.data;
}

function friendlyAction(kind: string) {
  return (
    {
      "device-home": "Pantalla de inicio",
      "facebook-post-like-comment": "Like y comentario en Facebook",
      "facebook-context-extract": "Extraer contexto de Facebook",
      "open-social-content": "Abrir contenido",
      "tiktok-live-tap-tap": "Tap tap en TikTok Live",
      "tiktok-post-like-comment": "Like y comentario en TikTok",
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
      cancelled: "Cancelada",
      draft: "Borrador",
      approved: "Aprobado",
      outcome_unknown: "Verificación manual",
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
          <span className={`pill ${ready ? "succeeded" : "failed"}`}>
            {ready ? "Lista para ejecutar" : "Preparación pendiente"}
          </span>
          {latest && (
            <span className={`last-run ${latest.status}`}>
              Última ejecución: {friendlyStatus(latest.status)}
            </span>
          )}
          <HelpTip label={`Detalles técnicos de ${definition.title}`}>
            <li>Flujo TypeScript ejecutado mediante Appium.</li>
            <li>El estado depende del dispositivo seleccionado.</li>
          </HelpTip>
        </div>
      </header>
      {children}
    </section>
  );
}

function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className="help-tip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open && (
        <span id={id} role="tooltip" className="help-tip-content">
          <strong>{label}</strong>
          <ul>{children}</ul>
        </span>
      )}
    </span>
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
          aria-current={Number(step) === current ? "step" : undefined}
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
            <Requirement ok={props.ready}>Preparación Appium</Requirement>
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
          <div className="platform-choice" role="group" aria-label="Plataforma objetivo">
            <button
              type="button"
              className={platform === "tiktok" ? "active tiktok" : "tiktok"}
              onClick={() => setPlatform("tiktok")}
              aria-pressed={platform === "tiktok"}
            >
              <span>TK</span>
              <strong>TikTok</strong>
              <small>{props.device?.capabilities?.tiktok ? "Instalado" : "No instalado"}</small>
            </button>
            <button
              type="button"
              className={platform === "facebook" ? "active facebook" : "facebook"}
              onClick={() => setPlatform("facebook")}
              aria-pressed={platform === "facebook"}
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
            <Requirement ok={props.ready}>Preparación Appium</Requirement>
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
        ? 4
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
                  disabled={["running", "sent", "failed", "outcome_unknown"].includes(activeDraft.status)}
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

function facebookPostStatus(status: FacebookPost["status"]) {
  return (
    {
      queued: "Pendiente",
      extracting: "Extrayendo contexto",
      context_ready: "Contexto listo",
      generating: "Generando",
      drafts_ready: "En revisión",
      approving: "Aprobando",
      approved: "Aprobada",
      running: "Ejecutando",
      completed: "Completada",
      partial_failed: "Requiere atención",
      outcome_unknown: "Verificación manual",
      skipped: "Omitida",
    }[status] || status
  );
}

function allocationsFromAssignments(
  assignments: FacebookAssignment[],
  defaultCount: number,
): FacebookAllocation[] {
  if (!assignments.length) {
    return [
      {
        id: "allocation-primary",
        intent: "Crítica Constructiva",
        tone: "casual",
        count: Math.max(1, defaultCount),
      },
    ];
  }
  const allocations: FacebookAllocation[] = [];
  for (const assignment of assignments) {
    const existing = allocations.find(
      (allocation) =>
        allocation.intent === assignment.intent && allocation.tone === assignment.tone,
    );
    if (existing) {
      existing.count++;
    } else {
      allocations.push({
        id: `allocation-${assignment.id}`,
        intent: assignment.intent,
        tone: assignment.tone,
        count: 1,
      });
    }
  }
  return allocations;
}

function FacebookCurrentPost({
  post,
  position,
  total,
  rotation,
  rotationStarted,
  eligibleDevices,
  facebookBrowser,
  deepSeekConfigured,
  busy,
  runAction,
}: {
  post: FacebookPost;
  position: number;
  total: number;
  rotation: boolean;
  rotationStarted: boolean;
  eligibleDevices: Device[];
  facebookBrowser: FacebookBrowserSnapshot;
  deepSeekConfigured: boolean;
  busy: string | null;
  runAction: RunAction;
}) {
  const intentOptionsId = useId();
  const assignedDeviceIds = post.assignments.map((assignment) => assignment.device_id);
  const hasDevicePlan = post.planned_device_ids.length > 0;
  const initialDeviceIds = hasDevicePlan
    ? post.planned_device_ids
    : assignedDeviceIds.length
      ? assignedDeviceIds
      : eligibleDevices.map((device) => device.id);
  const [context, setContext] = useState(
    post.context || post.extracted_context || "",
  );
  const [deviceIds, setDeviceIds] = useState(initialDeviceIds);
  const [allocations, setAllocations] = useState(() =>
    allocationsFromAssignments(post.assignments, initialDeviceIds.length),
  );
  const [comments, setComments] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      post.assignments.map((assignment) => [assignment.id, assignment.draft?.text || ""]),
    ),
  );
  const [verifiedOutcomes, setVerifiedOutcomes] = useState<
    Record<string, "" | "sent" | "not_sent">
  >({});
  const [minDelaySeconds, setMinDelaySeconds] = useState("15");
  const [maxDelaySeconds, setMaxDelaySeconds] = useState("45");
  const numericMinDelay = Number(minDelaySeconds);
  const numericMaxDelay = Number(maxDelaySeconds);
  const validTiming =
    Number.isInteger(numericMinDelay) &&
    Number.isInteger(numericMaxDelay) &&
    numericMinDelay >= 1 &&
    numericMaxDelay <= 600 &&
    numericMaxDelay >= numericMinDelay;
  const allocatedCount = allocations.reduce(
    (totalCount, allocation) => totalCount + allocation.count,
    0,
  );
  const hasLockedAssignments = post.assignments.some(
    (assignment) => ["sent", "outcome_unknown"].includes(assignment.status),
  );
  const draftsComplete =
    post.assignments.length > 0 &&
    post.assignments.every((assignment) => assignment.draft);
  const missingDraftCount = post.assignments.filter(
    (assignment) => !assignment.draft,
  ).length;
  const generationStarted = post.assignments.length > 0;
  const editable = ![
    "extracting",
    "generating",
    "approving",
    "approved",
    "running",
    "completed",
    "outcome_unknown",
  ].includes(post.status) && !hasLockedAssignments;
  const configurationEditable = editable && !generationStarted;
  const eligibleDeviceIds = new Set(eligibleDevices.map((item) => item.id));
  const invalidDeviceIds = deviceIds.filter((id) => !eligibleDeviceIds.has(id));
  const invalidAssignmentIds = post.assignments
    .filter((assignment) => !["sent", "failed"].includes(assignment.status))
    .map((assignment) => assignment.device_id)
    .filter((id) => !eligibleDeviceIds.has(id));
  const pendingExecutionCount = post.assignments.filter(
    (assignment) => assignment.status === "approved",
  ).length;
  const reconcilableAssignments = post.assignments.filter((assignment) =>
    post.status === "outcome_unknown"
      ? assignment.status === "outcome_unknown"
      : assignment.status === "failed" && Boolean(assignment.draft),
  );

  function toggleDevice(deviceId: string) {
    setDeviceIds((current) => {
      const next = current.includes(deviceId)
        ? current.filter((id) => id !== deviceId)
        : [...current, deviceId];
      setAllocations((currentAllocations) =>
        currentAllocations.length === 1
          ? [
              {
                ...currentAllocations[0],
                count: Math.max(1, next.length),
              },
            ]
          : currentAllocations,
      );
      return next;
    });
  }

  function removeInvalidDevices() {
    setDeviceIds((current) => {
      const next = current.filter((id) => eligibleDeviceIds.has(id));
      setAllocations((currentAllocations) =>
        currentAllocations.length === 1
          ? [{ ...currentAllocations[0], count: Math.max(1, next.length) }]
          : currentAllocations,
      );
      return next;
    });
  }

  function updateAllocation(
    id: string,
    values: Partial<Pick<FacebookAllocation, "intent" | "tone" | "count">>,
  ) {
    setAllocations((current) =>
      current.map((allocation) =>
        allocation.id === id ? { ...allocation, ...values } : allocation,
      ),
    );
  }

  async function changeFacebookBrowser(action: "open" | "close") {
    await runAction(
      `facebook-browser-${action}`,
      () =>
        api("/api/facebook/browser", {
          method: "POST",
          body: JSON.stringify({ action }),
        }),
      action === "open"
        ? "Facebook está abierto. Completa el inicio de sesión en Edge."
        : "El navegador se cerró; la sesión quedó guardada localmente.",
    );
  }

  async function extractContext() {
    await runAction(
      "facebook-extract-context",
      () =>
        api(`/api/facebook/posts/${post.id}/extract`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
      "Se obtuvo la descripción visible de la publicación. Revísala antes de generar.",
    );
  }

  async function generateDrafts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(
      "facebook-generate-batch",
      () =>
        api(`/api/facebook/posts/${post.id}/drafts`, {
          method: "POST",
          body: JSON.stringify({
            context,
            deviceIds,
            allocations: allocations.map(({ intent, tone, count }) => ({
              intent,
              tone,
              count,
            })),
          }),
        }),
      "Generación procesada. Los borradores correctos se conservarán si algún dispositivo queda pendiente.",
    );
  }

  async function approveAll() {
    await runAction(
      "facebook-approve-batch",
      () =>
        api(`/api/facebook/posts/${post.id}/approve`, {
          method: "POST",
          body: JSON.stringify({
            comments: post.assignments.map((assignment) => ({
              assignmentId: assignment.id,
              text: comments[assignment.id] || "",
            })),
          }),
        }),
      "Todos los comentarios quedaron aprobados para sus dispositivos.",
    );
  }

  async function executeAll() {
    await runAction(
      "facebook-execute-batch",
      () =>
        api(`/api/facebook/posts/${post.id}/execute`, {
          method: "POST",
          body: JSON.stringify({
            minDelaySeconds: numericMinDelay,
            maxDelaySeconds: numericMaxDelay,
          }),
        }),
      "La publicación terminó y la cola avanzó a la siguiente URL.",
    );
  }

  async function skipPost() {
    await runAction(
      "facebook-skip-post",
      () =>
        api(`/api/facebook/posts/${post.id}/skip`, {
          method: "POST",
        }),
      "La publicación fue omitida y la cola avanzó.",
    );
  }

  async function reconcileOutcomes() {
    await runAction(
      "facebook-reconcile-post",
      () =>
        api(`/api/facebook/posts/${post.id}/reconcile`, {
          method: "POST",
          body: JSON.stringify({
            outcomes: reconcilableAssignments.map((assignment) => ({
              assignmentId: assignment.id,
              outcome: verifiedOutcomes[assignment.id],
            })),
          }),
        }),
      "La verificación manual quedó registrada para cada dispositivo.",
    );
  }

  return (
    <div className="facebook-batch-current">
      <div className="facebook-progress-card">
        <div>
          <span>{rotation ? "Publicación seleccionada" : "Publicación actual"}</span>
          <strong>{position} de {total}</strong>
        </div>
        <span className={`pill facebook-${post.status}`}>
          {facebookPostStatus(post.status)}
        </span>
      </div>

      <div className={`facebook-browser-bar ${facebookBrowser.status}`}>
        <span className="facebook-browser-mark" aria-hidden="true">FB</span>
        <div>
          <strong>
            {facebookBrowser.status === "ready"
              ? "Sesión de Facebook lista"
              : facebookBrowser.status === "extracting"
                ? "Leyendo la publicación"
                : facebookBrowser.status === "login_required"
                  ? "Completa el inicio de sesión"
                  : "Conecta una sesión de Facebook"}
          </strong>
          <small>
            {facebookBrowser.status === "ready"
              ? "El perfil local autenticado se reutilizará para abrir publicaciones."
              : facebookBrowser.status === "login_required"
                ? "Inicia sesión manualmente en la ventana de Edge; el panel lo detectará automáticamente."
                : facebookBrowser.status === "extracting"
                  ? "Edge está obteniendo únicamente el contenido de esta publicación."
                  : "Las credenciales no se guardan en el panel; Edge conserva la sesión en su perfil local."}
          </small>
          {facebookBrowser.lastError && !facebookBrowser.browserOpen && (
            <small className="facebook-browser-error">{facebookBrowser.lastError}</small>
          )}
        </div>
        <div className="facebook-browser-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => changeFacebookBrowser("open")}
            disabled={Boolean(busy) || facebookBrowser.extracting}
          >
            {busy === "facebook-browser-open"
              ? "Abriendo Edge..."
              : facebookBrowser.browserOpen
                ? "Mostrar Facebook"
                : "Abrir Facebook"}
          </button>
          {facebookBrowser.browserOpen && (
            <button
              type="button"
              className="text-button"
              onClick={() => changeFacebookBrowser("close")}
              disabled={Boolean(busy) || facebookBrowser.extracting}
            >
              {busy === "facebook-browser-close" ? "Cerrando..." : "Cerrar navegador"}
            </button>
          )}
        </div>
      </div>

      <div className="facebook-target-bar">
        <div>
          <span>URL bloqueada a esta etapa</span>
          <a href={post.url} target="_blank" rel="noreferrer">{post.url}</a>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={extractContext}
          disabled={
            Boolean(busy) ||
            !facebookBrowser.loggedIn ||
            facebookBrowser.extracting ||
            !configurationEditable
          }
        >
          {busy === "facebook-extract-context"
            ? "Leyendo descripción..."
            : "Obtener descripción"}
        </button>
      </div>

      <form className="facebook-configuration" onSubmit={generateDrafts}>
        <section className="facebook-context-panel">
          <div className="subheading">
            <span>01</span>
            <div>
              <strong>Descripción editable</strong>
              <small>Texto visible de la publicación leído desde la sesión local de Facebook.</small>
            </div>
          </div>
          <label className="field">
            <span>Contexto que recibirá DeepSeek</span>
            <textarea
              value={context}
              onChange={(event) => setContext(event.target.value)}
              minLength={5}
              maxLength={1200}
              rows={7}
              placeholder="Extrae el contexto o descríbelo manualmente."
              disabled={!configurationEditable}
              required
            />
            <small className="field-counter">{context.length}/1200</small>
          </label>
        </section>

        <section className="facebook-devices-panel">
          <div className="subheading">
            <span>02</span>
            <div>
              <strong>Dispositivos participantes</strong>
              <small>
                {hasDevicePlan
                  ? rotation
                    ? "Todos comentarán este enlace una vez, repartidos entre las rondas."
                    : "Grupo fijado al crear la cola; cada dispositivo participa en un solo enlace."
                  : "Solo conectados, con Facebook y preparación Appium vigente."}
              </small>
            </div>
          </div>
          <div className="facebook-device-list">
            {eligibleDevices.length ? (
              eligibleDevices.map((device) => (
                <label key={device.id} className="facebook-device-option">
                  <input
                    type="checkbox"
                    checked={deviceIds.includes(device.id)}
                    onChange={() => toggleDevice(device.id)}
                    disabled={!configurationEditable || hasDevicePlan}
                  />
                  <span>
                    <strong>{device.model}</strong>
                    <small>{device.id}</small>
                  </span>
                </label>
              ))
            ) : (
              <p className="inline-error">No hay dispositivos Facebook listos.</p>
            )}
          </div>
          <div className="facebook-device-total">
            <span>Seleccionados</span>
            <strong>{deviceIds.length}</strong>
          </div>
          {invalidDeviceIds.length > 0 && (
            <div className="inline-error invalid-device-warning">
              <span>
                {invalidDeviceIds.length} dispositivo(s) dejaron de estar listos. Esto no impide
                generar o aprobar textos; deberán estar listos antes de ejecutar la rotación.
              </span>
              {configurationEditable && !hasDevicePlan && (
                <button type="button" className="text-button" onClick={removeInvalidDevices}>
                  Retirar no listos
                </button>
              )}
            </div>
          )}
        </section>

        <section className="facebook-allocation-panel">
          <div className="subheading">
            <span>03</span>
            <div>
              <strong>Distribución de intención y tono</strong>
              <small>La cantidad total debe cubrir exactamente los dispositivos elegidos.</small>
            </div>
          </div>
          <div className="facebook-allocation-list">
            {allocations.map((allocation, index) => (
              <div className="facebook-allocation-row" key={allocation.id}>
                <label className="field">
                  <span>Intención {index + 1}</span>
                  <input
                    list={intentOptionsId}
                    value={allocation.intent}
                    onChange={(event) =>
                      updateAllocation(allocation.id, { intent: event.target.value })
                    }
                    minLength={3}
                    maxLength={300}
                    disabled={!configurationEditable}
                    required
                  />
                  <small>
                    {facebookIntentOptions.find(
                      ([value]) => value === allocation.intent,
                    )?.[1] || "Intención personalizada."}
                  </small>
                </label>
                <label className="field">
                  <span>Tono</span>
                  <select
                    value={allocation.tone}
                    onChange={(event) =>
                      updateAllocation(allocation.id, {
                        tone: event.target.value as FacebookAllocation["tone"],
                      })
                    }
                    disabled={!configurationEditable}
                  >
                    {tones.map(([value, label]) => (
                      <option value={value} key={value}>{label}</option>
                    ))}
                  </select>
                  <small>{tones.find(([value]) => value === allocation.tone)?.[2]}</small>
                </label>
                <label className="field">
                  <span>Cantidad</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={allocation.count}
                    onChange={(event) =>
                      updateAllocation(allocation.id, {
                        count: Number(event.target.value),
                      })
                    }
                    disabled={!configurationEditable}
                    required
                  />
                </label>
                {allocations.length > 1 && configurationEditable && (
                  <button
                    type="button"
                    className="text-button danger-text"
                    onClick={() =>
                      setAllocations((current) =>
                        current.filter((item) => item.id !== allocation.id),
                      )
                    }
                  >
                    Quitar
                  </button>
                )}
              </div>
            ))}
          </div>
          <datalist id={intentOptionsId}>
            {facebookIntentOptions.map(([value, description]) => (
              <option value={value} key={value}>{description}</option>
            ))}
          </datalist>
          {configurationEditable && (
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                setAllocations((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    intent: "Elogio o Apoyo",
                    tone: "dulce-calido",
                    count: 1,
                  },
                ])
              }
            >
              Agregar intención
            </button>
          )}
          <div className={`facebook-allocation-total ${allocatedCount === deviceIds.length ? "ok" : "mismatch"}`}>
            <span>Distribuidos {allocatedCount} / {deviceIds.length}</span>
            <strong>{allocatedCount === deviceIds.length ? "Coincide" : "Ajusta cantidades"}</strong>
          </div>
          {editable && !draftsComplete && (
            <button
              className="button ink full"
              disabled={
                Boolean(busy) ||
                !deepSeekConfigured ||
                context.trim().length < 5 ||
                !deviceIds.length ||
                allocatedCount !== deviceIds.length
              }
            >
              {busy === "facebook-generate-batch"
                ? `Generando ${missingDraftCount || deviceIds.length} comentario(s)...`
                : generationStarted
                  ? `Reintentar ${missingDraftCount} comentario(s) pendiente(s)`
                  : "Generar un comentario por dispositivo"}
            </button>
          )}
        </section>
      </form>

      {post.assignments.length > 0 && (
        <section className="facebook-review-panel">
          <div className="subheading">
            <span>04</span>
            <div>
              <strong>Revisión por dispositivo</strong>
              <small>Cada comentario corresponde a una llamada y un borrador independientes.</small>
            </div>
          </div>
          <div className="facebook-comment-list">
            {post.assignments.map((assignment) => (
              <article className="facebook-comment-card" key={assignment.id}>
                <header>
                  <div>
                    <strong>{assignment.device_id}</strong>
                    <span>{assignment.intent} · {assignment.tone}</span>
                  </div>
                  <span className={`pill ${assignment.status}`}>
                    {assignment.status === "draft"
                      ? "Borrador"
                      : assignment.status === "sent"
                        ? "Enviado"
                        : assignment.status === "failed"
                          ? "Falló"
                          : assignment.status === "outcome_unknown"
                            ? "Verificar"
                          : assignment.status === "approved"
                            ? "Aprobado"
                            : assignment.status === "running"
                              ? "Ejecutando"
                              : "Generando"}
                  </span>
                </header>
                {assignment.draft ? (
                  <label className="field">
                    <span>Comentario</span>
                    <textarea
                      value={comments[assignment.id] || ""}
                      onChange={(event) =>
                        setComments((current) => ({
                          ...current,
                          [assignment.id]: event.target.value,
                        }))
                      }
                      minLength={2}
                      maxLength={500}
                      rows={3}
                      disabled={[
                        "approved",
                        "running",
                        "sent",
                        "failed",
                        "outcome_unknown",
                      ].includes(assignment.status)}
                    />
                  </label>
                ) : (
                  <p className="inline-error">No se generó un borrador para este dispositivo.</p>
                )}
                {assignment.error && <p className="inline-error">{assignment.error}</p>}
                {reconcilableAssignments.some((item) => item.id === assignment.id) && (
                  <label className="field">
                    <span>Resultado observado en Facebook</span>
                    <select
                      value={verifiedOutcomes[assignment.id] || ""}
                      onChange={(event) =>
                        setVerifiedOutcomes((current) => ({
                          ...current,
                          [assignment.id]: event.target.value as "" | "sent" | "not_sent",
                        }))
                      }
                    >
                      <option value="">Selecciona después de verificar</option>
                      <option value="sent">El comentario sí aparece</option>
                      <option value="not_sent">El comentario no aparece</option>
                    </select>
                  </label>
                )}
              </article>
            ))}
          </div>

          {post.status === "drafts_ready" && (
            <div className="facebook-approval-bar">
              <div>
                <strong>Revisión humana obligatoria</strong>
                <span>Ningún dispositivo ejecutará una acción hasta aprobar todos los textos.</span>
              </div>
              <button
                type="button"
                className="button primary"
                onClick={approveAll}
                disabled={
                  Boolean(busy) ||
                  !draftsComplete ||
                  post.assignments.some(
                    (assignment) => (comments[assignment.id] || "").trim().length < 2,
                  )
                }
              >
                {busy === "facebook-approve-batch" ? "Aprobando..." : "Aprobar todos los comentarios"}
              </button>
            </div>
          )}

          {post.status === "approved" && !rotation && (
            <div className="facebook-execution-bar">
              <div>
                <strong>Ejecución escalonada</strong>
                <span>
                  {pendingExecutionCount} dispositivo(s) se ejecutarán uno por uno, con una pausa
                  aleatoria antes del siguiente.
                </span>
              </div>
              <div className="facebook-execution-controls">
                <div className="facebook-timing-grid">
                  <label className="field">
                    <span>Pausa mínima</span>
                    <input
                      type="number"
                      min={1}
                      max={600}
                      step={1}
                      value={minDelaySeconds}
                      onChange={(event) => setMinDelaySeconds(event.target.value)}
                      disabled={Boolean(busy)}
                    />
                    <small>segundos</small>
                  </label>
                  <label className="field">
                    <span>Pausa máxima</span>
                    <input
                      type="number"
                      min={1}
                      max={600}
                      step={1}
                      value={maxDelaySeconds}
                      onChange={(event) => setMaxDelaySeconds(event.target.value)}
                      disabled={Boolean(busy)}
                    />
                    <small>segundos</small>
                  </label>
                </div>
                <button
                  type="button"
                  className="button danger"
                  onClick={executeAll}
                  disabled={
                    Boolean(busy) ||
                    invalidAssignmentIds.length > 0 ||
                    !validTiming
                  }
                >
                  {busy === "facebook-execute-batch"
                    ? "Ejecutando en secuencia..."
                    : "Ejecutar con pausas aleatorias"}
                </button>
              </div>
              {invalidAssignmentIds.length > 0 && (
                <div className="inline-error invalid-device-warning">
                  <span>
                    Hay {invalidAssignmentIds.length} dispositivo(s) no listos. Prepáralos antes
                    de ejecutar o continúa con la siguiente publicación.
                  </span>
                  <button type="button" className="text-button" onClick={skipPost}>
                    Omitir publicación
                  </button>
                </div>
              )}
            </div>
          )}

          {reconcilableAssignments.length > 0 && (
            <div className="facebook-reconciliation-bar">
              <div>
                <strong>Verificación manual requerida</strong>
                <span>Revisa cada dispositivo y registra si el comentario aparece en Facebook.</span>
              </div>
              <button
                type="button"
                className="button primary"
                onClick={reconcileOutcomes}
                disabled={
                  Boolean(busy) ||
                  reconcilableAssignments.some(
                    (assignment) => !verifiedOutcomes[assignment.id],
                  )
                }
              >
                {busy === "facebook-reconcile-post" ? "Guardando..." : "Guardar verificación"}
              </button>
            </div>
          )}
        </section>
      )}

      {post.error && <div className="facebook-post-error">{post.error}</div>}
      {post.status === "partial_failed" && (
        <div className="facebook-skip-bar">
          <span>
            {rotationStarted
              ? "La rotación ya publicó acciones; conserva esta cola y revisa sus resultados."
              : "Corrige y regenera si aún no hubo envíos, o avanza dejando registrados los resultados."}
          </span>
          <button
            type="button"
            className="button secondary"
            onClick={skipPost}
            disabled={Boolean(busy) || rotationStarted}
          >
            {rotationStarted ? "La rotación ya comenzó" : "Continuar con la siguiente URL"}
          </button>
        </div>
      )}
    </div>
  );
}

function FacebookBatchWorkspace(props: WorkspaceProps) {
  const [urlsText, setUrlsText] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [minDelaySeconds, setMinDelaySeconds] = useState("15");
  const [maxDelaySeconds, setMaxDelaySeconds] = useState("45");
  const [minRoundDelaySeconds, setMinRoundDelaySeconds] = useState("60");
  const [maxRoundDelaySeconds, setMaxRoundDelaySeconds] = useState("120");
  const [scheduledStepAt, setScheduledStepAt] = useState<string | null>(null);
  const [timerNow, setTimerNow] = useState(() => Date.now());
  const rotationExecutionPending = useRef(false);
  useEffect(() => {
    if (!scheduledStepAt) return;
    const interval = window.setInterval(() => setTimerNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [scheduledStepAt]);
  const batch = props.snapshot?.facebookBatch ?? null;
  const rotation = batch?.plan_version === "rotation_v1";
  const legacyCurrentPost = batch?.posts.find(
    (post) => !["completed", "skipped"].includes(post.status),
  );
  const currentPost = rotation
    ? batch?.posts.find((post) => post.id === selectedPostId) ||
      batch?.posts.find((post) => !["completed", "skipped"].includes(post.status)) ||
      batch?.posts[0]
    : legacyCurrentPost;
  const latest = latestOperation(props.snapshot, props.definition.slug, props.selectedDevice);
  const prepared = new Set(
    props.snapshot?.setup.devices
      .filter(
        (status) =>
          status.status === "ready" &&
          status.setup_revision === props.snapshot?.setup.revision,
      )
      .map((status) => status.device_id) ?? [],
  );
  const eligibleDevices = (() => {
    const seenHardwareIds = new Set<string>();
    return props.snapshot?.devices
      .filter(
        (device) =>
          device.state === "device" &&
          Boolean(device.profile) &&
          Boolean(device.capabilities?.facebook) &&
          prepared.has(device.id),
      )
      .sort(
        (left, right) =>
          (left.profile?.physical_order ?? Number.MAX_SAFE_INTEGER) -
            (right.profile?.physical_order ?? Number.MAX_SAFE_INTEGER) ||
          left.id.localeCompare(right.id),
      )
      .filter((device) => {
        const hardwareId = device.capabilities?.hardwareId;
        if (!hardwareId || seenHardwareIds.has(hardwareId)) return false;
        seenHardwareIds.add(hardwareId);
        return true;
      }) ?? [];
  })();
  const completed = batch?.posts.filter(
    (post) => post.status === "completed" || post.status === "skipped",
  ).length ?? 0;
  const numericMinDelay = Number(minDelaySeconds);
  const numericMaxDelay = Number(maxDelaySeconds);
  const numericMinRoundDelay = Number(minRoundDelaySeconds);
  const numericMaxRoundDelay = Number(maxRoundDelaySeconds);
  const validRotationTiming =
    Number.isInteger(numericMinDelay) &&
    Number.isInteger(numericMaxDelay) &&
    Number.isInteger(numericMinRoundDelay) &&
    Number.isInteger(numericMaxRoundDelay) &&
    numericMinDelay >= 1 &&
    numericMaxDelay >= numericMinDelay &&
    numericMaxDelay <= 600 &&
    numericMinRoundDelay >= 1 &&
    numericMaxRoundDelay >= numericMinRoundDelay &&
    numericMaxRoundDelay <= 600;
  const scheduledSeconds = scheduledStepAt
    ? Math.max(0, Math.ceil((Date.parse(scheduledStepAt) - timerNow) / 1_000))
    : null;
  const showQueueForm = !batch || replacing;
  const queueUrls = Array.from(
    new Set(
      urlsText
        .split(/\r?\n/)
        .map((url) => url.trim())
        .filter(Boolean),
    ),
  );
  const devicePlanReady =
    queueUrls.length > 0 &&
    queueUrls.length <= 50 &&
    eligibleDevices.length <= 100 &&
    eligibleDevices.length > 0;
  const plannedGroups = devicePlanReady
    ? queueUrls.map((_, index) => {
        const baseSize = Math.floor(eligibleDevices.length / queueUrls.length);
        const extraDevices = eligibleDevices.length % queueUrls.length;
        const start = index * baseSize + Math.min(index, extraDevices);
        const size = baseSize + (index < extraDevices ? 1 : 0);
        return eligibleDevices.slice(start, start + size);
      })
    : [];
  const plannedRounds = devicePlanReady
    ? queueUrls.map((_, roundIndex) =>
        plannedGroups
          .map((devices, groupIndex) => ({
            linkIndex: (groupIndex + roundIndex) % queueUrls.length,
            devices,
          }))
          .sort((left, right) => left.linkIndex - right.linkIndex),
      )
    : [];
  const rotationPosts = batch?.posts.filter((post) => post.status !== "skipped") ?? [];
  const rotationPrepared = Boolean(
    rotation &&
    batch &&
    rotationPosts.length > 0 &&
    rotationPosts.every(
      (post) =>
        post.assignments.length === batch.device_ids.length &&
        post.assignments.every(
          (assignment) =>
            assignment.draft &&
            ["approved", "sent", "failed"].includes(assignment.status),
        ),
    ),
  );
  const rotationHasPending = rotationPosts.some((post) =>
    post.assignments.some((assignment) => assignment.status === "approved"),
  );

  async function createBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.runAction(
      "facebook-create-batch",
      async () => {
        await api("/api/facebook/batches", {
          method: "POST",
          body: JSON.stringify({
            urls: queueUrls,
            deviceIds: eligibleDevices.map((device) => device.id),
          }),
        });
        setReplacing(false);
        setUrlsText("");
      },
      `Rotación creada: ${eligibleDevices.length} dispositivos comentarán cada una de las ${queueUrls.length} publicaciones.`,
    );
  }

  async function executeRotation() {
    if (!batch || rotationExecutionPending.current) return;
    rotationExecutionPending.current = true;
    try {
      setScheduledStepAt(batch.next_execution_at);
      await props.runAction(
        "facebook-execute-rotation",
        async () => {
          let current = batch;
          while (current.status === "active" && current.current_round < current.total_rounds) {
            setScheduledStepAt(current.next_execution_at);
            const waitMilliseconds = current.next_execution_at
              ? Math.max(0, Date.parse(current.next_execution_at) - Date.now())
              : 0;
            if (waitMilliseconds) {
              await new Promise<void>((resolve) =>
                window.setTimeout(resolve, waitMilliseconds),
              );
            }
            setScheduledStepAt(null);
            const result = await api<{ batch: FacebookBatch }>(
              `/api/facebook/batches/${batch.id}/execute`,
              {
                method: "POST",
                body: JSON.stringify({
                  minDelaySeconds: numericMinDelay,
                  maxDelaySeconds: numericMaxDelay,
                  minRoundDelaySeconds: numericMinRoundDelay,
                  maxRoundDelaySeconds: numericMaxRoundDelay,
                }),
              },
            );
            current = result.batch;
          }
          return current;
        },
        "La rotación terminó con cada comentario verificado antes de avanzar de ronda.",
      );
    } finally {
      rotationExecutionPending.current = false;
      setScheduledStepAt(null);
    }
  }

  return (
    <WorkspaceShell {...props} latest={latest}>
      <div className="facebook-batch-workspace">
        <header className="facebook-batch-header">
          <div>
            <p className="eyebrow">{rotation ? "Rotación por rondas" : "Cola progresiva"}</p>
            <h3>
              {rotation
                ? "Cada dispositivo recorre todos los enlaces."
                : "Todos los dispositivos, repartidos entre los enlaces."}
            </h3>
            <p>
              {rotation
                ? "Los enlaces avanzan en paralelo; dentro de cada enlace los dispositivos actúan uno por uno antes de rotar."
                : "Cada dispositivo comenta una sola publicación y las ejecuciones se separan con pausas aleatorias configurables."}
            </p>
          </div>
          {batch && (
            <div className="facebook-batch-meter">
              <span>{rotation ? "Acciones" : "Progreso"}</span>
              <strong>
                {rotation
                  ? `${batch.progress.completed_assignments} / ${batch.progress.total_assignments}`
                  : `${completed} / ${batch.posts.length}`}
              </strong>
              <div>
                <span
                  style={{
                    width: `${rotation
                      ? batch.progress.total_assignments
                        ? (batch.progress.completed_assignments / batch.progress.total_assignments) * 100
                        : 0
                      : batch.posts.length
                        ? (completed / batch.posts.length) * 100
                        : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
        </header>

        {showQueueForm ? (
          <form className="facebook-queue-form" onSubmit={createBatch}>
            <div className="subheading">
              <span>URL</span>
              <div>
                <strong>Lista de publicaciones</strong>
                <small>Una URL HTTPS de Facebook por línea; se eliminan duplicados conservando el orden.</small>
              </div>
            </div>
            <label className="field">
              <span>Hasta 50 enlaces</span>
              <textarea
                value={urlsText}
                onChange={(event) => setUrlsText(event.target.value)}
                rows={8}
                placeholder={"https://www.facebook.com/share/p/...\nhttps://fb.watch/..."}
                required
              />
            </label>
            <section className="facebook-batch-device-plan">
              <div className="subheading">
                <span>ADB</span>
                <div>
                  <strong>Grupos iniciales de dispositivos</strong>
                  <small>
                    Cada ronda usa todos los dispositivos sin repetirlos y luego desplaza los grupos.
                  </small>
                </div>
              </div>
              <div className="facebook-device-list">
                {eligibleDevices.length ? (
                  eligibleDevices.map((device) => (
                    <label key={device.id} className="facebook-device-option">
                      <input type="checkbox" checked readOnly />
                      <span>
                        <strong>{device.model}</strong>
                        <small>{device.id}</small>
                      </span>
                    </label>
                  ))
                ) : (
                  <p className="inline-error">No hay dispositivos Facebook listos.</p>
                )}
              </div>
              <div className="facebook-device-total">
                <span>Dispositivos disponibles</span>
                <strong>{eligibleDevices.length}</strong>
              </div>
            </section>
            {queueUrls.length > 0 && (
              <section className="facebook-plan-preview">
                <div className="subheading">
                  <span>01</span>
                  <div>
                    <strong>Vista previa de la rotación</strong>
                    <small>El reparto conserva el orden físico y cubre cada combinación.</small>
                  </div>
                </div>
                {devicePlanReady ? (
                  <div className="facebook-round-preview-list">
                    {plannedRounds.slice(0, 3).map((round, roundIndex) => (
                      <section className="facebook-round-preview" key={roundIndex}>
                        <strong>Ronda {roundIndex + 1}</strong>
                        <div className="facebook-plan-grid">
                          {round.map(({ devices, linkIndex }) => (
                            <article key={`${roundIndex}-${linkIndex}`}>
                              <span>Enlace {linkIndex + 1}</span>
                              <strong>{devices.length} dispositivo(s)</strong>
                              <small>{devices.map((device) => device.id).join(", ")}</small>
                            </article>
                          ))}
                        </div>
                      </section>
                    ))}
                    {plannedRounds.length > 3 && (
                      <small className="facebook-round-overflow">
                        Se crearán {plannedRounds.length} rondas en total.
                      </small>
                    )}
                  </div>
                ) : (
                  <p className="inline-error">
                    {queueUrls.length > 50
                      ? "La cola admite hasta 50 enlaces."
                      : eligibleDevices.length > 100
                        ? "La cola admite hasta 100 dispositivos por lote."
                        : "Se necesita al menos un dispositivo Facebook listo."}
                  </p>
                )}
              </section>
            )}
            <div className="facebook-queue-actions">
              {batch?.status === "active" && (
                <button type="button" className="button secondary" onClick={() => setReplacing(false)}>
                  Conservar cola actual
                </button>
              )}
              <button
                className="button primary"
                disabled={Boolean(props.busy) || !devicePlanReady}
              >
                {props.busy === "facebook-create-batch" ? "Creando rotación..." : "Crear rotación de Facebook"}
              </button>
            </div>
          </form>
        ) : batch?.status !== "completed" && currentPost ? (
          <>
            <div className="facebook-queue-strip">
              <div className="facebook-queue-items" role="list" aria-label="Estado de la cola">
                {batch.posts.map((post) =>
                  rotation ? (
                    <button
                      type="button"
                      key={post.id}
                      className={`facebook-queue-item ${post.id === currentPost.id ? "current" : ""} ${post.status}`}
                      role="listitem"
                      aria-current={post.id === currentPost.id ? "step" : undefined}
                      aria-label={`Publicación ${post.position + 1}: ${facebookPostStatus(post.status)}`}
                      title={`${post.planned_device_ids.length} dispositivo(s) en ${batch.total_rounds} rondas`}
                      onClick={() => setSelectedPostId(post.id)}
                      disabled={Boolean(props.busy)}
                    >
                      {post.position + 1}
                    </button>
                  ) : (
                    <span
                      key={post.id}
                      className={`facebook-queue-item ${post.id === currentPost.id ? "current" : ""} ${post.status}`}
                      role="listitem"
                      aria-current={post.id === currentPost.id ? "step" : undefined}
                      aria-label={`Publicación ${post.position + 1}: ${facebookPostStatus(post.status)}`}
                      title={`${post.planned_device_ids.length} dispositivo(s) asignado(s)`}
                    >
                      {post.position + 1}
                    </span>
                  ),
                )}
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => setReplacing(true)}
                disabled={rotation && batch.execution_started}
                title={rotation && batch.execution_started ? "Una rotación con acciones públicas no puede reemplazarse." : undefined}
              >
                Reemplazar cola
              </button>
            </div>
            {rotation && (
              <div className="facebook-execution-bar facebook-rotation-execution">
                <div>
                  <strong>
                    {batch.execution_status === "running"
                      ? `Ejecutando ronda ${Math.min(batch.current_round + 1, batch.total_rounds)} de ${batch.total_rounds}`
                      : `Rotación ${batch.current_round} de ${batch.total_rounds} rondas completadas`}
                  </strong>
                  <span>
                    Cada petición ejecuta como máximo un dispositivo por enlace. Solo se programa
                    el siguiente paso cuando el comentario aparece en Facebook; resultados
                    inciertos o fallidos bloquean la ronda.
                    {scheduledSeconds !== null && ` Próximo paso en ${scheduledSeconds} s.`}
                  </span>
                </div>
                <div className="facebook-execution-controls">
                  <div className="facebook-timing-grid facebook-rotation-timing-grid">
                    <label className="field">
                      <span>Entre dispositivos mín.</span>
                      <input type="number" min={1} max={600} value={minDelaySeconds} onChange={(event) => setMinDelaySeconds(event.target.value)} disabled={Boolean(props.busy) || batch.execution_status === "running"} />
                      <small>segundos</small>
                    </label>
                    <label className="field">
                      <span>Entre dispositivos máx.</span>
                      <input type="number" min={1} max={600} value={maxDelaySeconds} onChange={(event) => setMaxDelaySeconds(event.target.value)} disabled={Boolean(props.busy) || batch.execution_status === "running"} />
                      <small>segundos</small>
                    </label>
                    <label className="field">
                      <span>Entre rondas mín.</span>
                      <input type="number" min={1} max={600} value={minRoundDelaySeconds} onChange={(event) => setMinRoundDelaySeconds(event.target.value)} disabled={Boolean(props.busy) || batch.execution_status === "running"} />
                      <small>segundos</small>
                    </label>
                    <label className="field">
                      <span>Entre rondas máx.</span>
                      <input type="number" min={1} max={600} value={maxRoundDelaySeconds} onChange={(event) => setMaxRoundDelaySeconds(event.target.value)} disabled={Boolean(props.busy) || batch.execution_status === "running"} />
                      <small>segundos</small>
                    </label>
                  </div>
                  <button
                    type="button"
                    className="button danger"
                    onClick={executeRotation}
                    disabled={
                      Boolean(props.busy) ||
                      batch.execution_status === "running" ||
                      !rotationPrepared ||
                      !rotationHasPending ||
                      !validRotationTiming
                    }
                  >
                    {props.busy === "facebook-execute-rotation"
                      ? "Ejecutando y verificando..."
                      : batch.current_round
                        ? "Reanudar rotación"
                        : "Ejecutar rotación verificada"}
                  </button>
                  {!rotationPrepared && (
                    <small className="inline-error">
                      Falta generar y aprobar un comentario por dispositivo en cada publicación.
                    </small>
                  )}
                </div>
              </div>
            )}
            <FacebookCurrentPost
              key={`${currentPost.id}-${currentPost.updated_at}`}
              post={currentPost}
              position={currentPost.position + 1}
              total={batch.posts.length}
              rotation={rotation}
              rotationStarted={batch.execution_started}
              eligibleDevices={eligibleDevices}
              facebookBrowser={props.snapshot?.facebookBrowser ?? {
                status: "closed",
                browserOpen: false,
                loggedIn: false,
                extracting: false,
                lastError: null,
              }}
              deepSeekConfigured={Boolean(props.snapshot?.deepSeek.configured)}
              busy={props.busy}
              runAction={props.runAction}
            />
          </>
        ) : (
          <div className="facebook-batch-complete">
            <strong>Cola completada</strong>
            <span>
              {rotation
                ? `Se cerraron ${batch?.current_round || 0} de ${batch?.total_rounds || 0} rondas; las publicaciones omitidas quedaron fuera del conteo de acciones.`
                : `Las ${batch?.posts.length || 0} publicaciones fueron procesadas u omitidas.`}
            </span>
            <button type="button" className="button primary" onClick={() => setReplacing(true)}>
              Crear una nueva cola
            </button>
          </div>
        )}
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
            <Requirement ok={props.ready}>Preparación Appium</Requirement>
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

export function ControlPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [setupDeviceIds, setSetupDeviceIds] = useState<string[]>([]);
  const [setupQuery, setSetupQuery] = useState("");
  const [setupResults, setSetupResults] = useState<Record<string, SetupResult>>({});
  const [activeAutomation, setActiveAutomation] =
    useState<AutomationSlug>("open-social-content");
  const [busy, setBusy] = useState<string | null>(null);
  const [stoppingOperation, setStoppingOperation] = useState<string | null>(null);
  const [profileAlias, setProfileAlias] = useState("");
  const [profileOrder, setProfileOrder] = useState("");
  const [profilePort, setProfilePort] = useState("");
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
        setSetupDeviceIds((current) =>
          current.filter((id) => data.devices.some((device) => device.id === id)),
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
  const orderedDevices = snapshot?.devices ?? [];
  const normalizedSetupQuery = setupQuery.trim().toLocaleLowerCase("es");
  const visibleSetupDevices = orderedDevices.filter((item) => {
    if (!normalizedSetupQuery) return true;
    return [
      item.id,
      item.model,
      item.profile?.alias,
      item.profile?.physical_order === undefined
        ? undefined
        : `#${item.profile.physical_order} ${item.profile.physical_order}`,
    ].some((value) => value?.toLocaleLowerCase("es").includes(normalizedSetupQuery));
  });

  function preparationResult(item: Device): SetupResult {
    const current = setupResults[item.id];
    if (current?.status === "pending" || current?.status === "running") return current;
    if (item.state !== "device") {
      return { status: "not_ready", problem: `ADB informa estado ${item.state}.` };
    }
    if (!item.profile) {
      return { status: "not_ready", problem: "Falta incorporar el perfil local." };
    }
    if (current) return current;
    const persisted = snapshot?.setup.devices.find((status) => status.device_id === item.id);
    if (persisted) {
      return {
        status:
          persisted.status === "ready" &&
          persisted.setup_revision !== snapshot?.setup.revision
            ? "not_ready"
            : persisted.status,
        problem: persisted.problem?.includes("task_runs.user_id")
          ? "La preparación anterior quedó obsoleta; vuelve a preparar este dispositivo."
          : persisted.problem,
      };
    }
    return { status: "not_ready", problem: "Falta validar este perfil con Appium." };
  }

  const activePreparationReady = device
    ? preparationResult(device).status === "ready"
    : false;

  function toggleSetupDevice(deviceId: string) {
    setSetupDeviceIds((current) =>
      current.includes(deviceId)
        ? current.filter((id) => id !== deviceId)
        : [...current, deviceId],
    );
  }

  function automationReady() {
    return activePreparationReady;
  }

  const runAction: RunAction = async (name, action, successMessage) => {
    setBusy(name);
    setNotice(null);
    try {
      await action();
      await loadSnapshot();
      setNotice({ type: "success", text: successMessage });
    } catch (error) {
      await loadSnapshot().catch(() => undefined);
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Ocurrió un error.",
      });
    } finally {
      setBusy(null);
    }
  };

  async function prepareDevices() {
    const queue = orderedDevices.filter((item) => setupDeviceIds.includes(item.id));
    if (!queue.length) return;

    setBusy("setup");
    setNotice(null);
    const pendingResults = Object.fromEntries(
      queue.map((item) => [
        item.id,
        { status: "pending", problem: "En espera." } satisfies SetupResult,
      ]),
    );
    setSetupResults((current) => ({ ...current, ...pendingResults }));
    let readyCount = 0;

    for (const item of queue) {
      setSetupResults((current) => ({
        ...current,
        [item.id]: {
          status: "running",
          problem: "Validando sesión Appium, jerarquía y Home.",
        },
      }));
      try {
        await api("/api/setup", {
          method: "POST",
          body: JSON.stringify({ deviceId: item.id }),
        });
        setSetupResults((current) => ({
          ...current,
          [item.id]: { status: "ready", problem: null },
        }));
        readyCount += 1;
      } catch (error) {
        setSetupResults((current) => ({
          ...current,
          [item.id]: {
            status: "not_ready",
            problem: error instanceof Error ? error.message : "Error desconocido.",
          },
        }));
      }
    }

    await loadSnapshot();
    setSetupResults((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([deviceId]) => !queue.some((item) => item.id === deviceId),
        ),
      ),
    );
    const failedCount = queue.length - readyCount;
    setNotice({
      type: failedCount ? "error" : "success",
      text: failedCount
        ? `${readyCount} listos y ${failedCount} no listos. Revisa el problema de cada dispositivo.`
        : `${readyCount} dispositivos quedaron listos.`,
    });
    setBusy(null);
  }

  async function stopOperation(operationId: string) {
    setStoppingOperation(operationId);
    setNotice(null);
    try {
      await api(`/api/operations/${operationId}`, { method: "DELETE" });
      await loadSnapshot();
      setNotice({ type: "success", text: "Operación cancelada." });
    } catch (error) {
      await loadSnapshot().catch(() => undefined);
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "No se pudo cancelar.",
      });
    } finally {
      setStoppingOperation(null);
    }
  }

  async function saveActiveProfile(event: FormEvent) {
    event.preventDefault();
    if (!device) return;
    const hardwareId = device.profile?.hardware_id || device.capabilities?.hardwareId;
    if (!hardwareId) {
      setNotice({ type: "error", text: "ADB no pudo obtener la identidad física." });
      return;
    }
    const physicalOrder = Number(
      profileOrder || String(device.profile?.physical_order ?? ""),
    );
    const systemPort = Number(
      profilePort || String(device.profile?.system_port ?? ""),
    );
    await runAction(
      "profile",
      () =>
        api("/api/device-profiles", {
          method: "POST",
          body: JSON.stringify({
            profiles: [
              {
                hardwareId,
                deviceId: device.id,
                alias: profileAlias.trim() || device.profile?.alias || device.model,
                physicalOrder,
                systemPort,
              },
            ],
          }),
        }),
      "Perfil guardado. Vuelve a preparar el dispositivo si cambió.",
    );
    setProfileAlias("");
    setProfileOrder("");
    setProfilePort("");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">AP</span>
          <div>
            <strong>Control local</strong>
            <span>Automatizaciones con revisión humana</span>
          </div>
        </div>
        <nav className="primary-nav" aria-label="Áreas del panel">
          <a
            href="#operar"
            aria-current={activeAutomation !== "facebook-post-like-comment" ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              setActiveAutomation("open-social-content");
              window.history.replaceState(null, "", "#open-social-content");
              document.getElementById("operar")?.scrollIntoView();
            }}
          >
            Operar
          </a>
          <a
            href="#operar"
            aria-current={activeAutomation === "facebook-post-like-comment" ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              setActiveAutomation("facebook-post-like-comment");
              window.history.replaceState(null, "", "#facebook-post-like-comment");
              document.getElementById("operar")?.scrollIntoView();
            }}
          >
            Facebook
          </a>
          <a href="#dispositivos">Dispositivos</a>
          <a href="#actividad">Actividad</a>
        </nav>
        <div className="system-state">
          <span className={`status-dot ${snapshot?.health.ok ? "online" : ""}`} />
          {snapshot
            ? snapshot.health.ok
              ? `Appium ${snapshot.health.version || "conectado"}`
              : "Appium sin conexión"
            : "Comprobando conexión"}
        </div>
      </header>

      <section className="command-deck" aria-labelledby="control-title">
        <div className="command-deck-heading">
          <div>
            <p className="eyebrow">Panel local de operación</p>
            <h1 id="control-title">Una acción clara por vez.</h1>
            <p>
              Elige una tarea, revisa su alcance y ejecuta solo cuando el dispositivo esté listo.
            </p>
          </div>
          <div className="assistant-state">
            <div>
              <span>Asistente de redacción</span>
              <strong>{snapshot?.deepSeek.model || "Comprobando..."}</strong>
              <small className={snapshot?.deepSeek.configured ? "ok-text" : "error-text"}>
                {snapshot?.deepSeek.configured ? "Disponible" : "No configurado"}
              </small>
            </div>
            <HelpTip label="Uso del asistente de redacción">
              <li>Solo genera borradores para revisar.</li>
              <li>Nunca publica contenido sin aprobación.</li>
            </HelpTip>
          </div>
        </div>
        <div className="device-strip compact-device-strip">
          <div className="device-heading">
            <span className="section-number">01</span>
            <div>
              <h2>Dispositivo activo</h2>
              <p>Este equipo se usa para las acciones individuales.</p>
            </div>
            <HelpTip label="Alcance del dispositivo activo">
              <li>Inicio, abrir contenido y TikTok usan este dispositivo.</li>
              <li>Facebook define sus participantes dentro de su propia campaña.</li>
            </HelpTip>
          </div>
          <label className="device-select">
            <span>Equipo conectado por ADB</span>
            <select
              value={selectedDevice}
              onChange={(event) => setSelectedDevice(event.target.value)}
            >
              {orderedDevices.length ? (
                orderedDevices.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.profile
                      ? `#${item.profile.physical_order} · ${item.profile.alias}`
                      : "Pendiente de incorporar"} · {item.id}
                  </option>
                ))
              ) : (
                <option value="">Sin dispositivos</option>
              )}
            </select>
          </label>
          <div className="device-facts compact-facts">
            <div>
              <span>Perfil</span>
              <strong>
                {device?.profile
                  ? `#${device.profile.physical_order} · ${device.profile.alias}`
                  : "Sin incorporar"}
              </strong>
            </div>
            <div>
              <span>Preparación</span>
              <strong>
                {activePreparationReady ? "Lista para ejecutar" : "Validación pendiente"}
              </strong>
            </div>
            <div>
              <span>Aplicación visible</span>
              <strong>{device?.capabilities?.focusedPackage || "Sin lectura"}</strong>
            </div>
          </div>
        </div>
      </section>

      {notice && (
        <div className={`notice ${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>
          <span>{notice.type === "success" ? "Listo" : "Atención"}</span>
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label="Cerrar">
            ×
          </button>
        </div>
      )}

      <section className="automation-console" id="operar" aria-labelledby="operations-title">
        <div className="console-heading">
          <div>
            <span className="section-number">02</span>
            <div>
              <p className="eyebrow">
                {activeAutomation === "facebook-post-like-comment"
                  ? "Campaña multidispositivo"
                  : "Operar un dispositivo"}
              </p>
              <h2 id="operations-title">
                {activeAutomation === "facebook-post-like-comment"
                  ? "Campaña Facebook"
                  : "Elige una acción"}
              </h2>
            </div>
          </div>
          <HelpTip label="Cómo usar las automatizaciones">
            <li>Completa solo los campos de la acción elegida.</li>
            <li>Las acciones públicas se revisan antes de ejecutarse.</li>
          </HelpTip>
        </div>

        <div className="automation-layout">
          <nav className="automation-nav" aria-label="Automatizaciones disponibles">
            {automationDefinitions.map((definition) => {
              const ready = automationReady();
              const available = appAvailable(definition, device);
              const availability = !ready
                ? "Sin preparar"
                : available
                  ? "Lista para ejecutar"
                  : "Aplicación no instalada";
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
                  aria-label={`${definition.title}. ${availability}.`}
                  key={definition.slug}
                >
                  <span className="nav-code">{definition.code}</span>
                  <span className="nav-copy">
                    <small>{definition.group}</small>
                    <strong>{definition.title}</strong>
                    <span className="nav-status">{availability}</span>
                  </span>
                  <span className={`nav-state ${ready && available ? "ready" : "missing"}`} aria-hidden="true" />
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
                ready: automationReady(),
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
                return <FacebookBatchWorkspace {...commonProps} key={definition.slug} />;
              }
              if (definition.slug === "tiktok-live-tap-tap") {
                return <TikTokLiveWorkspace {...commonProps} key={definition.slug} />;
              }
              return (
                <SocialCommentWorkspace
                  {...commonProps}
                  platform="tiktok"
                  key={definition.slug}
                />
              );
            })}
          </div>
        </div>
      </section>

      <section
        className="device-preparation"
        id="dispositivos"
        aria-labelledby="device-preparation-title"
      >
        <header className="preparation-heading">
          <div>
            <p className="eyebrow">Dispositivos y diagnóstico</p>
            <h2 id="device-preparation-title">Prepara solo los equipos que vas a usar</h2>
            <p>La verificación se ejecuta de uno en uno y deja el resultado junto a cada equipo.</p>
          </div>
          <strong>{setupDeviceIds.length} seleccionados</strong>
        </header>
        <div className="preparation-grid">
          <div className="setup-picker">
            <label className="field">
              <span>Buscar por orden, alias, modelo o serial</span>
              <input
                type="search"
                value={setupQuery}
                onChange={(event) => setSetupQuery(event.target.value)}
                placeholder="Ej. #7, Sala norte o 988c..."
              />
            </label>
            <div className="setup-picker-actions">
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setSetupDeviceIds((current) => [
                    ...new Set([...current, ...visibleSetupDevices.map((item) => item.id)]),
                  ])
                }
                disabled={!visibleSetupDevices.length || busy === "setup"}
              >
                Seleccionar visibles
              </button>
              <button
                type="button"
                className="text-button danger-text"
                onClick={() => setSetupDeviceIds([])}
                disabled={!setupDeviceIds.length || busy === "setup"}
              >
                Limpiar selección
              </button>
            </div>
            <div className="setup-device-list" aria-live="polite">
              {visibleSetupDevices.length ? (
                visibleSetupDevices.map((item) => {
                  const result = preparationResult(item);
                  return (
                    <label className="setup-device-option" key={item.id}>
                      <input
                        type="checkbox"
                        checked={setupDeviceIds.includes(item.id)}
                        onChange={() => toggleSetupDevice(item.id)}
                        disabled={busy === "setup" || !item.profile}
                      />
                      <span className="profile-index">
                        {item.profile ? `#${item.profile.physical_order}` : "Nuevo"}
                      </span>
                      <span className="setup-device-copy">
                        <strong>{item.profile?.alias || item.model}</strong>
                        <small>{item.id}</small>
                        <small className="preparation-problem">
                          {result.problem || "Sesión Appium, jerarquía y Home verificados."}
                        </small>
                      </span>
                      <span
                        className={`pill ${
                          result.status === "ready"
                            ? "succeeded"
                            : result.status === "not_ready"
                              ? "failed"
                              : result.status
                        }`}
                      >
                        {result.status === "ready"
                          ? "Listo"
                          : result.status === "not_ready"
                            ? "No listo"
                            : result.status === "running"
                              ? "Preparando"
                              : "Pendiente"}
                      </span>
                    </label>
                  );
                })
              ) : (
                <div className="empty-state">No hay dispositivos que coincidan con la búsqueda.</div>
              )}
            </div>
          </div>
          <aside className="setup-summary" aria-live="polite">
            <form className="profile-form" onSubmit={saveActiveProfile}>
              <strong>Perfil del dispositivo activo</strong>
              <label className="field">
                <span>Alias</span>
                <input
                  value={profileAlias}
                  onChange={(event) => setProfileAlias(event.target.value)}
                  placeholder={device?.profile?.alias || device?.model || "Equipo"}
                />
              </label>
              <div className="profile-fields">
                <label className="field">
                  <span>Orden físico</span>
                  <input
                    type="number"
                    min="0"
                    value={profileOrder}
                    onChange={(event) => setProfileOrder(event.target.value)}
                    placeholder={String(device?.profile?.physical_order ?? "")}
                    required={!device?.profile}
                  />
                </label>
                <label className="field">
                  <span>systemPort</span>
                  <input
                    type="number"
                    min="8200"
                    max="8299"
                    value={profilePort}
                    onChange={(event) => setProfilePort(event.target.value)}
                    placeholder={String(device?.profile?.system_port ?? "")}
                    required={!device?.profile}
                  />
                </label>
              </div>
              <button
                type="submit"
                className="button secondary"
                disabled={Boolean(busy) || !device}
              >
                {device?.profile ? "Actualizar perfil" : "Incorporar dispositivo"}
              </button>
            </form>
            <div>
              <span>Selección actual</span>
              <strong>
                {setupDeviceIds.length
                  ? `${setupDeviceIds.length} dispositivo${setupDeviceIds.length === 1 ? "" : "s"}`
                  : "Ningún dispositivo"}
              </strong>
              <p>
                {setupDeviceIds.length
                  ? "Se prepararán uno por uno. El resultado queda visible en cada fila."
                  : "Marca los equipos que vas a usar y después inicia la preparación."}
              </p>
            </div>
            <details className="inline-details">
              <summary>Qué verifica la preparación</summary>
              <ul>
                <li>Perfil local, conexión ADB y salud Appium.</li>
                <li>Sesión UiAutomator2, jerarquía accesible y Home.</li>
              </ul>
            </details>
            <button
              type="button"
              className="button primary"
              onClick={prepareDevices}
              disabled={Boolean(busy) || !setupDeviceIds.length}
            >
              {busy === "setup"
                ? "Preparando selección..."
                : `Preparar ${setupDeviceIds.length || ""} dispositivo${
                    setupDeviceIds.length === 1 ? "" : "s"
                  }`}
            </button>
          </aside>
        </div>
      </section>

      <section className="activity" id="actividad" aria-labelledby="activity-title">
        <div className="activity-heading">
          <div>
            <p className="eyebrow">Ejecuciones recientes</p>
            <h2 id="activity-title">Actividad</h2>
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
                  {operation.error && <small className="activity-error">{operation.error}</small>}
                </div>
                <time>{new Date(operation.created_at).toLocaleString("es-PE")}</time>
                <span className={`pill ${operation.status}`}>
                  {friendlyStatus(operation.status)}
                </span>
                {["starting", "running"].includes(operation.status) && (
                  <button
                    type="button"
                    className="text-button danger-text"
                    onClick={() => stopOperation(operation.id)}
                    disabled={stoppingOperation === operation.id}
                  >
                    {stoppingOperation === operation.id ? "Deteniendo..." : "Detener"}
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
