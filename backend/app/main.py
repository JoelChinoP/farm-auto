import hashlib
import json
import logging
import sqlite3
import threading
from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from . import genfarmer
from .config import settings
from .context import extract_context, validate_url
from .database import connect, init_database, now_ms, submission_dict


timers: dict[str, threading.Timer] = {}
timer_lock = threading.Lock()
stopping = threading.Event()
log = logging.getLogger(__name__)


def dispatch(submission_id: str):
    try:
        with timer_lock:
            if stopping.is_set():
                return
        with connect() as db:
            claimed = db.execute("UPDATE submissions SET status='sending' WHERE id=? AND status='scheduled'", (submission_id,)).rowcount
            if not claimed:
                return
            row = db.execute("SELECT * FROM submissions WHERE id=?", (submission_id,)).fetchone()
        status, error = "failed", None
        mutation_started = False
        run_requested = False
        try:
            device = next((item for item in genfarmer.devices() if item["id"] == row["device_id"] and item["connected"]), None)
            if device is None:
                raise genfarmer.GenFarmerError("Dispositivo desconectado; no enviado")
            payload = json.loads(row["payload"])
            payload["devices"] = {"enable": True, "list": [{"id": device["connectionId"], "serialNo": device["id"], "name": device["name"]}]}
            mutation_started = True
            task_id = genfarmer.identifier(genfarmer.request("/automation/tasks", "POST", payload), "tarea")
            with connect() as db:
                db.execute("UPDATE submissions SET task_id=? WHERE id=?", (task_id, submission_id))
            # Some versions ignore variables during create; the documented update carries both inputs and variables.
            genfarmer.request(f"/automation/tasks/{genfarmer.path_id(task_id)}", "PUT", {"id": task_id, **payload})
            run_requested = True
            run_id = genfarmer.identifier(genfarmer.request("/automation/runs", "POST", {
                "userId": payload["userId"], "appId": payload["appId"], "taskId": task_id, "status": 0,
            }), "run")
            with connect() as db:
                db.execute("UPDATE submissions SET run_id=? WHERE id=?", (run_id, submission_id))
            if settings.genfarmer_explicit_start:
                genfarmer.request(f"/automation/runs/{genfarmer.path_id(run_id)}/run", "PUT", {"deviceIds": [device["connectionId"]]})
            status = "sent"
        except genfarmer.GenFarmerError as caught:
            status = "unknown" if caught.ambiguous or run_requested else "failed"
            error = str(caught)
        except Exception:
            log.exception("Fallo de envio %s", submission_id)
            status = "unknown" if mutation_started else "failed"
            error = "Fallo interno durante el envio; revisar GenFarmer"
        with connect() as db:
            db.execute("UPDATE submissions SET status=?, error=? WHERE id=? AND status='sending'", (status, error, submission_id))
    except Exception:
        # Leave a claimed row untouched if persistence fails; startup will classify it as unknown.
        log.exception("No se pudo persistir el envio %s", submission_id)
    finally:
        with timer_lock:
            timers.pop(submission_id, None)


def schedule(submission_id: str, when: int):
    with timer_lock:
        if stopping.is_set() or submission_id in timers:
            return
        timer = threading.Timer(max(0, (when - now_ms()) / 1000), dispatch, (submission_id,))
        timer.name = f"send-{submission_id}"
        timer.daemon = True
        timers[submission_id] = timer
        try:
            timer.start()
        except RuntimeError:
            timers.pop(submission_id, None)
            raise


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_database()
    stopping.clear()
    with connect() as db:
        pending = db.execute("SELECT id, scheduled_at FROM submissions WHERE status='scheduled' ORDER BY scheduled_at, device_order, position").fetchall()
    for row in pending:
        schedule(row["id"], row["scheduled_at"])
    yield
    with timer_lock:
        stopping.set()
        active = list(timers.values())
        for timer in active:
            timer.cancel()
    # Let in-flight handoffs persist their IDs/result. New schedules stay in SQLite.
    for timer in active:
        timer.join()
    timers.clear()


