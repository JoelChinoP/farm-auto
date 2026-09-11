"""Local smoke check. It never opens GenFarmer, ADB or a device."""

import json
import os
import tempfile
import time
from pathlib import Path

temporary = tempfile.TemporaryDirectory()
os.environ.update({
    "DATABASE_URL": f"sqlite:///{Path(temporary.name, 'farm.db')}",
    "GENFARMER_OPEN_APP_ID": "open-app",
    "GENFARMER_FACEBOOK_APP_ID": "facebook-app",
    "GENFARMER_TIKTOK_APP_ID": "tiktok-app",
})

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.context import validate_url  # noqa: E402
from app.database import connect, init_database  # noqa: E402


for path in Path(__file__).parent.joinpath("automations").glob("*.genfarm"):
    package = json.loads(path.read_text())
    node_ids = {node["id"] for node in package["script"]["flow"]["nodes"]}
    assert package["input"] and node_ids
    assert all(edge["source"] in node_ids and edge["target"] in node_ids for edge in package["script"]["flow"]["edges"])

for url, platform in [
    ("https://www.facebook.com/example/posts/1", "facebook"),
    ("https://fb.watch/example", "facebook"),
    ("https://www.tiktok.com/@example/video/1", "tiktok"),
]:
    assert validate_url(url, platform) == url
for url, platform in [
    ("http://facebook.com/example", "facebook"),
    ("https://evil.example", "facebook"),
    ("https://www.tiktok.com/@example/live", "tiktok"),
]:
    try:
        validate_url(url, platform)
    except ValueError:
        pass
    else:
        raise AssertionError((url, platform))


calls = []
workflow = {
    "id": "open-app",
    "input": [],
    "script": {"variables": [
        {"name": "contentUrl", "value": ""},
        {"name": "packageName", "value": ""},
    ]},
}


def fake_request(path, method="GET", data=None):
    calls.append((path, method, data))
    if path == "/automation/devices":
        return [
            {"serialNo": "serial-second", "currentDeviceId": "usb-2", "name": "Segundo", "index": 2},
            {"serialNo": "serial-first", "currentDeviceId": "usb-1", "name": "Primero", "index": 1},
        ]
    if path == "/automation/apps/open-app":
        return workflow
    if path == "/automation/tasks" and method == "POST":
        return {"taskId": "task-1"}
    if path == "/automation/tasks/task-1" and method == "PUT":
        return {}
    if path == "/automation/runs" and method == "POST":
        return {"runId": "run-1"}
    if path == "/automation/runs/run-1/run" and method == "PUT":
        return {}
    raise AssertionError((path, method, data))


main.genfarmer.request = fake_request
main.genfarmer.user_id = lambda: 7

payload = {
    "requestId": "123e4567-e89b-12d3-a456-426614174000",
    "platform": "facebook",
    "kind": "open",
    "deviceIds": ["serial-first"],
    "publications": [{"url": "https://www.facebook.com/example/posts/1", "context": "", "commentText": ""}],
    "actions": {"like": False, "comment": False, "share": False},
    "scheduledAt": None,
}

with TestClient(main.app) as client:
    devices = client.get("/api/devices").json()["devices"]
    assert [device["id"] for device in devices] == ["serial-first", "serial-second"]
    created = client.post("/api/submissions", json=payload)
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
    replay = client.post("/api/submissions", json=payload)
    assert replay.status_code == 200 and replay.json()["submissions"][0]["id"] == submission["id"]
    assert len([call for call in calls if call[:2] == ("/automation/runs", "POST")]) == 1

    scheduled = {**payload, "requestId": "123e4567-e89b-12d3-a456-426614174001", "scheduledAt": int(time.time() * 1000) + 60_000}
    response = client.post("/api/submissions", json=scheduled)
    assert response.status_code == 201, response.text
    pending = response.json()["submissions"][0]
    cancelled = client.delete(f"/api/submissions/{pending['id']}")
    assert cancelled.status_code == 200 and cancelled.json()["submission"]["status"] == "cancelled"
    assert client.post("/api/context", json={"url": "https://www.tiktok.com/@example/video/1"}).status_code == 422

with connect() as db:
    db.execute("UPDATE submissions SET status='sending' WHERE id=?", (submission["id"],))
init_database()
with connect() as db:
    assert db.execute("SELECT status FROM submissions WHERE id=?", (submission["id"],)).fetchone()[0] == "unknown"

print("backend/check.py: ok")
temporary.cleanup()
