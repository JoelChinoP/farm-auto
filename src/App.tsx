import { useEffect, useRef, useState } from 'react'
import './App.css'

type Platform = 'facebook' | 'tiktok'
type View = 'devices' | Platform | 'submissions'
type Tone = 'Cercano' | 'Entusiasta' | 'Informativo' | 'Breve'
type Actions = { like: boolean; comment: boolean; share: boolean }
type Device = { id: string; serial: string; connectionId: string; name: string; order: number; connected: boolean }
type Settings = { genfarmerUrl: string; workflows: Record<'open-content' | Platform, boolean> }
type Distribution = { id: string; intention: string; tone: Tone; count: number }
type CommentProfile = { deviceId: string; intention: string; tone: Tone }
type Publication = { url: string; context: string; aiContext: string; comments: Record<string, string> }
type DraftPublication = Publication & { extracting: boolean; error: string; generating: boolean; generateError: string }
type Campaign = {
  deviceIds: string[]
  urls: string
  publications: DraftPublication[]
  actions: Actions
  distribution: Distribution[]
  prepared: boolean
  reviewed: boolean
  schedule: string
}
type Submission = {
  id: string
  deviceId: string
  deviceName: string
  deviceOrder: number
  platform: Platform
  kind: 'open' | 'actions'
  url: string
  scheduledAt: number | null
  status: 'scheduled' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled'
  taskId: string | null
  runId: string | null
  error: string | null
  createdAt: number
}
type PublicationPayload = { url: string; context: string; comments: Record<string, string> }
type SubmissionRequest = {
  requestId: string
  platform: Platform
  kind: 'open' | 'actions'
  deviceIds: string[]
  publications: PublicationPayload[]
  actions: Actions
  scheduledAt: number | null
}
type Attempt = { request: SubmissionRequest; state: 'sending' | 'accepted' | 'uncertain' | 'rejected'; message: string }

const views: Record<View, { number: string; title: string; description: string }> = {
  devices: { number: '01', title: 'Dispositivos', description: 'Tus equipos, en el orden de GenFarmer.' },
  facebook: { number: '02', title: 'Facebook', description: 'Elige equipos. Prepara contenido. Revisa y envía.' },
  tiktok: { number: '03', title: 'TikTok', description: 'Elige equipos. Prepara contenido. Revisa y envía.' },
  submissions: { number: '04', title: 'Envíos', description: 'Actualizar para consultar el estado más reciente.' },
}
const statuses: Record<Submission['status'], string> = {
  sent: 'Enviado', failed: 'No enviado', unknown: 'Por verificar',
  scheduled: 'Programado', sending: 'Enviando', cancelled: 'Cancelado',
}
const tones: Tone[] = ['Cercano', 'Entusiasta', 'Informativo', 'Breve']
const emptyCampaign: Campaign = {
  deviceIds: [], urls: '', publications: [], actions: { like: false, comment: false, share: false },
  distribution: [{ id: 'intent-1', intention: 'Reacción natural', tone: 'Cercano', count: 0 }],
  prepared: false, reviewed: false, schedule: '',
}

function distributionTotal(distribution: Distribution[]) {
  return distribution.reduce((total, row) => total + Math.max(0, Math.floor(row.count) || 0), 0)
}

// Old panel contract: rows assign devices in order, one comment profile per device.
function deviceGroups(campaign: Campaign) {
  const groups = new Map<string, Distribution>()
  let index = 0
  for (const row of campaign.distribution) {
    const count = Math.max(0, Math.floor(row.count) || 0)
    for (let position = 0; position < count && index < campaign.deviceIds.length; position++) {
      groups.set(campaign.deviceIds[index++], row)
    }
  }
  return groups
}

function commentProfiles(campaign: Campaign): CommentProfile[] | null {
  const groups = deviceGroups(campaign)
  if (groups.size !== campaign.deviceIds.length) return null
  return campaign.deviceIds.map((deviceId) => {
    const row = groups.get(deviceId)!
    return { deviceId, intention: row.intention.trim() || 'Reacción natural', tone: row.tone }
  })
}

function syncComments(comments: Record<string, string>, deviceIds: string[]) {
  const next: Record<string, string> = {}
  for (const deviceId of deviceIds) next[deviceId] = comments[deviceId] ?? ''
  return next
}

class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function api<T>(path: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 20_000, ...init } = options
  const timeout = AbortSignal.timeout(timeoutMs)
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(typeof data?.detail === 'string' ? data.detail : `Error HTTP ${response.status}.`, response.status)
  if (!data) throw new Error('El backend no devolvió una respuesta JSON válida.')
  return data as T
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.name === 'TimeoutError') return 'El backend tardó demasiado en responder.'
  if (error instanceof TypeError) return 'No se pudo conectar con el backend.'
  return error instanceof Error ? error.message : 'No se pudo completar la solicitud.'
}