app = FastAPI(title=settings.app_name, lifespan=lifespan)
origins = list({settings.frontend_url, "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173", f"http://127.0.0.1:{settings.app_port}"})
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type"])


@app.middleware("http")
async def local_mutations(request: Request, call_next):
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if request.headers.get("origin") and request.headers["origin"] not in origins:
            return JSONResponse({"detail": "Origen no permitido"}, status_code=403)
        if request.method == "POST" and request.headers.get("content-type", "").split(";")[0] != "application/json":
            return JSONResponse({"detail": "Se requiere application/json"}, status_code=415)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(genfarmer.GenFarmerError)
def genfarmer_error(_: Request, error: genfarmer.GenFarmerError):
    return JSONResponse({"detail": str(error)}, status_code=503)


@app.exception_handler(sqlite3.Error)
def database_error(_: Request, error: sqlite3.Error):
    log.error("SQLite: %s", error)
    return JSONResponse({"detail": "SQLite no pudo guardar la solicitud; revisa Envios antes de repetir"}, status_code=503)


class Actions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    like: StrictBool = False
    comment: StrictBool = False
    share: StrictBool = False


class Publication(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=2048)
    context: str = Field(default="", max_length=500)
    commentText: str = Field(default="", max_length=500)

    @field_validator("context")
    @classmethod
    def normalize_context(cls, value: str) -> str:
        return " ".join(value.split())

    @field_validator("commentText")
    @classmethod
    def safe_text(cls, value: str) -> str:
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Usa texto en una sola linea, sin caracteres de control")
        return value.strip()


class SubmissionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: UUID
    platform: Literal["facebook", "tiktok"]
    kind: Literal["open", "actions"]
    deviceIds: list[str] = Field(min_length=1, max_length=100)
    publications: list[Publication] = Field(min_length=1, max_length=10)
    actions: Actions = Field(default_factory=Actions)
    scheduledAt: int | None = Field(default=None, ge=0, le=8_640_000_000_000_000, strict=True)

    @field_validator("deviceIds")
    @classmethod
    def unique_devices(cls, values: list[str]) -> list[str]:
        if any(not value or len(value) > 200 for value in values) or len(set(values)) != len(values):
            raise ValueError("Dispositivos invalidos o repetidos")
        return values


@app.get("/")
@app.get("/health")
@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/settings")
def configuration():
    return {"genfarmerUrl": settings.genfarmer_url, "workflows": {key: bool(value) for key, value in settings.workflows.items()}}


@app.get("/api/devices")
def list_devices():
    return {"devices": genfarmer.devices(), "fetchedAt": now_ms()}


@app.get("/api/submissions")
def list_submissions():
    with connect() as db:
        rows = db.execute("SELECT * FROM submissions ORDER BY created_at DESC, request_id, position").fetchall()
    return {"submissions": [submission_dict(row) for row in rows], "serverTime": now_ms()}


