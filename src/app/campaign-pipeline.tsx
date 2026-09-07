import { Accordion, Alert, Badge, Button, Group, Select, Textarea, TextInput, Title } from "@mantine/core";

import type { CampaignDraft, ControlDispatch, ControlState, Platform, Tone } from "./control-panel.types";
import { formatDate, statusLabels, toneOptions } from "./demo-state";
import { domainLabel, shortSerial } from "./campaign-view.utils";

interface CampaignPipelineProps {
  platform: Platform;
  draft: CampaignDraft;
  state: ControlState;
  dispatch: ControlDispatch;
}

export function CampaignPipeline({ platform, draft, state, dispatch }: CampaignPipelineProps) {
  const selectedPost = draft.posts.find((post) => post.id === draft.selectedPostId) ?? draft.posts[0];
  const failedPosts = draft.posts.filter((post) => ["failed", "session_required", "intervention_required"].includes(post.contextStatus)).length;
  const needsCommentContext = draft.actions.comment;

  return (
    <section className="pipeline-section" aria-labelledby={`${platform}-pipeline-title`}>
      <div className="section-toolbar compact">
        <div>
          <span className="section-code">PIPELINE / PASO 02</span>
          <Title order={2} id={`${platform}-pipeline-title`}>{needsCommentContext ? "Contexto y comentarios" : "Referencia visible"}</Title>
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
              <button role="listitem" className="post-list-item" aria-current={selectedPost?.id === post.id ? "true" : undefined} key={post.id} onClick={() => dispatch({ type: "select-post", platform, postId: post.id })}>
                <span className="post-position">{String(post.position).padStart(2, "0")}</span>
                <span className="post-copy"><strong>{domainLabel(post.url)}</strong><small>{statusLabels[post.contextStatus]} · {draft.actions.comment ? `${ready}/${post.comments.length} comentarios listos` : "Sin comentarios"}</small>{scheduled && <time>{formatDate(scheduled)}</time>}</span>
                <span className="post-flags">{post.position === 1 && <Badge size="xs">Prioridad</Badge>}{post.error && <Badge color="red" size="xs">Error</Badge>}</span>
              </button>
            );
          })}
        </div>

        {selectedPost && (
          <article className="post-detail">
            <header className="post-detail-head">
              <div><span>PUBLICACIÓN {String(selectedPost.position).padStart(2, "0")}</span><Title order={3} title={selectedPost.url}>{domainLabel(selectedPost.url)}</Title><span className="post-url" title={selectedPost.url}>{selectedPost.url}</span></div>
              <div><Badge size="lg">{statusLabels[selectedPost.status]}</Badge><small>Estado persistido</small></div>
            </header>

            <Accordion className="detail-accordion" multiple defaultValue={["context", "comments"]}>
              <Accordion.Item value="context">
                <Accordion.Control>{needsCommentContext ? "Contexto de publicación" : "Referencia exacta del post o reel"}</Accordion.Control>
                <Accordion.Panel>
                  <div className="context-meta"><Badge color={selectedPost.contextStatus === "failed" ? "red" : "gray"}>{statusLabels[selectedPost.contextStatus]}</Badge><span>Fuente: {selectedPost.contextSource ? { extracted: "Extraído", cache: "Caché", manual: "Edición manual" }[selectedPost.contextSource] : "Pendiente"}</span>{platform === "facebook" && <span>Extracción: {formatDate(selectedPost.extractedAt)}</span>}</div>
                  {selectedPost.error && <Alert color="red" title="Extracción aislada">{selectedPost.error}</Alert>}
                  <Textarea label={needsCommentContext ? platform === "tiktok" ? "Contexto manual" : "Contexto editable" : "Texto visible para verificar"} description={needsCommentContext ? "Editar después de generar marca los comentarios como desactualizados." : "Escribe una frase exacta de al menos 5 caracteres visible en el post o reel. No se usará para generar comentarios."} minRows={4} maxRows={8} maxLength={1200} autosize value={selectedPost.context} placeholder={selectedPost.contextStatus === "extracting" ? "Extrayendo contexto…" : needsCommentContext ? "Escribe contexto manual para continuar" : "Ej.: Frase visible en la publicación"} onChange={(event) => dispatch({ type: "edit-context", platform, postId: selectedPost.id, value: event.currentTarget.value })} />
                  <Group mt="sm">
                    <Button size="compact-sm" disabled={selectedPost.context.trim().length < 5} onClick={() => dispatch({ type: "save-context", platform, postId: selectedPost.id })}>{needsCommentContext ? "Guardar edición" : "Guardar referencia"}</Button>
                    {platform === "facebook" && <Button size="compact-sm" variant="default" disabled={!selectedPost.extractedContext} onClick={() => dispatch({ type: "restore-context", platform, postId: selectedPost.id })}>Restaurar extraído</Button>}
                    {platform === "facebook" && <Button size="compact-sm" variant="light" onClick={() => dispatch({ type: "retry-context", platform, postId: selectedPost.id })}>Reintentar extracción</Button>}
                  </Group>
                </Accordion.Panel>
              </Accordion.Item>

              {draft.actions.comment && (
                <Accordion.Item value="comments">
                  <Accordion.Control>Comentarios · {selectedPost.comments.filter((item) => ["ready", "edited"].includes(item.status) && !item.stale).length}/{selectedPost.comments.length} listos</Accordion.Control>
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
                                <td><TextInput aria-label={`Intención para ${device?.alias ?? comment.deviceId}`} value={comment.intention} onChange={(event) => dispatch({ type: "update-comment-profile", platform, postId: selectedPost.id, commentId: comment.id, field: "intention", value: event.currentTarget.value })} onBlur={() => dispatch({ type: "save-comment", platform, postId: selectedPost.id, commentId: comment.id })} /><Select mt={5} aria-label={`Tono para ${device?.alias ?? comment.deviceId}`} value={comment.tone} data={toneOptions} allowDeselect={false} onChange={(value) => dispatch({ type: "update-comment-profile", platform, postId: selectedPost.id, commentId: comment.id, field: "tone", value: (value ?? "Cercano") as Tone })} onBlur={() => dispatch({ type: "save-comment", platform, postId: selectedPost.id, commentId: comment.id })} /></td>
                                <td><Textarea aria-label={`Comentario para ${device?.alias ?? comment.deviceId}`} minRows={2} maxRows={5} autosize value={comment.text} error={invalid ? "Usa entre 2 y 500 caracteres" : undefined} onChange={(event) => dispatch({ type: "edit-comment", platform, postId: selectedPost.id, commentId: comment.id, value: event.currentTarget.value })} onBlur={() => dispatch({ type: "save-comment", platform, postId: selectedPost.id, commentId: comment.id })} /></td>
                                <td><code className={comment.text.length > 500 ? "counter-error" : ""}>{comment.text.length}/500</code></td>
                                <td><Badge color={comment.stale || comment.status === "failed" ? "red" : ["generating", "regenerating", "pending"].includes(comment.status) ? "blue" : "lime"}>{comment.stale ? "Desactualizado" : statusLabels[comment.status]}</Badge>{comment.error && <small>{comment.error}</small>}</td>
                                <td><Button size="compact-xs" variant="light" disabled={selectedPost.contextStatus !== "edited"} onClick={() => dispatch({ type: "request-regenerate-post", platform, postId: selectedPost.id })}>{comment.text ? "Regenerar" : "Generar"}</Button></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <Group justify="flex-end" mt="sm"><Button variant="default" disabled={selectedPost.contextStatus !== "edited"} onClick={() => dispatch({ type: "request-regenerate-post", platform, postId: selectedPost.id })}>{platform === "tiktok" ? "Generar comentario con DeepSeek" : "Regenerar todos los comentarios de esta publicación"}</Button></Group>
                  </Accordion.Panel>
                </Accordion.Item>
              )}
            </Accordion>
          </article>
        )}
      </div>
    </section>
  );
}
