import { Alert, Badge, Text, Title } from "@mantine/core";

import type { ControlDispatch, ControlState, Platform } from "./control-panel.types";
import { statusLabels } from "./demo-state";
import { CampaignPipeline } from "./campaign-pipeline";
import { CampaignPlanningReview } from "./campaign-planning-review";
import { CampaignSetup } from "./campaign-setup";
import { draftFor } from "./campaign-view.utils";

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

export function CampaignView({ platform, label, accent, allowedHosts, requiredCapability, experimentalActions, state, dispatch }: CampaignViewProps) {
  const draft = draftFor(state, platform);

  return (
    <div className="view-content campaign-view" data-accent={accent}>
      <header className="view-heading campaign-heading">
        <div>
          <span className="section-code">{platform === "facebook" ? "02 / CONSTRUCTOR N×M" : "03 / TIKTOK POST N×M"}</span>
          <Title order={1}>{label}</Title>
          <Text>{platform === "facebook" ? "Todos los equipos seleccionados procesan todas las publicaciones." : "Cada equipo seleccionado procesa cada publicación verificada."}</Text>
        </div>
        <div className="campaign-state"><span>ESTADO DE CAMPAÑA</span><Badge size="lg" variant="light">{statusLabels[draft.status]}</Badge><small>{requiredCapability}</small></div>
      </header>

      <Alert className="prototype-ribbon" color={platform === "facebook" ? "blue" : "cyan"}>
        {platform === "facebook"
          ? "FASE 5 · plan N×M persistente, secuencia por dispositivo y confirmación pública explícita."
          : "FASE 6 · contexto manual persistente, adaptador TikTok propio y confirmación pública explícita."}
      </Alert>
      <CampaignSetup platform={platform} label={label} allowedHosts={allowedHosts} experimentalActions={experimentalActions} draft={draft} state={state} dispatch={dispatch} />
      {draft.posts.length > 0 && <><CampaignPipeline platform={platform} draft={draft} state={state} dispatch={dispatch} /><CampaignPlanningReview platform={platform} label={label} draft={draft} state={state} dispatch={dispatch} /></>}
    </div>
  );
}
