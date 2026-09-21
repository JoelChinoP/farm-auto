from pathlib import Path
from urllib.parse import urlsplit

from dotenv import dotenv_values
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    app_name: str = "Farm"
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    database_url: str = "sqlite:///./data/app.db"
    frontend_url: str = "http://localhost:5173"
    genfarmer_url: str = "http://127.0.0.1:55554"
    genfarmer_timeout: float = Field(default=10, gt=0, le=60)
    genfarmer_dispatch_gap: float = Field(default=1, ge=0, le=30)
    genfarmer_completion_poll: float = Field(default=5, ge=0.1, le=60)
    genfarmer_open_app_id: str = ""
    genfarmer_facebook_app_id: str = ""
    genfarmer_facebook_live_rounds_app_id: str = ""
    genfarmer_tiktok_app_id: str = ""
    api_deepseek: str = ""
    deepseek_model: str = "deepseek-chat"
    deepseek_timeout: float = Field(default=45, gt=0, le=120)
    comment_generation_prompt: str = (
        "Escribe comentarios naturales relacionados con el contexto y la intencion indicada. "
        "No inventes experiencias, identidades ni datos."
    )
    comment_min_words: int = Field(default=5, ge=1, le=100)
    comment_max_words: int = Field(default=15, ge=1, le=100)

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
        return {
            "open-content": self.genfarmer_open_app_id,
            "facebook": self.genfarmer_facebook_app_id,
            "facebook-live-rounds": self.genfarmer_facebook_live_rounds_app_id,
            "tiktok": self.genfarmer_tiktok_app_id,
        }

    model_config = SettingsConfigDict(
        # The previous panel already keeps AI settings in the repository .env; backend/.env wins.
        env_file=(ROOT_DIR / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()

# Empty values in backend/.env must not shadow the repository .env or the built-in defaults.
root_env = dotenv_values(ROOT_DIR / ".env")
for field in ("api_deepseek", "deepseek_model", "comment_generation_prompt"):
    if not getattr(settings, field) and root_env.get(field.upper()):
        setattr(settings, field, root_env[field.upper()])
