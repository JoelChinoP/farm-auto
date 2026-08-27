"use client";

import {
  FormEvent,
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

const requiredAutomations = 3;

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
      "open-social-content": "Abrir contenido",
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

export function ControlPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [platform, setPlatform] = useState<"tiktok" | "facebook">("tiktok");
  const [contentUrl, setContentUrl] = useState("");
  const [draftKind, setDraftKind] = useState<
    "social_comment" | "direct_message"
  >("social_comment");
  const [context, setContext] = useState("");
  const [intent, setIntent] = useState("");
  const [tone, setTone] = useState("casual");
  const [activeDraft, setActiveDraft] = useState<Draft | null>(null);
  const [draftText, setDraftText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [consent, setConsent] = useState(false);

  const refresh = useEffectEvent(async () => {
    try {
      const data = await api<Snapshot>("/api/status");
      startTransition(() => {
        setSnapshot(data);
        setSelectedDevice((current) =>
          data.devices.some((device) => device.id === current)
            ? current
            : data.devices.find((device) => device.state === "device")?.id || "",
        );
        setActiveDraft((current) =>
          current
            ? data.drafts.find((draft) => draft.id === current.id) || current
            : current,
        );
      });
    } catch {
      startTransition(() => setSnapshot(null));
    }
  });

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, []);

  const device = snapshot?.devices.find((item) => item.id === selectedDevice);
  const setupCount =
    snapshot?.automations.filter((item) => item.device_id === selectedDevice)
      .length ?? 0;
  const isReady = setupCount >= requiredAutomations;

  async function run(
    name: string,
    action: () => Promise<unknown>,
    successMessage: string,
  ) {
    setBusy(name);
    setNotice(null);
    try {
      await action();
      setNotice({ type: "success", text: successMessage });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Ocurrió un error.",
      });
    } finally {
      setBusy(null);
    }
  }

  function requireDevice() {
    if (!selectedDevice) throw new Error("Selecciona un dispositivo conectado.");
    return selectedDevice;
  }

  async function prepareDevice() {
    await run(
      "setup",
      () =>
        api("/api/setup", {
          method: "POST",
          body: JSON.stringify({ deviceId: requireDevice() }),
        }),
      "Automatizaciones preparadas y dispositivo en inicio.",
    );
  }

  async function goHome() {
    await run(
      "home",
      () =>
        api("/api/automations/home", {
          method: "POST",
          body: JSON.stringify({
            deviceId: requireDevice(),
            idempotencyKey: crypto.randomUUID(),
          }),
        }),
      "El dispositivo volvió a la pantalla de inicio.",
    );
  }

  async function openContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(
      "open",
      () =>
        api("/api/automations/open-content", {
          method: "POST",
          body: JSON.stringify({
            deviceId: requireDevice(),
            idempotencyKey: crypto.randomUUID(),
            platform,
            url: contentUrl,
          }),
        }),
      "Contenido abierto. La interacción final queda en tus manos.",
    );
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(
      "generate",
      async () => {
        const result = await api<{ draft: Draft }>("/api/messages/draft", {
          method: "POST",
          body: JSON.stringify({
            kind: draftKind,
            platform: draftKind === "direct_message" ? "whatsapp" : platform,
            context,
            intent,
            tone,
          }),
        });
        setActiveDraft(result.draft);
        setDraftText(result.draft.text);
        setConsent(false);
        setRecipient("");
      },
      "Borrador generado. Revísalo antes de aprobar.",
    );
  }

  async function approve() {
    if (!activeDraft) return;
    await run(
      "approve",
      async () => {
        const result = await api<{ draft: Draft }>(
          `/api/messages/${activeDraft.id}/approve`,
          {
            method: "PUT",
            body: JSON.stringify({
              text: draftText,
              consentConfirmed: consent,
              recipient,
            }),
          },
        );
        setActiveDraft(result.draft);
      },
      "Texto aprobado y registrado.",
    );
  }

  async function copyApproved() {
    if (!activeDraft || activeDraft.status !== "approved") return;
    await navigator.clipboard.writeText(draftText);
    setNotice({ type: "success", text: "Texto aprobado copiado." });
  }

  async function sendMessage() {
    if (!activeDraft) return;
    await run(
      "send",
      async () => {
        await api(`/api/messages/${activeDraft.id}/send`, {
          method: "POST",
          body: JSON.stringify({ deviceId: requireDevice() }),
        });
        setActiveDraft({ ...activeDraft, status: "sent" });
      },
      "Mensaje enviado una sola vez y dispositivo devuelto a inicio.",
    );
  }

  async function stopRun(runId: string) {
    await run(
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
            <span>Operación asistida</span>
          </div>
        </div>
        <div className="system-state">
          <span className={`status-dot ${snapshot?.health.ok ? "online" : ""}`} />
          {snapshot?.health.ok ? snapshot.health.version : "GenFarmer sin conexión"}
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">Revisión humana en cada paso</p>
          <h1>Un panel claro para operar sin perder el control.</h1>
          <p className="intro-copy">
            Prepara el dispositivo, abre contenido por enlace y redacta mensajes
            naturales. Nada se publica en redes sin tu acción final.
          </p>
        </div>
        <div className="connection-card">
          <span className="connection-label">DeepSeek</span>
          <strong>{snapshot?.deepSeek.model || "Comprobando..."}</strong>
          <span className={snapshot?.deepSeek.configured ? "ok-text" : "error-text"}>
            {snapshot?.deepSeek.configured ? "Clave configurada" : "Falta API_DEEPSEEK"}
          </span>
        </div>
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

      <section className="device-strip">
        <div className="device-heading">
          <span className="section-number">01</span>
          <div>
            <h2>Dispositivo</h2>
            <p>Una tarea, un remitente, un estado conocido.</p>
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
        <div className="device-facts">
          <div>
            <span>GenFarmer</span>
            <strong>{device?.genFarmer ? "Reconocido" : "No detectado"}</strong>
          </div>
          <div>
            <span>Automatizaciones</span>
            <strong>{isReady ? "3 listas" : `${setupCount}/3`}</strong>
          </div>
          <div>
            <span>En pantalla</span>
            <strong>{device?.capabilities?.focusedPackage || "Sin lectura"}</strong>
          </div>
        </div>
        <div className="device-actions">
          <button
            type="button"
            className="button primary"
            onClick={prepareDevice}
            disabled={Boolean(busy) || !selectedDevice}
          >
            {busy === "setup" ? "Preparando..." : isReady ? "Verificar preparación" : "Preparar"}
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={goHome}
            disabled={Boolean(busy) || !isReady}
          >
            {busy === "home" ? "Volviendo..." : "Ir a inicio"}
          </button>
        </div>
      </section>

      <div className="workspace-grid">
        <section className="panel content-panel">
          <div className="panel-heading">
            <span className="section-number">02</span>
            <div>
              <h2>Abrir contenido</h2>
              <p>Enlace directo a un Live, transmisión o publicación.</p>
            </div>
          </div>
          <form onSubmit={openContent} className="stack-form">
            <div className="segmented" aria-label="Plataforma">
              <button
                type="button"
                className={platform === "tiktok" ? "active" : ""}
                onClick={() => setPlatform("tiktok")}
              >
                TikTok
                <small>{device?.capabilities?.tiktok ? "instalado" : "no instalado"}</small>
              </button>
              <button
                type="button"
                className={platform === "facebook" ? "active" : ""}
                onClick={() => setPlatform("facebook")}
              >
                Facebook
                <small>{device?.capabilities?.facebook ? "instalado" : "no instalado"}</small>
              </button>
            </div>
            <label className="field">
              <span>Enlace HTTPS</span>
              <input
                type="url"
                value={contentUrl}
                onChange={(event) => setContentUrl(event.target.value)}
                placeholder={
                  platform === "tiktok"
                    ? "https://www.tiktok.com/@cuenta/live"
                    : "https://www.facebook.com/..."
                }
                required
              />
            </label>
            <div className="guardrail">
              <strong>Interacción manual</strong>
              <p>
                El flujo abre la app después de pasar por Inicio. Likes,
                comentarios y cualquier publicación los confirma el operador.
              </p>
            </div>
            <button
              className="button primary full"
              disabled={Boolean(busy) || !isReady}
            >
              {busy === "open" ? "Abriendo..." : `Abrir en ${platform === "tiktok" ? "TikTok" : "Facebook"}`}
            </button>
          </form>
        </section>

        <section className="panel message-panel">
          <div className="panel-heading">
            <span className="section-number">03</span>
            <div>
              <h2>Redactar mensaje</h2>
              <p>DeepSeek propone; tú editas y apruebas.</p>
            </div>
          </div>
          {!activeDraft ? (
            <form onSubmit={generate} className="stack-form">
              <div className="segmented compact" aria-label="Tipo de borrador">
                <button
                  type="button"
                  className={draftKind === "social_comment" ? "active" : ""}
                  onClick={() => setDraftKind("social_comment")}
                >
                  Comentario
                </button>
                <button
                  type="button"
                  className={draftKind === "direct_message" ? "active" : ""}
                  onClick={() => setDraftKind("direct_message")}
                >
                  WhatsApp
                </button>
              </div>
              <label className="field">
                <span>Contexto real</span>
                <textarea
                  value={context}
                  onChange={(event) => setContext(event.target.value)}
                  placeholder="¿Qué está ocurriendo y a quién va dirigido?"
                  rows={3}
                  required
                />
              </label>
              <label className="field">
                <span>Intención</span>
                <input
                  value={intent}
                  onChange={(event) => setIntent(event.target.value)}
                  placeholder="Ej. agradecer y hacer una pregunta breve"
                  required
                />
              </label>
              <label className="field">
                <span>Tono</span>
                <select value={tone} onChange={(event) => setTone(event.target.value)}>
                  <option value="casual">Casual</option>
                  <option value="amable">Amable</option>
                  <option value="curioso">Curioso</option>
                  <option value="entusiasta">Entusiasta</option>
                </select>
              </label>
              <button
                className="button ink full"
                disabled={Boolean(busy) || !snapshot?.deepSeek.configured}
              >
                {busy === "generate" ? "Redactando..." : "Generar borrador"}
              </button>
            </form>
          ) : (
            <div className="draft-review">
              <div className="draft-meta">
                <span className={`pill ${activeDraft.status}`}>
                  {friendlyStatus(activeDraft.status)}
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setActiveDraft(null);
                    setDraftText("");
                  }}
                >
                  Nuevo borrador
                </button>
              </div>
              <label className="field">
                <span>Texto editable</span>
                <textarea
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  rows={5}
                  disabled={["sent", "failed"].includes(activeDraft.status)}
                />
              </label>
              {activeDraft.kind === "direct_message" && (
                <>
                  <label className="field">
                    <span>Número internacional, sin +</span>
                    <input
                      inputMode="numeric"
                      value={recipient}
                      onChange={(event) => setRecipient(event.target.value)}
                      placeholder="51987654321"
                      disabled={activeDraft.status !== "draft"}
                    />
                  </label>
                  <label className="consent-check">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(event) => setConsent(event.target.checked)}
                      disabled={activeDraft.status !== "draft"}
                    />
                    <span>
                      Confirmo que esta persona aceptó recibir este mensaje.
                    </span>
                  </label>
                </>
              )}
              {activeDraft.error && <p className="inline-error">{activeDraft.error}</p>}
              <div className="review-actions">
                {activeDraft.status === "draft" && (
                  <button
                    type="button"
                    className="button primary"
                    onClick={approve}
                    disabled={Boolean(busy)}
                  >
                    {busy === "approve" ? "Aprobando..." : "Aprobar texto"}
                  </button>
                )}
                {activeDraft.status === "approved" &&
                  activeDraft.kind === "social_comment" && (
                    <button type="button" className="button ink" onClick={copyApproved}>
                      Copiar aprobado
                    </button>
                  )}
                {activeDraft.status === "approved" &&
                  activeDraft.kind === "direct_message" && (
                    <button
                      type="button"
                      className="button danger"
                      onClick={sendMessage}
                      disabled={Boolean(busy) || !isReady || !device?.capabilities?.whatsapp}
                    >
                      {busy === "send" ? "Enviando..." : "Enviar una vez"}
                    </button>
                  )}
              </div>
              {activeDraft.kind === "direct_message" && !device?.capabilities?.whatsapp && (
                <p className="helper-text">
                  WhatsApp no está instalado en este dispositivo. El envío queda
                  bloqueado; el borrador y su aprobación sí se conservan.
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      <section className="activity">
        <div className="activity-heading">
          <div>
            <p className="eyebrow">Auditoría local</p>
            <h2>Actividad reciente</h2>
          </div>
          <span>SQLite · {snapshot ? new Date(snapshot.polledAt).toLocaleTimeString("es-PE") : "--:--"}</span>
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
