"""Local smoke check. It never opens GenFarmer, ADB or a device."""

import json
import os
import re
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

temporary = tempfile.TemporaryDirectory()
os.environ.update({
    "DATABASE_URL": f"sqlite:///{Path(temporary.name, 'farm.db')}",
    "GENFARMER_OPEN_APP_ID": "open-app",
    "GENFARMER_FACEBOOK_APP_ID": "facebook-app",
    "GENFARMER_TIKTOK_APP_ID": "tiktok-app",
    "GENFARMER_DISPATCH_GAP": "0",
    "GENFARMER_CHUNK_SIZE": "0",
})

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app import comments  # noqa: E402
from app import genfarmer  # noqa: E402
from app.config import Settings  # noqa: E402
from app.context import full_message, validate_url  # noqa: E402
from app.database import connect, init_database  # noqa: E402


assert main.chunk_delay(0, 33, 240) == 0
assert main.chunk_delay(32, 33, 240) == 0
assert main.chunk_delay(33, 33, 240) == 240
assert main.chunk_delay(66, 33, 240) == 480
assert main.chunk_delay(0, 0, 240) == 0


for invalid_settings in ({"app_host": "0.0.0.0"}, {"frontend_url": "https://farm.example"}):
    try:
        Settings(**invalid_settings)
    except ValueError:
        pass
    else:
        raise AssertionError(invalid_settings)


contracts = {
    "open-content": {"contentUrl", "packageName"},
    "facebook": {"contentUrl", "like", "comment", "share", "commentText", "targetText"},
    "tiktok": {"contentUrl", "like", "comment", "share", "commentText", "targetText"},
}
selector_contracts = {
    "facebook": {"toolbarLikePattern", "toolbarCommentPattern", "toolbarSharePattern", "commentEditorClassPattern",
                 "shareSubmitPattern", "publicAudiencePattern", "commentConfirmedPattern", "shareConfirmedPattern"},
    "tiktok": {"toolbarLikePattern", "toolbarCommentPattern", "toolbarSharePattern", "commentEditorIdPattern",
               "shareSheetHeadingPattern", "copyLinkPattern", "repostActionPattern", "repostActivePattern"},
}
for path in Path(__file__).parent.joinpath("automations").glob("*.genfarm"):
    package = json.loads(path.read_text(encoding="utf-8"))
    node_ids = {node["id"] for node in package["script"]["flow"]["nodes"]}
    assert package["input"] and node_ids
    assert all(edge["source"] in node_ids and edge["target"] in node_ids for edge in package["script"]["flow"]["edges"])
    inputs = {item["options"]["variable"]["name"] for item in package["input"]}
    variables = {item["name"] for item in package["script"]["variables"]}
    assert inputs == contracts[path.stem], (path.name, inputs)
    assert inputs <= variables
    assert selector_contracts.get(path.stem, set()) <= variables
    samples = {
        "contentUrl": "https://www.facebook.com/share/p/19cmrzLH7p/",
        "packageName": "com.facebook.lite", "like": True, "comment": True,
        "share": True, "commentText": "prueba", "targetText": "texto visible",
    }
    values = {name: samples[name] for name in inputs}
    package["id"] = f"{path.stem}-app"
    task = genfarmer.task_payload(package, values, {
        "connectionId": "usb-1", "id": "serial-1", "name": "Equipo 1",
    }, 7, "Contract check")
    assert {item["name"]: item["value"] for item in task["variables"] if item["name"] in values} == values
    assert {item["options"]["variable"]["name"]: item["options"]["value"] for item in task["input"]} == values
    scripts = "\n".join(node.get("data", {}).get("options", {}).get("script", "") for node in package["script"]["flow"]["nodes"])
    assert not any(old in scripts for old in ("v.do_like", "v.do_comment", "v.do_share", "v.comment_text", "v.expected_author", "v.expected_caption"))
    live = next((node for node in package["script"]["flow"]["nodes"] if node["id"] == "social_live_open"), None)
    if live:
        assert live["data"]["options"]["script"].count("await element.click()") == 1
        assert "attempts < 3" not in live["data"]["options"]["script"]
    if path.stem == "facebook":
        assert "publicAudiencePattern" in scripts and "amigos|friends" not in scripts
        assert "composer) { send = composer; audienceConfirmed = true" not in scripts
        audience_pattern = next(item["value"] for item in package["script"]["variables"] if item["name"] == "publicAudiencePattern")
        assert audience_pattern == "^(publico|public)\\b"
        # Lite expone el boton como "Publico. Toca dos veces para cambiar la audiencia...".
        assert re.search(audience_pattern, "publico. toca dos veces para cambiar la audiencia de esta publicacion concreta")
        assert re.search(audience_pattern, "public. double tap to change who can see this post")
        assert not re.search(audience_pattern, "amigos")
        assert "n.clickable === 'true' && liteSelectors.publicAudience.test(n.label)" in scripts
        assert "visual.lines.some(l => liteSelectors.publicAudience" not in scripts
    if path.stem == "tiktok":
        assert "repostActionPattern" in scripts and "^(compartir|republicar" not in scripts
        assert "/compartido|republicado|shared|reposted/" not in scripts

