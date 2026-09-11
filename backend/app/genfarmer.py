import copy
import json
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .config import settings


class GenFarmerError(RuntimeError):
    def __init__(self, message: str, ambiguous: bool = False):
        super().__init__(message)
        self.ambiguous = ambiguous


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
        raise GenFarmerError(f"GenFarmer respondio HTTP {error.code}", mutation and error.code >= 500) from error
    except (URLError, OSError, ValueError) as error:
        raise GenFarmerError("GenFarmer no responde o devolvio una respuesta invalida", mutation) from error
    # The installed API uses an envelope; do not accept a 200 with an error or HTML.
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise GenFarmerError("GenFarmer no confirmo la solicitud; revisar su API local", mutation)
    return payload.get("data", {})


def devices() -> list[dict]:
    rows = request("/automation/devices")
    if not isinstance(rows, list):
        raise GenFarmerError("Formato de dispositivos distinto al contrato de GenFarmer")
    result = []
    seen = set()
    for position, row in enumerate(rows, 1):
        if not isinstance(row, dict) or not isinstance(row.get("serialNo"), str) or not row["serialNo"] or row["serialNo"] in seen:
            raise GenFarmerError("GenFarmer devolvio un serial ausente o repetido")
        seen.add(row["serialNo"])
        connection_id = row.get("currentDeviceId") or ""
        if not isinstance(connection_id, str):
            raise GenFarmerError("Identificador de conexion invalido")
        index = row.get("index")
        result.append({
            "id": row["serialNo"], "serial": row["serialNo"], "connectionId": connection_id,
            "name": str(row.get("name") or row["serialNo"]),
            "order": index if type(index) is int else position,
            "connected": bool(connection_id) and row.get("connected") is not False,
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

    def bind(value):
        if isinstance(value, list):
            return [bind(item) for item in value]
        if not isinstance(value, dict):
            return value
        result = {key: bind(item) for key, item in value.items()}
        variable = result.get("variable")
        if isinstance(variable, dict) and variable.get("name") in values:
            result["value"] = variable["value"] = values[variable["name"]]
        return result

    inputs = bind(app.get("input", []))
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
