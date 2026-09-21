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


class CommentError(RuntimeError):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def parse_generated(content: str, device_ids: list[str]) -> list[dict]:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.IGNORECASE)
    try:
        parsed = json.loads(cleaned)
    except ValueError as error:
        raise CommentError("DeepSeek devolvio JSON invalido.") from error
    if not isinstance(parsed, dict) or set(parsed) != {"comments"} or not isinstance(parsed["comments"], list):
        raise CommentError("DeepSeek devolvio una respuesta invalida.")
    expected = set(device_ids)
    seen = set()
    comments = []
    for value in parsed["comments"]:
        if not isinstance(value, dict) or set(value) != {"deviceId", "text"}:
            raise CommentError("Cada comentario debe identificar deviceId y text.")
        text = str(value["text"]).strip()
        words = len(text.split())
        if (
            value["deviceId"] not in expected
            or value["deviceId"] in seen
            or "\n" in text
            or any(ord(char) < 32 or ord(char) == 127 for char in text)
            or not 2 <= len(text) <= COMMENT_MAX_CHARS
            or not settings.comment_min_words <= words <= settings.comment_max_words
        ):
            raise CommentError("DeepSeek devolvio comentarios fuera del contrato esperado.")
        seen.add(value["deviceId"])
        comments.append({"deviceId": value["deviceId"], "text": text})
    if len(comments) != len(device_ids) or seen != expected:
        raise CommentError("DeepSeek no devolvio la cantidad exacta de comentarios.")
    return comments


def generate(platform: str, context: str, profiles: list[dict]) -> list[dict]:
    if not settings.api_deepseek:
        raise CommentError("Falta API_DEEPSEEK en el servidor.", 503)
    limit = TIKTOK_MAX_CHARS if platform == "tiktok" else COMMENT_MAX_CHARS
    instruction = (
        f"{settings.comment_generation_prompt}\n"
        'Devuelve solo JSON con la forma {"comments":[{"deviceId":"...","text":"..."}]}. '
        f"Genera exactamente un comentario por deviceId, de {settings.comment_min_words} a "
        f"{settings.comment_max_words} palabras, 2 a {limit} caracteres y en una sola linea."
    )
    profiles = [{
        **profile,
        "intentionGuidance": INTENTION_GUIDANCE.get(profile["intention"], ""),
        "toneGuidance": TONE_GUIDANCE.get(profile["tone"], ""),
    } for profile in profiles]
    body = json.dumps({
        "model": settings.deepseek_model,
        "stream": False,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": instruction},
            {"role": "user", "content": json.dumps({"context": context, "profiles": profiles}, ensure_ascii=False)},
        ],
    }).encode()
    outgoing = Request(
        "https://api.deepseek.com/chat/completions", method="POST", data=body,
        headers={"Authorization": f"Bearer {settings.api_deepseek}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urlopen(outgoing, timeout=settings.deepseek_timeout) as response:
            payload = json.load(response)
    except HTTPError as error:
        if error.code == 401:
            raise CommentError("DeepSeek rechazo API_DEEPSEEK.", 503) from error
        raise CommentError(f"DeepSeek respondio HTTP {error.code}.") from error
    except (URLError, OSError, ValueError) as error:
        raise CommentError("DeepSeek no respondio o devolvio una respuesta invalida.") from error
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise CommentError("DeepSeek devolvio una respuesta invalida.") from error
    if not isinstance(content, str) or not content.strip():
        raise CommentError("DeepSeek no devolvio comentarios.")
    comments = parse_generated(content, [profile["deviceId"] for profile in profiles])
    limit = TIKTOK_MAX_CHARS if platform == "tiktok" else COMMENT_MAX_CHARS
    if any(len(comment["text"]) > limit for comment in comments):
        raise CommentError("DeepSeek devolvio comentarios fuera del contrato esperado.")
    return comments