html_fixture = '<script>{"story":{"message":{"text":"Primera parte \\u00a1Hola!\\n\\nSegunda parte con m\\u00e1s contexto"}}}</script>'
assert full_message(html_fixture, "Primera parte ¡Hola!") == "Primera parte ¡Hola! Segunda parte con más contexto"
assert full_message(html_fixture, "Texto de otra publicacion") == "Texto de otra publicacion"
assert full_message(html_fixture, "") == ""
assert full_message("<html>sin json</html>", "Primera parte") == "Primera parte"

for url, platform in [
    ("https://www.facebook.com/example/posts/1", "facebook"),
    ("https://fb.watch/example", "facebook"),
    ("https://www.tiktok.com/@example/video/1", "tiktok"),
    ("https://www.facebook.com/share/p/19cmrzLH7p/", "facebook"),
    ("https://www.facebook.com/share/r/1FAw8USyZo/", "facebook"),
    ("https://www.tiktok.com/@joeln_c/video/7651603660060871954", "tiktok"),
]:
    assert validate_url(url, platform) == url
for url, platform in [
    ("http://facebook.com/example", "facebook"),
    ("https://evil.example", "facebook"),
    ("https://www.tiktok.com/@example/live", "tiktok"),
    ("https://www.facebook.com/'%3Binput%20keyevent%203%3B'", "facebook"),
]:
    try:
        validate_url(url, platform)
    except ValueError:
        pass
    else:
        raise AssertionError((url, platform))
assert validate_url("https://vm.tiktok.com/example", "tiktok")
try:
    validate_url("https://vm.tiktok.com/example", "tiktok", True)
except ValueError:
    pass
else:
    raise AssertionError("TikTok actions must use a canonical video URL")


calls = []
reject_run = {"enabled": False}
real_request = genfarmer.request


def fake_workflow(app_id, names):
    return {
        "id": app_id,
        "input": [{"options": {"variable": {"name": name, "value": ""}, "value": ""}} for name in names],
        "script": {"variables": [{"name": name, "value": ""} for name in names]},
    }


open_workflow = fake_workflow("open-app", ["contentUrl", "packageName"])
facebook_workflow = fake_workflow("facebook-app", ["contentUrl", "like", "comment", "share", "commentText", "targetText"])


