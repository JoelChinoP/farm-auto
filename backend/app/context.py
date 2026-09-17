import json
import re
import threading
import time
import unicodedata
from collections import OrderedDict
from urllib.parse import urlsplit

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


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


def classify_facebook(final_url: str, canonical_url: str, og_type: str, body: str) -> str:
    final_path = urlsplit(final_url).path.casefold()
    canonical_path = urlsplit(canonical_url).path.casefold() if canonical_url else ""
    visible = unicodedata.normalize("NFD", body.casefold())
    visible = "".join(char for char in visible if unicodedata.category(char) != "Mn")
    if re.search(r"/(?:reel|reels)(?:/|$)", final_path):
        return "reel"
    live_badge = re.search(r"(?m)^\s*(?:directo|live)\s*$", visible)
    live_announcement = re.search(r"\besta transmitiendo en (?:vivo|directo)\b|\bis (?:now )?live\b", visible)
    if live_badge and live_announcement:
        return "live"
    if re.search(r"/(?:posts|permalink|photos?)(?:/|$)|/story[.]php$", final_path):
        return "post"
    if re.search(r"/videos(?:/|$)", final_path + " " + canonical_path) or og_type.casefold().startswith("video"):
        return "video"
    return "post"


def inspect_facebook(url: str) -> dict[str, str]:
    validate_url(url, "facebook")
    with _lock:
        cached = _cache.get(url)
        if cached and cached[0] > time.monotonic():
            return dict(cached[1])
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(locale="es-ES")
            page = context.new_page()
            blocked_redirect = []

            def route_request(route):
                request = route.request
                if request.is_navigation_request() and request.frame == page.main_frame:
                    try:
                        validate_url(request.url, "facebook")
                    except ValueError:
                        blocked_redirect.append(request.url)
                        route.abort()
                        return
                if request.resource_type in {"image", "media", "font"}:
                    route.abort()
                else:
                    route.continue_()

            page.route("**/*", route_request)
            response = page.goto(url, wait_until="domcontentloaded", timeout=20_000)
            page.wait_for_timeout(1_500)
            if blocked_redirect:
                raise ValueError("Facebook redirigio fuera de sus dominios permitidos")
            if response is None or response.status >= 400:
                raise ValueError("Facebook no devolvio una pagina publica")
            final_url = page.url
            validate_url(final_url, "facebook")
            metadata = page.locator("meta").evaluate_all("""elements => Object.fromEntries(elements.map(element => [
                element.getAttribute('property') || element.getAttribute('name'), element.getAttribute('content') || ''
            ]).filter(([name]) => name))""")
            canonical_url = page.locator("link[rel='canonical']").get_attribute("href") or ""
            if canonical_url:
                validate_url(canonical_url, "facebook")
            body = page.locator("body").inner_text(timeout=5_000)
            html = page.content()
            context.close()
            browser.close()
    except (PlaywrightError, PlaywrightTimeoutError) as error:
        raise OSError("Playwright no pudo inspeccionar la publicacion de Facebook") from error
    text = " ".join((metadata.get("og:description") or metadata.get("description") or metadata.get("og:title") or "").split())
    if len(text) < 5 or text.casefold() in {"facebook", "log into facebook", "inicia sesion en facebook"} or re.search(r"log in to facebook|log into facebook|inicia sesi[oó]n|iniciar sesi[oó]n|create an account", text, re.I):
        text = ""
    result = {
        "type": classify_facebook(final_url, canonical_url, metadata.get("og:type", ""), body),
        "context": full_message(html, text)[:1000] if text else "",
        "resolvedUrl": final_url,
    }
    with _lock:
        _cache[url] = (time.monotonic() + 300, result)
        _cache.move_to_end(url)
        while len(_cache) > 128:
            _cache.popitem(last=False)
    return dict(result)


def extract_context(url: str) -> str:
    text = inspect_facebook(url)["context"]
    if not text:
        raise ValueError("Facebook no expone contexto publico; pegalo manualmente")
    return text