function urlProblem(urls: string[], platform: Platform, requireVideo = false) {
  if (!urls.length) return 'Añade al menos una URL.'
  if (urls.length > 10) return `Hay ${urls.length} URLs. El máximo es 10; elimina las sobrantes para continuar.`
  const domains = platform === 'facebook' ? ['facebook.com'] : ['tiktok.com']
  const invalid = urls.findIndex((value) => {
    try {
      const url = new URL(value)
      return url.protocol !== 'https:' || !!url.username || !!url.password || !!url.port || value.length > 2048 || /\s/u.test(value) || value.includes("'") || value.includes('"') || value.includes(String.fromCharCode(0)) ||
        (!(platform === 'facebook' && url.hostname === 'fb.watch') && !domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) ||
        (platform === 'tiktok' && requireVideo && !/^\/@[^/]+\/(?:video\/\d+|live)\/?$/i.test(url.pathname))
    } catch { return true }
  })
  if (invalid !== -1) return `Revisa la URL de la línea ${invalid + 1}: debe ser un enlace de ${views[platform].title}.`
  if (new Set(urls).size !== urls.length) return 'Hay URLs repetidas. Deja una sola línea por publicación.'
  return ''
}

function formatDate(value: number) {
  return new Date(value).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
}

function actionLabel(actions: Actions, platform: Platform) {
  return [actions.like && 'Like', actions.comment && 'Comentar', actions.share && (platform === 'tiktok' ? 'Repost / Compartir Live' : 'Compartir ahora (público)')].filter(Boolean).join(' · ') || 'Solo abrir contenido'
}

