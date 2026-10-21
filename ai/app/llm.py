"""Local open-source LLM integration (Ollama).

Natural language -> structured GIS operation. The model runs entirely
self-hosted (Ollama serving an Apache-2.0 Qwen2.5 instruct model); there is
no API key and no external service. Ollama's structured-output `format`
(JSON schema) plus a strict prompt keep the response a single JSON object
matching `PlanResult`. The model has no tools and cannot execute anything.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from typing import Any, List, Optional, Tuple

import httpx

from . import config, prompts
from .repair import mentioned_layer_codes
from .schema import ChatTurn, GisOperation, LayerInfo, PLAN_JSON_SCHEMA, PlanResult
from .vectorstore import Retrieved

log = logging.getLogger("gis-ai.llm")

_client: Optional[httpx.Client] = None


class LLMUnavailable(RuntimeError):
    pass


class Cancelled(RuntimeError):
    """The caller went away (the user pressed Stop) — the model was stopped."""


def _stream_chat(payload: dict, cancel: Optional[threading.Event]) -> str:
    """POST /api/chat streaming, checking `cancel` between chunks. Closing
    the stream makes Ollama stop generating, so a cancelled question frees
    the (single, CPU) model at once instead of running to the end."""
    parts: List[str] = []
    try:
        with _http().stream("POST", "/api/chat", json={**payload, "stream": True}) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if cancel is not None and cancel.is_set():
                    raise Cancelled("cancelled by the user")
                if not line:
                    continue
                chunk = json.loads(line)
                parts.append((chunk.get("message") or {}).get("content", ""))
                if chunk.get("done"):
                    break
    except httpx.HTTPError as exc:
        raise LLMUnavailable(f"Local LLM request failed: {exc}") from exc
    return "".join(parts).strip()


def _http() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(
            base_url=config.OLLAMA_URL, timeout=config.LLM_TIMEOUT_S
        )
    return _client


def reachable() -> bool:
    try:
        r = _http().get("/api/tags", timeout=5)
        return r.status_code == 200
    except Exception:
        return False


def model_present() -> bool:
    try:
        r = _http().get("/api/tags", timeout=5)
        r.raise_for_status()
        names = {m.get("name", "") for m in r.json().get("models", [])}
        want = config.LLM_MODEL
        return want in names or f"{want}:latest" in names or any(
            n.split(":")[0] == want.split(":")[0] for n in names
        )
    except Exception:
        return False


def ensure_model() -> None:
    """Pull the configured model if missing, then warm it into memory."""
    if config.LLM_AUTO_PULL and not model_present():
        log.info("pulling local LLM %s (first run — downloads ~1-2 GB)…", config.LLM_MODEL)
        with _http().stream(
            "POST",
            "/api/pull",
            json={"model": config.LLM_MODEL, "stream": True},
            timeout=None,
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                try:
                    status = json.loads(line).get("status", "")
                except json.JSONDecodeError:
                    continue
                if status == "success" or status.startswith("verifying"):
                    log.info("pull: %s", status)
        log.info("local LLM %s downloaded", config.LLM_MODEL)

    # Warm: a 1-token generate loads the weights into RAM so the first real
    # request isn't paying the cold-start cost.
    try:
        _http().post(
            "/api/generate",
            json={
                "model": config.LLM_MODEL,
                "prompt": "ok",
                "stream": False,
                "keep_alive": -1,
                "options": {"num_predict": 1, "num_ctx": config.LLM_NUM_CTX},
            },
            timeout=180,
        )
        log.info("local LLM %s warmed and ready", config.LLM_MODEL)
    except Exception as exc:  # pragma: no cover
        log.warning("LLM warm-up failed: %s", exc)


def available() -> bool:
    return reachable() and model_present()


def generate_plan(
    message: str,
    layers: List[LayerInfo],
    snippets: List[Retrieved],
    history: List[ChatTurn],
    municipality_name: Optional[str],
    previous: Optional[GisOperation] = None,
    cancel: Optional[threading.Event] = None,
) -> PlanResult:
    if not reachable():
        raise LLMUnavailable(
            f"The local LLM service (Ollama at {config.OLLAMA_URL}) is not reachable."
        )
    if not model_present():
        raise LLMUnavailable(
            f"The local model '{config.LLM_MODEL}' is still downloading. Try again shortly."
        )

    messages = _fit_messages(message, layers, snippets, history, municipality_name, previous)

    def _chat(fmt) -> str:
        payload = {
            "model": config.LLM_MODEL,
            "messages": messages,
            "stream": False,
            "keep_alive": -1,  # keep the model resident between requests
            "options": {"temperature": config.LLM_TEMPERATURE, "num_ctx": config.LLM_NUM_CTX},
        }
        if fmt is not None:
            payload["format"] = fmt
        return _stream_chat(payload, cancel)

    mode = config.LLM_FORMAT_MODE
    primary = (
        PLAN_JSON_SCHEMA if mode == "schema" else ("json" if mode == "json" else None)
    )
    content = _chat(primary)
    data = _parse_json(content)
    if data is None and primary is not None:
        log.warning("constrained decode unparseable, retrying prompt-only")
        data = _parse_json(_chat(None))
    if data is None:
        return PlanResult(
            answer_kind="unsupported",
            explanation="I couldn't turn that into a GIS operation. Try rephrasing "
            "with the layer names and a distance.",
        )
    try:
        return PlanResult.model_validate(data)
    except Exception:
        return PlanResult(
            answer_kind="unsupported",
            explanation=str(data.get("explanation") or "")
            or "I couldn't produce a valid GIS operation for that request.",
        )


# Rough chars-per-token for this prompt mix (English + identifiers + JSON);
# kept low on purpose so the estimate errs on the side of fitting.
_CHARS_PER_TOKEN = 3.0
# Room left for the model's JSON answer.
_OUTPUT_RESERVE_TOKENS = 600


def _estimate_tokens(messages: list[dict]) -> int:
    return int(sum(len(m["content"]) + 8 for m in messages) / _CHARS_PER_TOKEN)


def _fit_messages(
    message: str,
    layers: List[LayerInfo],
    snippets: List[Retrieved],
    history: List[ChatTurn],
    municipality_name: Optional[str],
    previous: Optional[GisOperation] = None,
) -> list[dict]:
    """Builds the chat so it fits LLM_NUM_CTX AND re-uses Ollama's prompt
    cache. Order: [system: rules + every layer/field] [examples] — identical
    for every request of a municipality, so cached — then [history] and
    [question-specific values + request], the only part read fresh.

    Ollama silently drops the START of an over-long prompt (the rules), so
    when it does not fit, trim the per-question parts first (retrieval
    context, history, samples); the cached layer list goes compact and the
    examples shrink only as a last resort."""
    budget = config.LLM_NUM_CTX - _OUTPUT_RESERVE_TOKENS
    focus = set(mentioned_layer_codes(message, layers))
    turns = [{"role": t.role, "content": t.content} for t in history[-6:]]
    # (compact layer list, examples, keep history, samples, retrieval context)
    steps = [
        (False, prompts.FEWSHOT, True, 3, True),
        (False, prompts.FEWSHOT, True, 3, False),
        (False, prompts.FEWSHOT, False, 3, False),
        (False, prompts.FEWSHOT, False, 0, False),
        (True, prompts.FEWSHOT, False, 3, False),
        (True, prompts.FEWSHOT[:6], False, 0, False),
    ]
    attempt: list[dict] = []
    for i, (compact, few, keep_history, samples, with_ctx) in enumerate(steps):
        attempt = [
            {"role": "system", "content": prompts.build_system_prompt(layers, compact)},
            *few,
            *(turns if keep_history else []),
            {"role": "user", "content": prompts.build_user_message(message, layers, snippets, focus, samples, with_ctx, previous)},
        ]
        if _estimate_tokens(attempt) <= budget:
            if i:
                log.info(
                    "prompt trimmed to fit %s tokens: compact=%s examples=%s history=%s samples=%s context=%s",
                    config.LLM_NUM_CTX, compact, len(few) // 2, keep_history, samples, with_ctx,
                )
            return attempt
    log.warning("prompt still ~%s tokens over a %s context", _estimate_tokens(attempt), config.LLM_NUM_CTX)
    return attempt


CHAT_SYSTEM = """You are the AI Assistant of a municipal GIS platform{where}.
Reply in 1-3 short, friendly sentences, in the user's language.
You do not see the map data in this reply: NEVER state numbers, places,
feature names or results. If the user wants data, tell them how to ask,
e.g. "Show signals in ward 5" or "How many landmarks are there in each zone?".
Available layers: {layers}."""


def chat_reply(
    message: str,
    history: List[ChatTurn],
    layers: List[LayerInfo],
    municipality_name: Optional[str],
    cancel: Optional[threading.Event] = None,
) -> str:
    """Free conversation that is not a map question ("how can GIS help my
    city?"). Short, grounded in what the platform can do; no data claims."""
    if not available():
        raise LLMUnavailable(f"The local model '{config.LLM_MODEL}' is not ready yet.")
    system = CHAT_SYSTEM.format(
        where=f" for {municipality_name}" if municipality_name else "",
        layers=", ".join(l.name for l in layers) or "none",
    )
    messages = [{"role": "system", "content": system}]
    messages += [{"role": t.role, "content": t.content} for t in history[-4:]]
    messages.append({"role": "user", "content": message})
    return _stream_chat({
        "model": config.LLM_MODEL, "messages": messages, "keep_alive": -1,
        "options": {"temperature": 0.3, "num_ctx": config.LLM_NUM_CTX, "num_predict": 160},
    }, cancel)


def prime_plan_cache(layers: List[LayerInfo], municipality_name: Optional[str]) -> None:
    """Reads this municipality's plan prompt prefix (rules + layer list +
    examples) into Ollama's cache with a 1-token reply, so the user's first
    real question re-uses it (~7 s) instead of reading it cold (~40 s on
    CPU). Called when the AI Assistant panel opens."""
    if not available():
        return
    messages = _fit_messages("", layers, [], [], municipality_name)
    try:
        _http().post(
            "/api/chat",
            json={
                "model": config.LLM_MODEL,
                "messages": messages,
                "stream": False,
                "keep_alive": -1,
                "options": {"temperature": 0, "num_ctx": config.LLM_NUM_CTX, "num_predict": 1},
            },
        )
    except httpx.HTTPError as exc:
        log.warning("plan cache warm-up failed: %s", exc)


def _parse_json(text: str) -> Optional[dict]:
    if text.startswith("```"):
        text = text.strip("`")
        text = text[4:] if text.lower().startswith("json") else text
        text = text.strip("`").strip()
    for candidate in (text, _slice_braces(text)):
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def _slice_braces(text: str) -> str:
    start, end = text.find("{"), text.rfind("}")
    return text[start : end + 1] if 0 <= start < end else ""


# --------------------------------------------------------------------------
# Narration — verified facts -> a short plain-language answer.

_NUMBER = re.compile(r"(?<![\w.])-?\d[\d,]*(?:\.\d+)?")


def _numbers_in(text: str) -> List[str]:
    return [m.group(0).replace(",", "") for m in _NUMBER.finditer(text)]


def _fact_numbers(value: Any, out: List[float]) -> None:
    if isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        out.append(float(value))
    elif isinstance(value, str):
        out.extend(float(n) for n in _numbers_in(value))
    elif isinstance(value, dict):
        for v in value.values():
            _fact_numbers(v, out)
    elif isinstance(value, (list, tuple)):
        for v in value:
            _fact_numbers(v, out)


_NUMBER_WORDS = {
    w: i for i, w in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen "
        "fourteen fifteen sixteen seventeen eighteen nineteen twenty".split()
    )
}
_NUMBER_WORD = re.compile(r"\b(" + "|".join(_NUMBER_WORDS) + r")\b", re.I)
# The fact that answers the question; the wording must state it.
_HEADLINE_KEYS = ("matched", "totalFeatures", "features", "count")


