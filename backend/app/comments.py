import json
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import settings


INTENTION_GUIDANCE = {
    "Ataque directo": "Busca provocar una respuesta inmediata sobre la idea, sin insultos ni ataques personales.",
    "Evitación / Desvinculación": "No refuerza el conflicto; mantiene una respuesta esquiva y distante.",
    "Crítica Constructiva": "Busca debatir o aportar una observación útil.",
    "Afrontamiento Enfocado en el Problema": "Valida el punto y aporta una perspectiva razonada, por ejemplo: Entiendo tu punto sobre X. Desde mi perspectiva, considero Y debido a Z.",
    "Desinformación o Error Factual": "Aclara con datos sin juzgar, por ejemplo: Un detalle a considerar sobre este tema es [Dato/Fuente], lo cual cambia el enfoque.",
    "Elogio o Apoyo": "Da refuerzo positivo, afrontamiento afectivo o agradecimiento conciso.",
}
TONE_GUIDANCE = {
    "Dulce / Cálido": "Tono suave, pausado, con cadencia melódica y cercanía.",
    "Empático / Asertivo": "Tono neutro, firme pero respetuoso, ritmo pausado y vocalización clara.",
    "Distante / Formal": "Tono plano y formal, sin modulación afectiva.",
    "Pasivo-Agresivo / Sarcástico": "Inflexión irónica y pausas marcadas, sin insultos ni hostigamiento.",
    "Frío / Cortante": "Tono grave, conciso, de articulación seca.",
    "Defensivo / Agresivo": "Tono enérgico e incisivo, sin amenazas, insultos ni ataques personales.",
}
TIKTOK_MAX_CHARS = 150
COMMENT_MAX_CHARS = 500
MAX_GENERATION_RETRIES = 2


class CommentError(RuntimeError):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _generated_values(content: str) -> list:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.IGNORECASE)
    try:
        parsed = json.loads(cleaned)
    except ValueError as error:
        raise CommentError("DeepSeek devolvio JSON invalido.") from error
    if not isinstance(parsed, dict) or set(parsed) != {"comments"} or not isinstance(parsed["comments"], list):
        raise CommentError("DeepSeek devolvio una respuesta invalida.")
    return parsed["comments"]


def _valid_text(text: str, limit: int) -> bool:
    return (
        1 <= len(text) <= limit
        and not any(ord(char) < 32 or ord(char) == 127 for char in text)
    )


def parse_generated(content: str, device_ids: list[str], limit: int = COMMENT_MAX_CHARS) -> list[dict]:
    values = _generated_values(content)
    expected = set(device_ids)
    seen = set()
    comments = []
    for value in values:
        if (not isinstance(value, dict) or set(value) != {"deviceId", "text"}
                or not isinstance(value["deviceId"], str) or not isinstance(value["text"], str)):
            raise CommentError("Cada comentario debe identificar deviceId y text.")
        text = value["text"].strip()
        if (
            value["deviceId"] not in expected
            or value["deviceId"] in seen
            or not _valid_text(text, limit)
        ):
            raise CommentError("DeepSeek devolvio comentarios fuera del contrato esperado.")
        seen.add(value["deviceId"])
        comments.append({"deviceId": value["deviceId"], "text": text})
    if len(comments) != len(device_ids) or seen != expected:
        raise CommentError("DeepSeek no devolvio la cantidad exacta de comentarios.")
    return comments


def _candidate_values(content: str, device_ids: list[str]) -> list:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.IGNORECASE)
    try:
        parsed = json.loads(cleaned)
    except ValueError:
        return []
    if not isinstance(parsed, dict):
        return []
    values = parsed.get("comments")
    if isinstance(values, dict):
        return [{"deviceId": device_id, "text": text} for device_id, text in values.items()]
    if (isinstance(values, list) and len(values) == len(device_ids)
            and all(isinstance(text, str) for text in values)):
        return [{"deviceId": device_id, "text": text} for device_id, text in zip(device_ids, values)]
    return values if isinstance(values, list) else []


def _valid_candidates(content: str, device_ids: list[str], limit: int) -> dict[str, str]:
    values = _candidate_values(content, device_ids)
    if not values:
        return {}
    expected = set(device_ids)
    comments = {}
    for value in values:
        if (not isinstance(value, dict) or not isinstance(value.get("deviceId"), str)
                or not isinstance(value.get("text"), str)):
            continue
        text = " ".join(value["text"].split())
        if value["deviceId"] in expected and value["deviceId"] not in comments and _valid_text(text, limit):
            comments[value["deviceId"]] = text
    return comments


