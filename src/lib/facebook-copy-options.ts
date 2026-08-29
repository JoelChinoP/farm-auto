export const facebookIntentOptions = [
  ["Ataque directo", "Busca detonar reacción biológica."],
  ["Evitación / Desvinculación", "Cero refuerzo dopaminérgico; responder de manera esquiva y breve."],
  ["Crítica Constructiva", "Busca debatir, señalar límites o aportar una alternativa."],
  ["Afrontamiento Enfocado en el Problema", "Validación más aportación: entender X y proponer Y debido a Z."],
  ["Desinformación o Error Factual", "Aclaración objetiva con datos o fuentes, sin juzgar a la persona."],
  ["Elogio o Apoyo", "Refuerzo positivo, agradecimiento o apoyo conciso."],
] as const;

export const facebookToneValues = [
  "casual",
  "amable",
  "curioso",
  "entusiasta",
  "dulce-calido",
  "empatico-asertivo",
  "distante-formal",
  "pasivo-agresivo-sarcastico",
  "frio-cortante",
  "defensivo-agresivo",
] as const;

export const facebookToneOptions = [
  ["casual", "Casual", "Conversacional, natural y sin rigidez."],
  ["amable", "Amable", "Respetuoso, cordial y claro."],
  ["curioso", "Curioso", "Abierto a preguntar o explorar un detalle."],
  ["entusiasta", "Entusiasta", "Energético y positivo sin exagerar."],
  ["dulce-calido", "Dulce / Cálido", "Suave, pausado, cercano y con cadencia amable."],
  ["empatico-asertivo", "Empático / Asertivo", "Neutro y firme, pero respetuoso, pausado y claro."],
  ["distante-formal", "Distante / Formal", "Plano, sobrio y sin modulación afectiva."],
  ["pasivo-agresivo-sarcastico", "Pasivo-Agresivo / Sarcástico", "Ironía perceptible y pausas marcadas, sin insultar ni hostigar."],
  ["frio-cortante", "Frío / Cortante", "Breve, seco, directo y sin adornos afectivos."],
  ["defensivo-agresivo", "Defensivo / Agresivo", "Firme, tenso e incisivo, sin amenazas ni ataques personales."],
] as const;

export function describeFacebookIntent(intent: string) {
  return facebookIntentOptions.find(([value]) => value === intent)?.[1] ?? intent;
}

export function describeFacebookTone(tone: string) {
  return facebookToneOptions.find(([value]) => value === tone)?.[2] ?? tone;
}
