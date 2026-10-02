"""Configuration loaded from environment variables / a .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


class ConfigError(ValueError):
    """Raised when the configuration is invalid."""


def _get_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _get_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from exc


def _get_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(float(raw))
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc


def _get_str(name: str, default: str) -> str:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip()


def _get_secret(name: str) -> str:
    """Like _get_str but treats the .env.example placeholders as 'not set'."""
    value = _get_str(name, "")
    if value.lower().startswith("your_") or value.lower() in {"changeme", "xxx", "none"}:
        return ""
    return value


@dataclass
class Config:
    # --- Deriv connection -------------------------------------------------
    app_id: str = "1089"
    api_token: str = ""
    ws_url: str = "wss://ws.derivws.com/websockets/v3"

    # --- Contract ---------------------------------------------------------
    symbol: str = "R_75"
    stake: float = 1.0
    currency: str = "USD"  # overwritten by the account currency after authorize
    tick_duration: int = 5

    # --- Mode -------------------------------------------------------------
    paper_trade: bool = True
    allow_real_account: bool = False
    paper_start_balance: float = 1000.0
    paper_payout_rate: float = 0.95  # fallback when a live proposal quote is unavailable

    # --- Profit target / risk ----------------------------------------------
    profit_target: float = 25.0
    max_daily_loss: float = 15.0  # stored as a positive number
    max_trades_per_day: int = 20
    max_consecutive_losses: int = 4
    cooldown_seconds: float = 30.0

    # --- ML ---------------------------------------------------------------
    train_window: int = 100
    min_ml_probability: float = 0.60

    # --- LLM (Groq) ---------------------------------------------------------
    use_llm: bool = True
    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"
    groq_base_url: str = "https://api.groq.com/openai/v1"
    llm_timeout: float = 12.0
    min_ai_confidence: int = 78
    require_agreement: bool = True
    llm_retry_seconds: float = 10.0  # wait after a HOLD/rejected signal before asking again

    # --- Misc ---------------------------------------------------------------
    state_dir: Path = field(default_factory=lambda: Path("state"))
    history_count: int = 300
    ping_interval: float = 30.0
    scan_log_every: int = 10  # print a "scanning" line every N ticks

    # ----------------------------------------------------------------------
    @property
    def mode(self) -> str:
        return "paper" if self.paper_trade else "live"

    @property
    def llm_enabled(self) -> bool:
        return self.use_llm and bool(self.groq_api_key)

    @property
    def ws_endpoint(self) -> str:
        sep = "&" if "?" in self.ws_url else "?"
        return f"{self.ws_url}{sep}app_id={self.app_id}"

    @classmethod
    def from_env(cls, env_file: str | os.PathLike | None = ".env") -> "Config":
        try:
            from dotenv import load_dotenv

            if env_file is not None:
                load_dotenv(env_file, override=False)
        except ImportError:  # pragma: no cover - dotenv is in requirements
            pass

        cfg = cls(
            app_id=_get_str("DERIV_APP_ID", "1089"),
            api_token=_get_secret("DERIV_API_TOKEN"),
            ws_url=_get_str("DERIV_WS_URL", "wss://ws.derivws.com/websockets/v3"),
            symbol=_get_str("SYMBOL", "R_75"),
            stake=_get_float("STAKE", 1.0),
            currency=_get_str("CURRENCY", "USD"),
            tick_duration=_get_int("TICK_DURATION", 5),
            paper_trade=_get_bool("PAPER_TRADE", True),
            allow_real_account=_get_bool("ALLOW_REAL_ACCOUNT", False),
            paper_start_balance=_get_float("PAPER_START_BALANCE", 1000.0),
            paper_payout_rate=_get_float("PAPER_PAYOUT_RATE", 0.95),
            profit_target=_get_float("PROFIT_TARGET", 25.0),
            max_daily_loss=abs(_get_float("MAX_DAILY_LOSS", 15.0)),
            max_trades_per_day=_get_int("MAX_TRADES_PER_DAY", 20),
            max_consecutive_losses=_get_int("MAX_CONSECUTIVE_LOSSES", 4),
            cooldown_seconds=_get_float("COOLDOWN_SECONDS", 30.0),
            train_window=_get_int("TRAIN_WINDOW", 100),
            min_ml_probability=_get_float("MIN_ML_PROBABILITY", 0.60),
            use_llm=_get_bool("USE_LLM", True),
            groq_api_key=_get_secret("GROQ_API_KEY"),
            groq_model=_get_str("GROQ_MODEL", "openai/gpt-oss-120b"),
            groq_base_url=_get_str("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
            llm_timeout=_get_float("LLM_TIMEOUT", 12.0),
            min_ai_confidence=_get_int("MIN_AI_CONFIDENCE", 78),
            require_agreement=_get_bool("REQUIRE_AGREEMENT", True),
            llm_retry_seconds=_get_float("LLM_RETRY_SECONDS", 10.0),
            state_dir=Path(_get_str("STATE_DIR", "state")),
        )
        # Accept MIN_ML_PROBABILITY as either 0.6 or 60.
        if cfg.min_ml_probability > 1:
            cfg.min_ml_probability /= 100.0
        cfg.validate()
        return cfg

    def validate(self) -> None:
        if self.stake <= 0:
            raise ConfigError("STAKE must be greater than 0")
        if self.profit_target <= 0:
            raise ConfigError("PROFIT_TARGET must be greater than 0")
        if self.max_daily_loss <= 0:
            raise ConfigError("MAX_DAILY_LOSS must be greater than 0")
        if self.stake > self.max_daily_loss:
            raise ConfigError("STAKE cannot be larger than MAX_DAILY_LOSS")
        if not 1 <= self.tick_duration <= 10:
            raise ConfigError("TICK_DURATION must be between 1 and 10 ticks")
        if self.max_trades_per_day < 1:
            raise ConfigError("MAX_TRADES_PER_DAY must be at least 1")
        if not 0.5 <= self.min_ml_probability < 1:
            raise ConfigError("MIN_ML_PROBABILITY must be between 0.5 and 1 (e.g. 0.60)")
        if not 0 <= self.min_ai_confidence <= 100:
            raise ConfigError("MIN_AI_CONFIDENCE must be between 0 and 100")
        if self.train_window < 40:
            raise ConfigError("TRAIN_WINDOW must be at least 40 ticks")
        if not self.paper_trade and not self.api_token:
            raise ConfigError(
                "Live trading (PAPER_TRADE=false) needs DERIV_API_TOKEN. "
                "Create one at https://app.deriv.com/account/api-token with Read + Trade scopes."
            )
