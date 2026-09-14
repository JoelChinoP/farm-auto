import json
import re
import threading
import time
from collections import OrderedDict
from html.parser import HTMLParser
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


def validate_url(value: str, platform: str, require_video: bool = False) -> str:
    if len(value) > 2048 or any(char in value for char in "'\"") or re.search(r"[\x00-\x20\x7f]", value):
        raise ValueError("URL invalida")
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    domain = "facebook.com" if platform == "facebook" else "tiktok.com"
    allowed = host == domain or host.endswith("." + domain) or (platform == "facebook" and host == "fb.watch")
    if parsed.scheme != "https" or not allowed or parsed.username or parsed.password or parsed.port not in {None, 443}:
        raise ValueError("Usa una URL HTTPS de la plataforma, sin credenciales ni puertos alternativos")
    if platform == "tiktok" and require_video and not re.fullmatch(r"/@[^/]+/(?:video/\d+|live)/?", parsed.path, re.I):
        raise ValueError("Las acciones de TikTok requieren /@usuario/video/id o /@usuario/live")
    return value


class SocialRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl, "facebook")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.values = {}

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "meta":
            attrs = dict(attrs)
            name = attrs.get("property") or attrs.get("name")
            if name in {"og:description", "og:title", "description"} and attrs.get("content"):
                self.values[name] = " ".join(attrs["content"].split())


_cache = OrderedDict()
_lock = threading.Lock()

_MESSAGE_MARKERS = ('"story":{"message":{"text":', '"message":{"text":')
_MESSAGE_WINDOW = 20_000


def full_message(html: str, metadata: str) -> str:
    """ogs:description is truncated with "..."; the same message is complete in the page JSON."""
    decoder = json.JSONDecoder()
    needle = metadata[:30]
    best = ""
    for marker in _MESSAGE_MARKERS:
        for match in re.finditer(re.escape(marker), html):
            try:
                value, _ = decoder.raw_decode(html[match.end():match.end() + _MESSAGE_WINDOW])
            except ValueError:
                continue
            if not isinstance(value, str):
                continue
            text = " ".join(value.split())
            if needle and text.startswith(needle):
                return text
            if len(text) > len(best):
                best = text
    return best if needle and best.startswith(needle) else metadata


def extract_context(url: str) -> str:
    validate_url(url, "facebook")
    # Small public-metadata cache only; never cache credentials, errors or device state.
    with _lock:
        cached = _cache.get(url)
        if cached and cached[0] > time.monotonic():
            return cached[1]
    outgoing = Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "text/html", "Accept-Encoding": "identity"})
    with build_opener(SocialRedirect()).open(outgoing, timeout=10) as response:
        if response.headers.get_content_type() != "text/html":
            raise ValueError("La URL no devolvio una pagina HTML")
        content = response.read(1_048_577)
        if len(content) > 1_048_576:
            raise ValueError("Pagina demasiado grande; pega el contexto manualmente")
        html = content.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
    parser = Metadata()
    parser.feed(html)
    text = parser.values.get("og:description") or parser.values.get("description") or parser.values.get("og:title") or ""
    if len(text) < 5 or text.casefold() in {"facebook", "log into facebook", "inicia sesion en facebook"} or re.search(r"log in to facebook|log into facebook|inicia sesi[oó]n|iniciar sesi[oó]n|create an account", text, re.I):
        raise ValueError("Facebook no expone contexto publico; pegalo manualmente")
    text = full_message(html, text)[:1000]
    with _lock:
        _cache[url] = (time.monotonic() + 300, text)
        _cache.move_to_end(url)
        while len(_cache) > 128:
            _cache.popitem(last=False)
    return text