def fake_request(path, method="GET", data=None):
    calls.append((path, method, data))
    if path == "/automation/devices":
        return [
            {"serialNo": "serial-second", "currentDeviceId": "usb-2", "name": "Segundo", "index": 2},
            {"serialNo": "serial-first", "currentDeviceId": "usb-1", "name": "Primero", "index": 1},
        ]
    if path == "/automation/apps/open-app":
        return open_workflow
    if path == "/automation/apps/facebook-app":
        return facebook_workflow
    if path == "/automation/tasks" and method == "POST":
        return {"taskId": "task-1"}
    if path == "/automation/tasks/task-1" and method == "PUT":
        return {}
    if path == "/automation/runs" and method == "POST":
        if reject_run["enabled"]:
            raise genfarmer.GenFarmerError("run rejected")
        return {"runId": "run-1"}
    raise AssertionError((path, method, data))


main.genfarmer.request = fake_request
main.genfarmer.user_id = lambda: 7

payload = {
    "requestId": "123e4567-e89b-12d3-a456-426614174000",
    "platform": "facebook",
    "kind": "open",
    "deviceIds": ["serial-first"],
    "publications": [{"url": "https://www.facebook.com/example/posts/1", "context": "", "comments": {}}],
    "actions": {"like": False, "comment": False, "share": False},
    "scheduledAt": None,
}

with TestClient(main.app) as client:
    origin = {"Origin": "http://localhost:5173"}
    devices = client.get("/api/devices").json()["devices"]
    assert [device["id"] for device in devices] == ["serial-first", "serial-second"]
    assert client.post("/api/submissions", json=payload).status_code == 403
    assert client.post("/api/submissions", json=payload, headers={"Origin": "https://evil.example"}).status_code == 403
    created = client.post("/api/submissions", json=payload, headers=origin)
    assert created.status_code == 201, created.text
    submission = created.json()["submissions"][0]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        current = client.get("/api/submissions").json()["submissions"][0]
        if current["status"] in {"sent", "failed", "unknown"}:
            break
        time.sleep(0.02)
    assert current["status"] == "sent", current
    assert current["taskId"] == "task-1" and current["runId"] == "run-1"
    replay = client.post("/api/submissions", json=payload, headers=origin)
    assert replay.status_code == 200 and replay.json()["submissions"][0]["id"] == submission["id"]
    assert len([call for call in calls if call[:2] == ("/automation/runs", "POST")]) == 1
    task_call = next(call for call in calls if call[:2] == ("/automation/tasks", "POST"))
    assert task_call[2]["devices"]["list"] == [{"id": "usb-1", "serialNo": "serial-first", "name": "Primero"}]
    assert {item["name"]: item["value"] for item in task_call[2]["variables"]} == {
        "contentUrl": payload["publications"][0]["url"], "packageName": "com.facebook.lite",
    }
    assert not [call for call in calls if call[:2] == ("/automation/runs/run-1/run", "PUT")]

    scheduled = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174001", "scheduledAt": int(time.time() * 1000) + 60_000}
    response = client.post("/api/submissions", json=scheduled, headers=origin)
    assert response.status_code == 201, response.text
    pending = response.json()["submissions"][0]
    cancelled = client.delete(f"/api/submissions/{pending['id']}", headers=origin)
    assert cancelled.status_code == 200 and cancelled.json()["submission"]["status"] == "cancelled"
    assert client.post("/api/context", json={"url": "https://www.tiktok.com/@example/video/1"}, headers=origin).status_code == 422
    too_long = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174002", "platform": "tiktok",
                "kind": "actions", "actions": {"like": False, "comment": True, "share": False},
                "publications": [{"url": "https://www.tiktok.com/@example/video/1", "context": "",
                                  "comments": {"serial-first": "x" * 151}}]}
    assert client.post("/api/submissions", json=too_long, headers=origin).status_code == 422
    commented = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174004",
                 "kind": "actions", "deviceIds": ["serial-first", "serial-second"],
                 "actions": {"like": True, "comment": True, "share": False},
                 "publications": [{"url": "https://www.facebook.com/example/posts/1", "context": "texto visible",
                                   "comments": {"serial-first": "Comentario del primero", "serial-second": "Comentario del segundo"}}]}
    response = client.post("/api/submissions", json=commented, headers=origin)
    assert response.status_code == 201, response.text
    commented_ids = {item["id"] for item in response.json()["submissions"]}
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        current = [item["status"] for item in client.get("/api/submissions").json()["submissions"] if item["id"] in commented_ids]
        if len(current) == 2 and all(status == "sent" for status in current):
            break
        time.sleep(0.02)
    per_device = {}
    for call in calls:
        if call[:2] == ("/automation/tasks", "POST") and call[2]["appId"] == "facebook-app":
            values = {item["name"]: item["value"] for item in call[2]["variables"]}
            per_device[call[2]["devices"]["list"][0]["serialNo"]] = values["commentText"]
    assert per_device == {"serial-first": "Comentario del primero", "serial-second": "Comentario del segundo"}, per_device
    reject_run["enabled"] = True
    rejected_run = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174003"}
    response = client.post("/api/submissions", json=rejected_run, headers=origin)
    assert response.status_code == 201, response.text
    rejected_id = response.json()["submissions"][0]["id"]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        rejected = next(item for item in client.get("/api/submissions").json()["submissions"] if item["id"] == rejected_id)
        if rejected["status"] in {"failed", "unknown"}:
            break
        time.sleep(0.02)
    assert rejected["status"] == "unknown", rejected
    reject_run["enabled"] = False