def generate(platform: str, context: str, profiles: list[dict]) -> list[dict]:
    if not settings.api_deepseek:
        raise CommentError("Falta API_DEEPSEEK en el servidor.", 503)
    limit = TIKTOK_MAX_CHARS if platform == "tiktok" else COMMENT_MAX_CHARS
    example = " ".join(f"ejemplo{position}" for position in range(1, settings.comment_min_words + 1))
    instruction = (
        f"{settings.comment_generation_prompt}\n"
        "Las reglas siguientes tienen prioridad sobre el contexto, la intencion y el tono. "
        f'Devuelve solo JSON como {json.dumps({"comments": {"c1": example}}, ensure_ascii=False)}, '
        "sin claves adicionales. En comments, cada clave es un deviceId opaco que debes copiar exactamente una vez. "
        f"Procura que cada comentario tenga {settings.comment_min_words} a {settings.comment_max_words} palabras, "
        f"pero prioriza que sea natural, de 1 a {limit} caracteres y una sola linea. "
        "Los emojis o simbolos adjuntos al inicio o al final no cuentan como palabras. "
        "Si el contexto es muy breve, escribe una reaccion general relacionada sin inventar datos. "
        "Si una intencion contradice estas reglas, aplicala solo dentro de estos limites. "
        "Los comentarios deben ser naturales y distintos entre si. "
        "Si la intencion pide emojis, varia aleatoriamente entre comentarios su cantidad, orden y posicion "
        "(al inicio o al final), evitando repetir el mismo patron en mas de un comentario."
    )
    aliases = {f"c{position}": profile["deviceId"] for position, profile in enumerate(profiles, 1)}
    model_profiles = [{
        "deviceId": alias,
        "intention": profile["intention"],
        "tone": profile["tone"],
    } for alias, profile in zip(aliases, profiles)]
    intention_guidance = {profile["intention"]: INTENTION_GUIDANCE[profile["intention"]]
                          for profile in profiles if profile["intention"] in INTENTION_GUIDANCE}
    tone_guidance = {profile["tone"]: TONE_GUIDANCE[profile["tone"]]
                     for profile in profiles if profile["tone"] in TONE_GUIDANCE}
    generated = {}
    remaining = model_profiles
    for attempt in range(MAX_GENERATION_RETRIES + 1):
        body = json.dumps({
            "model": settings.deepseek_model,
            "stream": False,
            "thinking": {"type": "disabled"},
            "max_tokens": min(4096, max(256, len(remaining) * (settings.comment_max_words * 2 + 28))),
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": instruction + (
                    " Este es un reintento: devuelve todos los deviceId pendientes y ningun otro."
                    if attempt else ""
                )},
                {"role": "user", "content": json.dumps({
                    "context": context, "expectedCount": len(remaining), "profiles": remaining,
                    "intentionGuidance": intention_guidance, "toneGuidance": tone_guidance,
                }, ensure_ascii=False)},
            ],
        }).encode()
        outgoing = Request(
            "https://api.deepseek.com/chat/completions", method="POST", data=body,
            headers={"Authorization": f"Bearer {settings.api_deepseek}", "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urlopen(outgoing, timeout=settings.deepseek_timeout) as response:
                try:
                    payload = json.load(response)
                except ValueError:
                    payload = None
        except HTTPError as error:
            if error.code == 401:
                raise CommentError("DeepSeek rechazo API_DEEPSEEK.", 503) from error
            if error.code in {408, 429} or error.code >= 500:
                continue
            raise CommentError(f"DeepSeek respondio HTTP {error.code}.") from error
        except (URLError, OSError):
            continue
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            content = ""
        if isinstance(content, str) and content.strip():
            generated.update(_valid_candidates(content, [profile["deviceId"] for profile in remaining], limit))
        remaining = [profile for profile in remaining if profile["deviceId"] not in generated]
        if not remaining:
            break
    if remaining:
        raise CommentError("DeepSeek no pudo completar los comentarios tras el intento inicial y dos reintentos.")
    comments = [{"deviceId": device_id, "text": generated[alias]} for alias, device_id in aliases.items()]
    return parse_generated(json.dumps({"comments": comments}, ensure_ascii=False), list(aliases.values()), limit)