@app.post("/api/submissions")
def submit(payload: SubmissionRequest):
    request_id = str(payload.requestId)
    fingerprint = hashlib.sha256(json.dumps(payload.model_dump(mode="json", exclude={"requestId"}), sort_keys=True).encode()).hexdigest()
    with connect() as db:
        existing = db.execute("SELECT * FROM submissions WHERE request_id=? ORDER BY position", (request_id,)).fetchall()
    if existing:
        if existing[0]["request_hash"] != fingerprint:
            raise HTTPException(409, "La solicitud ya existe con otro contenido")
        return {"submissions": [submission_dict(row) for row in existing]}
    timestamp = now_ms()
    when = payload.scheduledAt if payload.scheduledAt is not None else timestamp
    if payload.scheduledAt is not None and not timestamp <= when <= timestamp + 30 * 86_400_000:
        raise HTTPException(422, "Programa una fecha futura dentro de los proximos 30 dias")
    try:
        for publication in payload.publications:
            validate_url(publication.url, payload.platform)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if len({item.url for item in payload.publications}) != len(payload.publications):
        raise HTTPException(422, "No repitas URLs")
    if payload.kind == "open" and any(payload.actions.model_dump().values()):
        raise HTTPException(422, "Abrir contenido no admite acciones publicas")
    if payload.actions.comment and any(not item.commentText for item in payload.publications):
        raise HTTPException(422, "Escribe un comentario por publicacion")
    slug = "open-content" if payload.kind == "open" else payload.platform
    app_id = settings.workflows[slug]
    if not app_id:
        raise HTTPException(409, f"Importa {slug}.genfarm y configura su ID en backend/.env")
    device_list = genfarmer.devices()
    chosen = [device for device in device_list if device["id"] in payload.deviceIds]
    if len(chosen) != len(payload.deviceIds) or any(not item["connected"] for item in chosen):
        raise HTTPException(409, "Hay dispositivos desconectados; actualiza la lista")
    app_data = genfarmer.request(f"/automation/apps/{genfarmer.path_id(app_id)}")
    if not isinstance(app_data, dict) or app_data.get("id") != app_id:
        raise genfarmer.GenFarmerError("El workflow configurado no existe en GenFarmer")
    user = genfarmer.user_id()
    entries = []
    for device in chosen:
        for publication in payload.publications:
            identifier = str(uuid4())
            values = {"contentUrl": publication.url}
            if payload.kind == "open":
                values["packageName"] = "com.facebook.lite" if payload.platform == "facebook" else "com.zhiliaoapp.musically"
            else:
                values.update(payload.actions.model_dump(), commentText=publication.commentText, targetText=publication.context)
            task = genfarmer.task_payload(app_data, values, device, user, f"Farm {identifier}")
            entries.append((identifier, request_id, fingerprint, len(entries), device["id"], device["name"], device["order"], payload.platform, payload.kind, publication.url, json.dumps(task, ensure_ascii=False), when, "scheduled", timestamp))
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM submissions WHERE request_id=? ORDER BY position", (request_id,)).fetchall()
        if existing:
            if existing[0]["request_hash"] != fingerprint:
                raise HTTPException(409, "La solicitud ya existe con otro contenido")
            return {"submissions": [submission_dict(row) for row in existing]}
        # ponytail: one Timer/thread per handoff, capped at 200; use GenFarmer scheduling once its API is verified.
        active_count = db.execute("SELECT COUNT(*) FROM submissions WHERE status IN ('scheduled','sending')").fetchone()[0]
        if active_count + len(entries) > 200:
            raise HTTPException(409, "Limite de 200 envios pendientes; divide el lote")
        db.executemany("""INSERT INTO submissions
            (id,request_id,request_hash,position,device_id,device_name,device_order,platform,kind,url,payload,scheduled_at,status,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", entries)
    for entry in entries:
        schedule(entry[0], when)
    with connect() as db:
        rows = db.execute("SELECT * FROM submissions WHERE request_id=? ORDER BY position", (request_id,)).fetchall()
    return JSONResponse({"submissions": [submission_dict(row) for row in rows]}, status_code=201)


@app.delete("/api/submissions/{submission_id}")
def cancel(submission_id: str):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM submissions WHERE id=?", (submission_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Envio inexistente")
        if row["status"] not in {"scheduled", "cancelled"}:
            raise HTTPException(409, "El envio ya salio; revisalo en GenFarmer")
        db.execute("UPDATE submissions SET status='cancelled' WHERE id=?", (submission_id,))
        result = submission_dict(db.execute("SELECT * FROM submissions WHERE id=?", (submission_id,)).fetchone())
    with timer_lock:
        timer = timers.pop(submission_id, None)
        if timer:
            timer.cancel()
    return {"submission": result}


class ContextRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


@app.post("/api/context")
def context(payload: ContextRequest):
    try:
        return {"url": payload.url, "context": extract_context(payload.url), "source": "metadata"}
    except (ValueError, OSError) as error:
        raise HTTPException(422, "No se pudo extraer contexto publico. Pega una frase visible de la publicacion.") from error


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.app_host, port=settings.app_port)