with connect() as db:
    db.execute("UPDATE submissions SET status='sending' WHERE id=?", (submission["id"],))
init_database()
with connect() as db:
    assert db.execute("SELECT status FROM submissions WHERE id=?", (submission["id"],)).fetchone()[0] == "unknown"


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self):
        return self.body


class FakeDeepSeek:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self):
        return self.body


unique_key = comments.settings.api_deepseek
comments.settings.api_deepseek = "test-key"
try:
    with TestClient(main.app) as client:
        origin = {"Origin": "http://localhost:5173"}
        request = {"platform": "facebook", "context": "Un texto visible de prueba",
                   "profiles": [
                       {"deviceId": "serial-first", "intention": "Apoyo", "tone": "Cercano"},
                       {"deviceId": "serial-second", "intention": "Pregunta", "tone": "Informativo"},
                   ]}
        content = json.dumps({"comments": [
            {"deviceId": "serial-first", "text": "Comentario generado de prueba uno"},
            {"deviceId": "serial-second", "text": "Comentario generado de prueba dos"},
        ]})
        body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        with patch.object(comments, "urlopen", return_value=FakeDeepSeek(body)):
            generated = client.post("/api/comments", json=request, headers=origin)
        assert generated.status_code == 200, generated.text
        assert generated.json()["comments"] == [
            {"deviceId": "serial-first", "text": "Comentario generado de prueba uno"},
            {"deviceId": "serial-second", "text": "Comentario generado de prueba dos"},
        ]
        short = json.dumps({"choices": [{"message": {"content": json.dumps({"comments": [
            {"deviceId": "serial-first", "text": "Comentario generado de prueba uno"},
        ]})}}]}).encode()
        with patch.object(comments, "urlopen", return_value=FakeDeepSeek(short)):
            invalid = client.post("/api/comments", json=request, headers=origin)
        assert invalid.status_code == 502, invalid.text
finally:
    comments.settings.api_deepseek = unique_key


for body, ambiguous in [
    (b'{"success":false,"message":"rejected"}', False),
    (b'{"message":"missing envelope"}', True),
    (b'[]', True),
]:
    with patch.object(genfarmer, "urlopen", return_value=FakeResponse(body)):
        try:
            real_request("/automation/tasks", "POST", {})
        except genfarmer.GenFarmerError as error:
            assert error.ambiguous is ambiguous
        else:
            raise AssertionError(body)

print("backend/check.py: ok")
temporary.cleanup()
