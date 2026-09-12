from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from urllib.parse import urlsplit


BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    app_name: str = "Farm"
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    database_url: str = "sqlite:///./data/app.db"
    frontend_url: str = "http://localhost:5173"
    genfarmer_url: str = "http://127.0.0.1:55554"
    genfarmer_timeout: float = Field(default=10, gt=0, le=60)
    genfarmer_open_app_id: str = ""
    genfarmer_facebook_app_id: str = ""
    genfarmer_tiktok_app_id: str = ""
    # Some older builds start on POST /runs; choose only after checking the installed API.
    genfarmer_explicit_start: bool = True

    @field_validator("app_host")
    @classmethod
    def local_host(cls, value: str) -> str:
        if value not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("APP_HOST debe escuchar solo en loopback")
        return value

    @field_validator("frontend_url")
    @classmethod
    def local_frontend(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"localhost", "127.0.0.1", "::1"} or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
            raise ValueError("FRONTEND_URL debe ser un origen local sin credenciales ni ruta")
        _ = parsed.port
        return value.rstrip("/")

    @field_validator("genfarmer_url")
    @classmethod
    def local_service(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"localhost", "127.0.0.1", "::1"} or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
            raise ValueError("GENFARMER_URL debe apuntar al servicio local sin credenciales")
        _ = parsed.port
        return value.rstrip("/")

    @property
    def workflows(self) -> dict[str, str]:
        return {"open-content": self.genfarmer_open_app_id, "facebook": self.genfarmer_facebook_app_id, "tiktok": self.genfarmer_tiktok_app_id}

    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
    )


settings = Settings()