function App() {
  const [activeView, setActiveView] = useState<View>('devices')
  const [devices, setDevices] = useState<{ devices: Device[]; fetchedAt: number } | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [submissions, setSubmissions] = useState<{ submissions: Submission[]; serverTime: number } | null>(null)
  const [errors, setErrors] = useState({ devices: '', settings: '', submissions: '' })
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [refreshing, setRefreshing] = useState(true)
  const [campaigns, setCampaigns] = useState<Record<Platform, Campaign>>({ facebook: { ...emptyCampaign }, tiktok: { ...emptyCampaign } })
  const [attempts, setAttempts] = useState<Record<Platform, Attempt | null>>({ facebook: null, tiktok: null })
  const [cancelling, setCancelling] = useState<string[]>([])
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const requestIds = useRef(new Map<string, string>())
  const mutationBusy = useRef(false)
  const cancelRequests = useRef(new Set<string>())
  const contextRequests = useRef(new Map<string, AbortController>())
  const contextCache = useRef(new Map<string, string>())
  const contextRevision = useRef(0)
  const serverOffset = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    // Independent snapshots: a GenFarmer failure must not hide the submission ledger.
    void Promise.all([
      api<{ devices: Device[]; fetchedAt: number }>('/api/devices', { signal }).then((data) => {
        if (signal.aborted) return
        setDevices(data)
        setErrors((current) => ({ ...current, devices: '' }))
        setCampaigns((current) => {
          const next = { ...current }
          for (const platform of ['facebook', 'tiktok'] as const) {
            const ids = current[platform].deviceIds.filter((id) => data.devices.some((device) => device.id === id && device.connected))
            if (ids.length !== current[platform].deviceIds.length) next[platform] = { ...current[platform], deviceIds: ids, reviewed: false }
          }
          return next
        })
      }).catch((error: unknown) => {
        if (signal.aborted) return
        setDevices(null)
        setErrors((current) => ({ ...current, devices: errorMessage(error) }))
        setCampaigns((current) => ({
          facebook: { ...current.facebook, deviceIds: [], reviewed: false },
          tiktok: { ...current.tiktok, deviceIds: [], reviewed: false },
        }))
      }),
      api<Settings>('/api/settings', { signal }).then((data) => {
        if (signal.aborted) return
        setSettings(data)
        setErrors((current) => ({ ...current, settings: '' }))
      }).catch((error: unknown) => {
        if (signal.aborted) return
        setSettings(null)
        setErrors((current) => ({ ...current, settings: errorMessage(error) }))
      }),
      api<{ submissions: Submission[]; serverTime: number }>('/api/submissions', { signal }).then((data) => {
        if (signal.aborted) return
        serverOffset.current = data.serverTime - Date.now()
        setSubmissions(data)
        setErrors((current) => ({ ...current, submissions: '' }))
      }).catch((error: unknown) => {
        if (!signal.aborted) setErrors((current) => ({ ...current, submissions: errorMessage(error) }))
      }),
    ]).finally(() => { if (!signal.aborted) setRefreshing(false) })
    return () => controller.abort()
  }, [refreshVersion])

  useEffect(() => {
    const requests = contextRequests.current
    return () => { for (const controller of requests.values()) controller.abort() }
  }, [])

  function refresh() {
    setRefreshing(true)
    setRefreshVersion((value) => value + 1)
  }

  function navigate(view: View) {
    setActiveView(view)
    requestAnimationFrame(() => heading.current?.focus())
  }

  function updateCampaign(platform: Platform, patch: Partial<Campaign>) {
    if ('urls' in patch && platform === 'facebook') {
      contextRevision.current += 1
      for (const controller of contextRequests.current.values()) controller.abort()
      contextRequests.current.clear()
    }
    setCampaigns((current) => {
      const previous = current[platform]
      const next = { ...previous, reviewed: false, ...patch }
      if ('urls' in patch) {
        next.prepared = false
        next.publications = previous.publications.map((publication) => ({ ...publication, extracting: false }))
      }
      if (patch.deviceIds) {
        next.publications = next.publications.map((publication) => ({ ...publication, comments: syncComments(publication.comments, patch.deviceIds!) }))
        // Single default group follows the selection, as in the previous panel.
        if (previous.distribution.length === 1) next.distribution = [{ ...previous.distribution[0], count: patch.deviceIds.length }]
      }
      return { ...current, [platform]: next }
    })
  }

  function updateDistribution(platform: Platform, id: string, patch: Partial<Distribution>) {
    setCampaigns((current) => ({ ...current, [platform]: {
      ...current[platform], reviewed: false,
      distribution: current[platform].distribution.map((row) => row.id === id ? { ...row, ...patch } : row),
    } }))
  }

  function updatePublication(platform: Platform, url: string, patch: Partial<DraftPublication>) {
    setCampaigns((current) => ({ ...current, [platform]: {
      ...current[platform], reviewed: false,
      publications: current[platform].publications.map((publication) => publication.url === url ? { ...publication, ...patch } : publication),
    } }))
  }

  function updateComment(platform: Platform, url: string, deviceId: string, text: string) {
    setCampaigns((current) => ({ ...current, [platform]: {
      ...current[platform], reviewed: false,
      publications: current[platform].publications.map((publication) => publication.url === url
        ? { ...publication, comments: { ...publication.comments, [deviceId]: text } }
        : publication),
    } }))
  }

  async function extractContext(url: string) {
    const publication = campaigns.facebook.publications.find((item) => item.url === url)
    if (!publication || publication.context.trim() || contextRequests.current.has(url)) return
    const cached = contextCache.current.get(url)
    if (cached) {
      updatePublication('facebook', url, { context: cached.slice(0, 500).trim(), aiContext: cached, error: '' })
      return
    }
    const controller = new AbortController()
    const revision = contextRevision.current
    contextRequests.current.set(url, controller)
    updatePublication('facebook', url, { extracting: true, error: '' })
    try {
      const result = await api<{ url: string; context: string; source: 'metadata' }>('/api/context', {
        method: 'POST', body: JSON.stringify({ url }), signal: controller.signal,
      })
      if (controller.signal.aborted || revision !== contextRevision.current) return
      if (result.url !== url || result.source !== 'metadata' || !result.context.trim()) throw new Error('No se encontraron metadatos públicos.')
      if (result.context.length > 1000) throw new Error('El contexto supera los 1000 caracteres. Pega una versión más breve.')
      contextCache.current.set(url, result.context)
      setCampaigns((current) => ({ ...current, facebook: {
        ...current.facebook, reviewed: false,
        publications: current.facebook.publications.map((item) => item.url === url && !item.context.trim()
          ? { ...item, context: result.context.slice(0, 500).trim(), aiContext: result.context, error: '' }
          : item),
      } }))
    } catch (error) {
      if (!controller.signal.aborted && revision === contextRevision.current) updatePublication('facebook', url, { error: `${errorMessage(error)} Puedes pegar o editar el contexto.` })
    } finally {
      if (contextRequests.current.get(url) === controller) {
        contextRequests.current.delete(url)
        updatePublication('facebook', url, { extracting: false })
      }
    }
  }

  async function generateComments(platform: Platform, url: string) {
    const campaign = campaigns[platform]
    const publication = campaign.publications.find((item) => item.url === url)
    if (!publication || publication.generating || locked) return
    if (!campaign.deviceIds.length) {
      setNotice({ text: 'Selecciona al menos un dispositivo para generar sus comentarios.', error: true })
      return
    }
    const aiContext = publication.aiContext.trim() || publication.context.trim()
    if (!aiContext) {
      setNotice({ text: 'Añade el texto visible de la publicación para que la IA tenga contexto.', error: true })
      return
    }
    const profiles = commentProfiles(campaign)
    if (!profiles) {
      setNotice({ text: `La distribución debe cubrir los ${campaign.deviceIds.length} dispositivos seleccionados.`, error: true })
      return
    }
    updatePublication(platform, url, { generating: true, generateError: '' })
    try {
      const result = await api<{ comments: { deviceId: string; text: string }[] }>('/api/comments', {
        method: 'POST', timeoutMs: 90_000,
        body: JSON.stringify({ platform, context: aiContext, profiles }),
      })
      const byDevice = new Map(result.comments.map((comment) => [comment.deviceId, comment.text]))
      setCampaigns((current) => ({ ...current, [platform]: {
        ...current[platform], reviewed: false,
        publications: current[platform].publications.map((item) => {
          if (item.url !== url) return item
          const comments = { ...item.comments }
          for (const deviceId of campaign.deviceIds) {
            const text = byDevice.get(deviceId)
            if (text) comments[deviceId] = text
          }
          return { ...item, comments, generating: false, generateError: '' }
        }),
      } }))
      setNotice({ text: `${result.comments.length} comentarios generados. Revísalos antes de enviar.`, error: false })
    } catch (error) {
      updatePublication(platform, url, { generating: false, generateError: errorMessage(error) })
    }
  }

  async function send(platform: Platform, retry?: SubmissionRequest) {
    if (mutationBusy.current || refreshing) return
    const campaign = campaigns[platform]
    const hasActions = Object.values(campaign.actions).some(Boolean)
    const workflow = retry ? (retry.kind === 'open' ? 'open-content' : platform) : hasActions ? platform : 'open-content'
    if (!settings?.workflows[workflow] || !devices) return
    let request = retry
    if (!request) {
      if (!campaign.prepared || !campaign.reviewed || campaign.publications.some((publication) => publication.extracting)) return
      const urls = campaign.urls.split('\n').map((url) => url.trim()).filter(Boolean)
      const problem = urlProblem(urls, platform, hasActions)
      const deviceIds = devices.devices.filter((device) => device.connected && campaign.deviceIds.includes(device.id)).map((device) => device.id)
      if (problem || !deviceIds.length || deviceIds.length !== campaign.deviceIds.length) {
        setNotice({ text: problem || 'Selecciona de nuevo los dispositivos conectados.', error: true })
        return
      }
      const commentLimit = platform === 'tiktok' ? 150 : 500
      if (campaign.actions.comment && !commentProfiles(campaign)) {
        setNotice({ text: `La distribución debe cubrir los ${campaign.deviceIds.length} dispositivos seleccionados.`, error: true })
        return
      }
      const badComment = campaign.actions.comment && campaign.publications.some((publication) => campaign.deviceIds.some((deviceId) => {
        const text = publication.comments[deviceId] ?? ''
        return !text.trim() || text.length > commentLimit
      }))
      if (badComment || campaign.publications.some((publication) => publication.context.length > 500)) {
        setNotice({ text: `Revisa el contexto y los comentarios: un comentario por dispositivo, máximo ${commentLimit} caracteres.`, error: true })
        return
      }
      const scheduledAt = campaign.schedule ? new Date(campaign.schedule).getTime() : null
      if (scheduledAt !== null && (!Number.isFinite(scheduledAt) || scheduledAt < 0)) {
        setNotice({ text: 'Elige una fecha y hora válidas.', error: true })
        return
      }
      const payload = {
        platform, kind: hasActions ? 'actions' as const : 'open' as const, deviceIds,
        publications: campaign.publications.map(({ url, context, comments }) => ({
          url, context,
          comments: campaign.actions.comment ? Object.fromEntries(campaign.deviceIds.map((deviceId) => [deviceId, comments[deviceId] ?? ''])) : {},
        })),
        actions: { ...campaign.actions }, scheduledAt,
      }
      const signature = JSON.stringify(payload)
      const requestId = requestIds.current.get(signature) ?? crypto.randomUUID()
      requestIds.current.set(signature, requestId)
      request = { requestId, ...payload }
    }
    if (request.deviceIds.some((id) => !devices.devices.some((device) => device.id === id && device.connected))) {
      setNotice({ text: 'Hay equipos de esta solicitud sin conexión. Revisa Envíos antes de modificar el borrador.', error: true })
      return
    }
    const summary = `${views[platform].title}: ${request.deviceIds.length} equipos × ${request.publications.length} publicaciones.\n${actionLabel(request.actions, platform)}.\n${request.scheduledAt === null || request.scheduledAt <= Date.now() + serverOffset.current ? 'Ahora' : `Horario aleatorio entre ahora y ${formatDate(request.scheduledAt)}`}.`
    if (!window.confirm(`${retry ? 'Revisa Envíos y pulsa Actualizar antes de reintentar. Se usará la misma solicitud.\n\n' : ''}${summary}\n\n${request.kind === 'actions' ? 'Las acciones serán públicas. ¿Confirmar envío?' : 'Solo se abrirá el contenido, sin interacciones. ¿Confirmar envío?'}`)) return
    mutationBusy.current = true
    const body = request
    setNotice(null)
    setAttempts((current) => ({ ...current, [platform]: { request: body, state: 'sending', message: '' } }))
    try {
      const result = await api<{ submissions: Submission[] }>('/api/submissions', { method: 'POST', body: JSON.stringify(body) })
      setSubmissions((current) => current ? {
        ...current, submissions: [...result.submissions, ...current.submissions.filter((item) => !result.submissions.some((submitted) => submitted.id === item.id))],
      } : { submissions: result.submissions, serverTime: Date.now() + serverOffset.current })
      setAttempts((current) => ({ ...current, [platform]: { request: body, state: 'accepted', message: 'Solicitud registrada. Consulta su estado en Envíos.' } }))
    } catch (error) {
      const uncertain = !(error instanceof ApiError) || error.status >= 500 || error.status === 408
      setAttempts((current) => ({ ...current, [platform]: {
        request: body, state: uncertain ? 'uncertain' : 'rejected',
        message: `${errorMessage(error)}${uncertain ? ' No se confirmó la recepción. Revisa Envíos y pulsa Actualizar antes de reintentar. No se reenviará automáticamente.' : ''}`,
      } }))
    } finally {
      mutationBusy.current = false
      refresh()
    }
  }

  async function cancelSubmission(submission: Submission) {
    if (submission.status !== 'scheduled' || cancelRequests.current.has(submission.id) || refreshing || errors.submissions) return
    if (!window.confirm(`¿Cancelar el envío programado de #${submission.deviceOrder} ${submission.deviceName}?\nEsto no detiene tareas en GenFarmer.`)) return
    cancelRequests.current.add(submission.id)
    setCancelling((current) => [...current, submission.id])
    setNotice(null)
    try {
      const result = await api<{ submission: Submission }>(`/api/submissions/${encodeURIComponent(submission.id)}`, { method: 'DELETE' })
      setSubmissions((current) => current && { ...current, submissions: current.submissions.map((item) => item.id === result.submission.id ? result.submission : item) })
      setNotice({ text: `Envío ${statuses[result.submission.status].toLowerCase()}. No se detienen tareas en GenFarmer.`, error: false })
    } catch (error) {
      setNotice({ text: `${errorMessage(error)} Revisa Envíos y pulsa Actualizar.`, error: true })
    } finally {
      cancelRequests.current.delete(submission.id)
      setCancelling((current) => current.filter((id) => id !== submission.id))
      refresh()
    }
  }

  const platform = activeView === 'facebook' || activeView === 'tiktok' ? activeView : null
  const campaign = platform ? campaigns[platform] : null
  const attempt = platform ? attempts[platform] : null
  const urls = campaign?.urls.split('\n').map((url) => url.trim()).filter(Boolean) ?? []
  const connected = devices?.devices.filter((device) => device.connected) ?? []
  const hasActions = campaign ? Object.values(campaign.actions).some(Boolean) : false
  const problem = platform ? urlProblem(urls, platform, hasActions) : ''
  const workflow = hasActions && platform ? platform : 'open-content'
  const missingWorkflow = settings && !settings.workflows[workflow]
  const locked = attempt?.state === 'sending' || attempt?.state === 'accepted' || attempt?.state === 'uncertain'
  const anySending = Object.values(attempts).some((item) => item?.state === 'sending')
  const extracting = campaign?.publications.some((publication) => publication.extracting)
  const profiles = campaign ? commentProfiles(campaign) : null
  const groups = campaign ? deviceGroups(campaign) : null
  const distributionReady = !campaign?.actions.comment || (!!profiles && campaign.distribution.every((row) => row.count > 0 && !!row.intention.trim()))
  const missingComment = campaign?.actions.comment && campaign.publications.some((publication) =>
    campaign.deviceIds.some((deviceId) => !(publication.comments[deviceId] ?? '').trim()))
  const canSend = !!campaign?.prepared && campaign.reviewed && !!campaign.deviceIds.length && !problem &&
    !!devices && !!settings?.workflows[workflow] && !refreshing && !anySending && !locked && !extracting && !missingComment && distributionReady
  const genfarmerLink = settings?.genfarmerUrl && /^https?:\/\//i.test(settings.genfarmerUrl) ? settings.genfarmerUrl : null

  return (
    <div className="console-frame">
      <a className="skip-link" href="#main-content">Ir al contenido</a>
      <header className="topbar">
        <a className="brand-block" href="#devices" onClick={(event) => { event.preventDefault(); navigate('devices') }} aria-label="Farm control, dispositivos">
          <span className="brand-mark" aria-hidden="true">FA</span><span>Farm control<small>Panel local</small></span>
        </a>
        <div className="topbar-tools">
          {genfarmerLink && <a href={genfarmerLink} target="_blank" rel="noreferrer">GenFarmer <span aria-hidden="true">↗</span><span className="sr-only"> (abre otra pestaña)</span></a>}
          <button className="refresh-button" onClick={refresh} disabled={refreshing} aria-label="Actualizar datos">{refreshing ? 'Actualizando…' : 'Actualizar'}<span aria-hidden="true"> ↻</span></button>
        </div>
      </header>
      <div className="console-shell">
        <nav className="side-nav" aria-label="Navegación principal">
          {(Object.keys(views) as View[]).map((view) => <button key={view} className="nav-item" aria-label={views[view].title} aria-current={activeView === view ? 'page' : undefined} onClick={() => navigate(view)}><span aria-hidden="true">{views[view].number}</span>{views[view].title}</button>)}
          <span className="nav-footer">FARM / CONTROL</span>
        </nav>
        <main className="view-stage" id="main-content" tabIndex={-1}>
          <header className="view-heading">
            <div><span className="eyebrow">CONTROL / {views[activeView].number}</span><h1 ref={heading} tabIndex={-1}>{views[activeView].title}</h1><p>{views[activeView].description}</p></div>
            {activeView === 'devices' && devices && <div className="device-total"><strong>{connected.length.toString().padStart(2, '0')}</strong><span>conectados / {devices.devices.length}</span></div>}
          </header>
          {notice && <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><p>{notice.text}</p><button className="text-button" onClick={() => setNotice(null)} aria-label="Cerrar aviso">Cerrar</button></div>}

          {activeView === 'devices' && <section className="work-section" aria-label="Inventario de dispositivos" aria-busy={refreshing}>
            {errors.devices ? <div className="empty-state error" role="alert"><h2>No se pudieron consultar los equipos</h2><p>{errors.devices}</p><p>Comprueba la conexión con GenFarmer y pulsa Actualizar. No hay equipos seleccionables.</p></div> : !devices ? <p className="empty-state" role="status">Consultando dispositivos…</p> : devices.devices.length === 0 ? <div className="empty-state"><span className="empty-number" aria-hidden="true">00</span><h2>No hay dispositivos</h2><p>GenFarmer respondió con una lista vacía. Conecta los equipos allí y pulsa Actualizar.</p></div> : <>
              <div className="section-heading"><h2>Equipos</h2><span className="field-help">Consulta: {formatDate(devices.fetchedAt)}</span></div>
              <ul className="device-list">{devices.devices.map((device) => <li key={device.id}>
                <span className="device-order">#{device.order}</span><div className="device-identity"><strong>{device.name}</strong><code>{device.serial}</code></div>
                <span className={`connection ${device.connected ? 'connected' : ''}`}><i aria-hidden="true" />{device.connected ? 'Conectado' : 'Sin conexión'}</span>
              </li>)}</ul>
            </>}
          </section>}

          {platform && campaign && <div className="campaign-view">
            <fieldset className="campaign-fields" disabled={!!locked}>
              <legend className="sr-only">Preparar envío de {views[platform].title}</legend>
              <section className="work-section setup-section">
                <div className="section-heading"><h2><span className="step-number">1</span>Prepara</h2></div>
                <div className="setup-grid">
                  <fieldset className="device-picker" disabled={refreshing || !devices}>
                    <legend>Dispositivos <span className="field-help">{campaign.deviceIds.length} seleccionados</span></legend>
                    {errors.devices ? <p className="field-error" role="alert">{errors.devices} Pulsa Actualizar para volver a elegir equipos.</p> : !devices ? <p className="field-help">Consultando dispositivos…</p> : !devices.devices.length ? <p className="field-help">GenFarmer no tiene dispositivos. Conéctalos y pulsa Actualizar.</p> : <>
                      <button className="text-button select-all" disabled={!connected.length} onClick={() => updateCampaign(platform, { deviceIds: campaign.deviceIds.length === connected.length ? [] : connected.map((device) => device.id) })}>{campaign.deviceIds.length === connected.length && connected.length ? 'Quitar selección' : 'Seleccionar conectados'}</button>
                      <div className="choice-list">{devices.devices.map((device) => <label className={`device-choice ${device.connected ? '' : 'unavailable'}`} key={device.id}>
                        <input type="checkbox" disabled={!device.connected} checked={campaign.deviceIds.includes(device.id)} onChange={() => updateCampaign(platform, { deviceIds: campaign.deviceIds.includes(device.id) ? campaign.deviceIds.filter((id) => id !== device.id) : [...campaign.deviceIds, device.id] })} />
                        <span className="device-order">#{device.order}</span><span className="device-identity"><strong>{device.name}</strong><code>{device.serial}</code>{!device.connected && <small>Sin conexión</small>}</span>
                      </label>)}</div>
                    </>}
                  </fieldset>
                  <div className="url-field">
                    <label htmlFor={`${platform}-urls`}>Publicaciones <span className="field-help">{urls.length} / 10</span></label>
                    <textarea id={`${platform}-urls`} className="url-input" value={campaign.urls} placeholder={platform === 'facebook' ? 'https://www.facebook.com/…' : 'https://www.tiktok.com/…'} onChange={(event) => updateCampaign(platform, { urls: event.target.value })} aria-describedby={`${platform}-url-help`} aria-invalid={!!urls.length && !!problem} spellCheck={false} />
                    <p id={`${platform}-url-help`} className={urls.length && problem ? 'field-error' : 'field-help'}>{urls.length && problem ? problem : 'Una URL por línea. Máximo 10.'}</p>
                    <button className="primary-button" disabled={!campaign.deviceIds.length || !!problem || !devices || refreshing} onClick={() => updateCampaign(platform, {
                      prepared: true,
                      publications: urls.map((url) => {
                        const existing = campaign.publications.find((publication) => publication.url === url)
                        const comments = syncComments(existing?.comments ?? {}, campaign.deviceIds)
                        return existing
                          ? { ...existing, comments, extracting: false, generating: false, generateError: '' }
                          : { url, context: '', aiContext: '', comments, extracting: false, error: '', generating: false, generateError: '' }
                      }),
                    })}>{campaign.prepared ? 'Actualizar revisión' : 'Preparar y revisar'}<span aria-hidden="true"> ↓</span></button>
                  </div>
                </div>
              </section>

              {campaign.prepared && <>
                <section className="work-section review-section">
                  <div className="section-heading"><h2><span className="step-number">2</span>Revisa</h2></div>
                  <fieldset className="action-picker"><legend>Acciones</legend>
                    {(['like', 'comment', 'share'] as const).map((action) => <label key={action}><input type="checkbox" checked={campaign.actions[action]} onChange={(event) => updateCampaign(platform, { actions: { ...campaign.actions, [action]: event.target.checked } })} />{action === 'like' ? 'Like' : action === 'comment' ? 'Comentar' : platform === 'tiktok' ? 'Repost' : 'Compartir ahora (público)'}</label>)}
                  </fieldset>
                  <p className="field-help">{hasActions ? 'Se enviará una sola solicitud con las acciones elegidas.' : 'Sin acciones seleccionadas, solo se abre el contenido.'}</p>
                  {campaign.actions.comment && <section className="distribution-card" aria-label="Distribución de intenciones">
                    <div className="context-heading">
                      <strong>Distribución de comentarios</strong>
                      <span className="field-help">{distributionTotal(campaign.distribution)} de {campaign.deviceIds.length} dispositivos</span>
                    </div>
                    <div className="distribution-head" aria-hidden="true"><span>Intención</span><span>Tono</span><span>Cantidad</span><span /></div>
                    {campaign.distribution.map((row) => <div className="distribution-row" key={row.id}>
                      <input aria-label="Intención" type="text" maxLength={300} value={row.intention} onChange={(event) => updateDistribution(platform, row.id, { intention: event.target.value })} />
                      <select aria-label="Tono" value={row.tone} onChange={(event) => updateDistribution(platform, row.id, { tone: event.target.value as Tone })}>{tones.map((tone) => <option key={tone} value={tone}>{tone}</option>)}</select>
                      <input aria-label="Cantidad" type="number" min={0} max={campaign.deviceIds.length} value={row.count} onChange={(event) => updateDistribution(platform, row.id, { count: Math.max(0, Math.min(campaign.deviceIds.length, Math.floor(Number(event.target.value) || 0))) })} />
                      <button className="text-button" aria-label="Eliminar intención" disabled={campaign.distribution.length === 1} onClick={() => updateCampaign(platform, { distribution: campaign.distribution.filter((item) => item.id !== row.id) })}>×</button>
                    </div>)}
                    <div className="distribution-actions">
                      <button className="text-button" onClick={() => updateCampaign(platform, { distribution: [...campaign.distribution, { id: crypto.randomUUID(), intention: 'Nueva intención', tone: 'Cercano', count: 0 }] })}>Agregar intención</button>
                      <button className="text-button" onClick={() => updateCampaign(platform, { distribution: campaign.distribution.map((row, position) => position === 0 ? { ...row, count: campaign.deviceIds.length } : row) })}>Aplicar como predeterminado</button>
                    </div>
                    {!distributionReady && <p className="field-error" role="alert">Cada grupo necesita intención y al menos 1 dispositivo; la suma debe coincidir con los {campaign.deviceIds.length} seleccionados.</p>}
                  </section>}
                  <p className="context-note">{platform === 'facebook' ? 'El texto visible verifica el destino. "Generar con IA" envía a DeepSeek el texto completo extraído (hasta 1000 caracteres), la intención y el tono.' : 'Pega el texto visible de la publicación; "Generar con IA" usa ese contexto con DeepSeek.'}</p>
                  <ol className="publication-list">{campaign.publications.map((publication, index) => <li key={publication.url}>
                    <div className="publication-heading"><span className="device-order">{String(index + 1).padStart(2, '0')}</span><a href={publication.url} target="_blank" rel="noreferrer">{publication.url}<span className="sr-only"> (abre otra pestaña)</span></a></div>
                    <div className="context-heading"><label htmlFor={`${platform}-context-${index}`}>Texto visible exacto para verificar el destino <span className="field-help">opcional · {publication.context.length}/500</span></label>
                      {platform === 'facebook' && <button className="text-button" disabled={publication.extracting || !!publication.context.trim()} onClick={() => void extractContext(publication.url)}>{publication.extracting ? 'Extrayendo…' : 'Extraer contexto'}</button>}
                    </div>
                    <textarea id={`${platform}-context-${index}`} rows={3} maxLength={500} value={publication.context} onChange={(event) => updatePublication(platform, publication.url, { context: event.target.value, error: '' })} aria-describedby={publication.error ? `${platform}-context-error-${index}` : undefined} placeholder="Pega un fragmento exacto visible en esta publicación" />
                    {publication.aiContext.length > publication.context.length && <p className="field-help">La IA usará el texto completo extraído ({publication.aiContext.length} caracteres).</p>}
                    {publication.error && <p className="field-error" role="alert" id={`${platform}-context-error-${index}`}>{publication.error}</p>}
                    {campaign.actions.comment && <div className="comment-field">
                      <div className="context-heading">
                        <span className="field-help">Un comentario por dispositivo · {platform === 'tiktok' ? 150 : 500} caracteres · una línea</span>
                        <button className="text-button" disabled={publication.generating || !!locked || !campaign.deviceIds.length} onClick={() => void generateComments(platform, publication.url)}>{publication.generating ? 'Generando…' : 'Generar con IA'}</button>
                      </div>
                      {!(publication.aiContext.trim() || publication.context.trim()) && <p className="field-help">Añade el texto visible para que la IA tenga contexto.</p>}
                      {publication.generateError && <p className="field-error" role="alert">{publication.generateError}</p>}
                      {!campaign.deviceIds.length ? <p className="field-help">Selecciona dispositivos para preparar sus comentarios.</p> : <details className="comments-details">
                        <summary>Comentarios por dispositivo <span className="field-help">{campaign.deviceIds.filter((deviceId) => (publication.comments[deviceId] ?? '').trim()).length}/{campaign.deviceIds.length} listos</span></summary>
                        <ul className="device-comments">{campaign.deviceIds.map((deviceId) => {
                        const device = devices?.devices.find((item) => item.id === deviceId)
                        const group = groups?.get(deviceId)
                        const text = publication.comments[deviceId] ?? ''
                        const prefix = `${platform}-comment-${index}-${deviceId}`
                        return <li key={deviceId} className="device-comment">
                          <span className="device-order">#{device?.order ?? '?'}</span>
                          <div className="device-comment-body">
                            <span className="field-help">{group ? `${group.intention.trim() || 'Reacción natural'} · ${group.tone}` : 'Sin grupo asignado'}</span>
                            <input id={prefix} aria-label={`Comentario para ${device?.name ?? deviceId}`} type="text" maxLength={platform === 'tiktok' ? 150 : 500} value={text} onChange={(event) => updateComment(platform, publication.url, deviceId, event.target.value.replace(/[\r\n]+/g, ' '))} placeholder="Comentario para este dispositivo" />
                          </div>
                        </li>
                      })}</ul></details>}
                    </div>}
                  </li>)}</ol>
                </section>
                <section className="work-section send-section">
                  <div className="section-heading"><h2><span className="step-number">3</span>Envía</h2></div>
                  <div className="schedule-field"><label htmlFor={`${platform}-schedule`}>Programar aleatoriamente hasta <span className="field-help">opcional</span></label><div className="schedule-input"><input id={`${platform}-schedule`} type="datetime-local" value={campaign.schedule} onChange={(event) => updateCampaign(platform, { schedule: event.target.value })} />{campaign.schedule && <button className="text-button" onClick={() => updateCampaign(platform, { schedule: '' })}>Quitar fecha</button>}</div><p className="field-help">Hora local. Cada tarea se programa al azar entre ahora y esta hora límite. Sin fecha o si ya pasó, se envía ahora. Las pendientes vencidas se envían en cuanto el equipo queda libre. Mantén el backend abierto.</p></div>
                  <label className="review-check"><input type="checkbox" checked={campaign.reviewed} disabled={extracting} onChange={(event) => updateCampaign(platform, { reviewed: event.target.checked })} />He revisado las URLs, el contexto y los comentarios.</label>
                  {missingComment && <p className="field-error">Escribe un comentario para cada dispositivo y publicación.</p>}
                  <div className="send-bar"><div><strong>{campaign.deviceIds.length} equipos <span aria-hidden="true">×</span> {campaign.publications.length} publicaciones</strong><span>{actionLabel(campaign.actions, platform)}</span></div><div className="send-buttons"><button className={hasActions ? 'secondary-button' : 'primary-button'} disabled={!canSend || hasActions} onClick={() => void send(platform)}>Abrir contenido</button><button className={hasActions ? 'primary-button' : 'secondary-button'} disabled={!canSend || !hasActions} onClick={() => void send(platform)}>Enviar acciones</button></div></div>
                </section>
              </>}
            </fieldset>
            {errors.settings ? <p className="notice error" role="alert">No se pudo consultar la configuración: {errors.settings} El envío está deshabilitado.</p> : missingWorkflow ? <p className="notice">Configura el workflow <code>{workflow}</code> en <code>backend/.env</code>.</p> : !settings && <p className="notice" role="status">Consultando configuración…</p>}
            {attempt && <section className={`attempt-result ${attempt.state === 'uncertain' || attempt.state === 'rejected' ? 'error' : ''}`} aria-label="Resultado de la solicitud">
              <p role={attempt.state === 'uncertain' || attempt.state === 'rejected' ? 'alert' : 'status'}>{attempt.state === 'sending' ? 'Enviando…' : attempt.message}</p>
              {attempt.state !== 'sending' && <div className="result-actions"><button onClick={() => navigate('submissions')}>Ver envíos</button>
                {attempt.state === 'uncertain' && <button disabled={refreshing || anySending || !devices || !settings?.workflows[attempt.request.kind === 'open' ? 'open-content' : platform]} onClick={() => void send(platform, attempt.request)}>Reintentar misma solicitud</button>}
                {attempt.state !== 'rejected' && <button className="text-button" onClick={() => {
                  if (attempt.state === 'uncertain' && !window.confirm('La solicitud anterior podría haberse recibido. Revisa Envíos antes de cambiarla: un contenido distinto creará otro envío. ¿Volver al borrador?')) return
                  setAttempts((current) => ({ ...current, [platform]: null }))
                  updateCampaign(platform, { reviewed: false })
                }}>Editar borrador</button>}
              </div>}
            </section>}
          </div>}

          {activeView === 'submissions' && <section className="work-section" aria-label="Lista de envíos" aria-busy={refreshing}>
            <div className="section-heading"><h2>Estado de envíos</h2>{submissions && <span className="field-help">Consulta: {formatDate(submissions.serverTime)}</span>}</div>
            <p className="field-help">Programado puede estar esperando la hora o el run anterior del equipo. Enviado no significa acción completada. Revisa resultados en GenFarmer.</p>
            {errors.submissions && <p className="notice error" role="alert">{errors.submissions} Pulsa Actualizar.{submissions ? ' La lista conserva la última consulta; puede estar desactualizada.' : ''}</p>}
            {!submissions ? !errors.submissions && <p className="empty-state" role="status">Consultando envíos…</p> : !submissions.submissions.length ? <div className="empty-state"><span className="empty-number" aria-hidden="true">00</span><h2>Aún no hay envíos</h2><p>Prepara contenido en Facebook o TikTok para empezar.</p></div> : <ul className="submission-list">{submissions.submissions.map((submission) => <li key={submission.id}>
              <div className="submission-main"><span className="device-order">#{submission.deviceOrder}</span><div className="submission-content"><strong>{submission.deviceName}</strong><span className="field-help">{views[submission.platform].title} / {submission.kind === 'open' ? 'Abrir contenido' : 'Acciones'}</span><a href={/^https?:\/\//i.test(submission.url) ? submission.url : undefined} target="_blank" rel="noreferrer">{submission.url}<span className="sr-only"> (abre otra pestaña)</span></a></div><span className={`submission-status status-${submission.status}`}>{statuses[submission.status]}</span></div>
              <div className="submission-meta"><time dateTime={new Date(submission.scheduledAt ?? submission.createdAt).toISOString()}>{submission.scheduledAt !== null ? 'Programación: ' : 'Creado: '}{formatDate(submission.scheduledAt ?? submission.createdAt)}</time><details><summary>Detalles</summary><dl><div><dt>ID</dt><dd>{submission.id}</dd></div>{submission.taskId && <div><dt>Task ID</dt><dd>{submission.taskId}</dd></div>}{submission.runId && <div><dt>Run ID</dt><dd>{submission.runId}</dd></div>}</dl></details>{submission.status === 'scheduled' && <button className="text-button" disabled={cancelling.includes(submission.id) || refreshing || !!errors.submissions} onClick={() => void cancelSubmission(submission)}>{cancelling.includes(submission.id) ? 'Cancelando…' : 'Cancelar envío'}</button>}</div>
              {submission.error && <p className="field-error submission-error">{submission.error}</p>}
            </li>)}</ul>}
          </section>}
        </main>
      </div>
    </div>
  )
}

export default App