def _headline(facts: dict) -> Optional[float]:
    for key in _HEADLINE_KEYS:
        value = facts.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def _grounded(text: str, allowed: List[float], headline: Optional[float] = None) -> bool:
    """Every number in `text` must be a fact number or a rounding of one —
    a 1.5b model will otherwise happily invent totals and percentages. Number
    words count too ("three groups" when there is one), and the main count
    must appear, or a number-free sentence could claim anything ("all signals
    are not working")."""
    if _NUMBER_WORD.search(text):
        return False
    if headline is not None and not any(
        abs(float(raw) - headline) < 1e-9 for raw in _numbers_in(text)
    ):
        return False
    for raw in _numbers_in(text):
        n = float(raw)
        decimals = len(raw.split(".")[1]) if "." in raw else 0
        tol = 0.5 * 10 ** (-decimals) + 1e-9
        if not any(abs(n - a) <= tol or abs(abs(n) - abs(a)) <= tol for a in allowed):
            return False
    return True


def narrate(kind: str, question: str, facts: dict) -> Tuple[str, bool]:
    if not available():
        raise LLMUnavailable(f"The local model '{config.LLM_MODEL}' is not ready yet.")
    facts_json = json.dumps(facts, ensure_ascii=False, default=str)[:6000]
    system = prompts.RASTER_SYSTEM if kind == "raster" else prompts.NARRATE_SYSTEM
    payload = {
        "model": config.LLM_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompts.build_narrate_message(question, facts_json)},
        ],
        "stream": False,
        "keep_alive": -1,
        "options": {
            "temperature": 0,
            "num_ctx": config.LLM_NUM_CTX,
            "num_predict": config.NARRATE_MAX_TOKENS,
        },
    }
    try:
        resp = _http().post("/api/chat", json=payload)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise LLMUnavailable(f"Local LLM request failed: {exc}") from exc
    text = ((resp.json().get("message", {}) or {}).get("content", "") or "").strip()
    text = re.sub(r"^[#>*\-\s]+", "", text).replace("**", "").strip()

    allowed: List[float] = []
    _fact_numbers(facts, allowed)
    _fact_numbers(question, allowed)
    headline = _headline(facts) if kind == "query" else None
    if not text or not _grounded(text, allowed, headline):
        log.info("narration rejected (ungrounded or empty): %r", text[:200])
        return text, False
    return text, True
