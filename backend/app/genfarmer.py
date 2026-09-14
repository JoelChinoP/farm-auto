import copy
import json
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .config import settings


class GenFarmerError(RuntimeError):
    def __init__(self, message: str, ambiguous: bool = False, unavailable: bool = False):
        super().__init__(message)
        self.ambiguous = ambiguous
        self.unavailable = unavailable


def request(path: str, method: str = "GET", data=None):
    outgoing = Request(
        settings.genfarmer_url + path, method=method,
        data=json.dumps(data, ensure_ascii=False).encode() if data is not None else None,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    mutation = method != "GET"
    try:
        with urlopen(outgoing, timeout=settings.genfarmer_timeout) as response:
            payload = json.load(response)
    except HTTPError as error:
        raise GenFarmerError(f"GenFarmer respondio HTTP {error.code}", mutation and error.code >= 500, error.code >= 500) from error
    except (URLError, OSError, ValueError) as error:
        raise GenFarmerError("GenFarmer no responde o devolvio una respuesta invalida", mutation, True) from error
    # Explicit success:false is a rejection; a missing envelope cannot confirm a mutation receipt.
    if not isinstance(payload, dict):
        raise GenFarmerError("GenFarmer no confirmo la solicitud; revisar su API local", mutation, True)
    if payload.get("success") is not True:
        rejected = payload.get("success") is False
        message = "GenFarmer rechazo la solicitud" if rejected else "GenFarmer no confirmo la solicitud"
        raise GenFarmerError(f"{message}; revisar su API local", mutation and not rejected, not rejected)
    return payload.get("data", {})


def run_finished(run_id: str, task_id: str) -> bool:
    run = request(f"/automation/runs/{path_id(run_id)}")
    if not isinstance(run, dict) or run.get("id") != run_id or run.get("taskId") != task_id:
        raise GenFarmerError("GenFarmer devolvio un run distinto al solicitado")
    run_status = run.get("status")
    devices = run.get("deviceStatuses")
    if type(run_status) is not int or run_status not in range(5) or not isinstance(devices, list) or len(devices) != 1:
        raise GenFarmerError("Formato de estado de run distinto al contrato de GenFarmer")
    device = devices[0]
    if not isinstance(device, dict) or device.get("runId") != run_id or not isinstance(device.get("deviceId"), str) or not device["deviceId"]:
        raise GenFarmerError("GenFarmer devolvio un dispositivo distinto al run solicitado")
    device_status = device.get("status")
    if type(device_status) is not int or device_status not in range(5):
        raise GenFarmerError("Formato de estado de dispositivo distinto al contrato de GenFarmer")
    return run_status in {2, 3, 4} and device_status in {2, 3, 4}


def devices() -> list[dict]:
    rows = request("/automation/devices")
    if not isinstance(rows, list):
        raise GenFarmerError("Formato de dispositivos distinto al contrato de GenFarmer")
    result = []
    seen = set()
    for position, row in enumerate(rows, 1):
        if not isinstance(row, dict) or not isinstance(row.get("serialNo"), str):
            raise GenFarmerError("GenFarmer devolvio un serial ausente o repetido")
        serial = row["serialNo"].strip()
        if not serial or serial in seen:
            raise GenFarmerError("GenFarmer devolvio un serial ausente o repetido")
        seen.add(serial)
        connection_id = row.get("currentDeviceId") or ""
        if not isinstance(connection_id, str):
            raise GenFarmerError("Identificador de conexion invalido")
        connection_id = connection_id.strip()
        connected = row.get("connected")
        if connected is not None and type(connected) is not bool:
            raise GenFarmerError("Estado de conexion invalido")
        index = row.get("index")
        if index is not None and (type(index) is not int or index < 0):
            raise GenFarmerError("Orden de dispositivo invalido")
        name = row.get("name")
        if name is not None and not isinstance(name, str):
            raise GenFarmerError("Nombre de dispositivo invalido")
        result.append({
            "id": serial, "serial": serial, "connectionId": connection_id,
            "name": name.strip() if name and name.strip() else serial,
            "order": index if index is not None else position,
            "connected": bool(connection_id) and connected is not False,
        })
    # Stable sort retains the returned order when GenFarmer has no index/ties.
    return sorted(result, key=lambda row: row["order"])


def user_id() -> int:
    user = request("/backend/auth/me")
    if isinstance(user, dict) and isinstance(user.get("data"), dict):
        user = user["data"]
    if not isinstance(user, dict) or type(user.get("id")) is not int or user["id"] <= 0 or user.get("is_valid") is False:
        raise GenFarmerError("Inicia una sesion valida en GenFarmer")
    return user["id"]


def task_payload(app: dict, values: dict, device: dict, user: int, name: str) -> dict:
    variables = copy.deepcopy(app.get("script", {}).get("variables", []))
    if not isinstance(variables, list) or not all(isinstance(item, dict) and "name" in item for item in variables):
        raise GenFarmerError("El workflow no declara variables validas")
    if set(values) - {item["name"] for item in variables}:
        raise GenFarmerError("El workflow importado no coincide con sus entradas; revisar .genfarm")
    for item in variables:
        if item["name"] in values:
            item["value"] = values[item["name"]]

    bound = set()

    def bind(value):
        if isinstance(value, list):
            return [bind(item) for item in value]
        if not isinstance(value, dict):
            return value
        result = {key: bind(item) for key, item in value.items()}
        variable = result.get("variable")
        if isinstance(variable, dict) and variable.get("name") in values:
            result["value"] = variable["value"] = values[variable["name"]]
            bound.add(variable["name"])
        return result

    inputs = bind(app.get("input", []))
    if set(values) - bound:
        raise GenFarmerError("El workflow no expone todas sus variables como entradas; revisar .genfarm")
    return {
        "userId": user, "appId": app["id"], "name": name,
        "input": inputs, "variables": variables, "enableInput": bool(inputs),
        "devices": {"enable": True, "list": [{"id": device["connectionId"], "serialNo": device["id"], "name": device["name"]}]},
    }


def identifier(data, label: str) -> str:
    if not isinstance(data, dict):
        raise GenFarmerError(f"GenFarmer no devolvio el ID de {label}", True)
    keys = {"tarea": ("id", "taskId"), "run": ("id", "runId")}
    for key in keys.get(label, ("id",)):
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    raise GenFarmerError(f"GenFarmer no devolvio el ID de {label}", True)


def path_id(value: str) -> str:
    return quote(value, safe="")
