#!/usr/bin/env python3
"""System Design Interview Coach — FastAPI + Pipecat SmallWebRTC + Moss.

Only cloud credentials required: MOSS_PROJECT_ID / MOSS_PROJECT_KEY.
STT = local Whisper, TTS = local Piper, LLM = local Ollama.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger
from moss import MossClient, QueryOptions
from pydantic import BaseModel, Field
from pipecat.adapters.schemas.direct_function import tool_options
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.ollama.llm import OLLamaLLMService
from pipecat.services.piper.tts import PiperTTSService
from pipecat.services.whisper.stt import Model as WhisperModel
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    IceCandidate,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

load_dotenv()

INDEX_NAME = os.getenv("MOSS_INDEX_NAME", "system-design-rubric")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "auto")
PIPER_VOICE = os.getenv("PIPER_VOICE", "en_US-lessac-medium")

BASE_SYSTEM_PROMPT = (
    "You are an expert System Design Interview Coach conducting a live voice interview. "
    "Ask probing follow-ups, push for trade-offs, and keep answers concise enough to speak aloud. "
    "Avoid markdown, bullets, and emojis. "
    "When the candidate finishes a substantive design answer: speak your short follow-up question "
    "in the same turn, and also call grade_candidate_answer with their answer text. "
    "Skip the tool for greetings, topic picks, or one-word clarifications. "
    "Never speak scores, grades, or improvement tips aloud — the assist panel shows those. "
    "Ignore tool/grade system notes; they are only for the assist panel."
)

moss_client: MossClient | None = None
moss_ready = False
active_bots = 0

ICE_SERVERS = [IceServer(urls="stun:stun.l.google.com:19302")]
small_webrtc_handler = SmallWebRTCRequestHandler(ice_servers=ICE_SERVERS)


class GradeResult(BaseModel):
    type: str = "grade_result"
    topic: str | None = None
    score: int = Field(ge=1, le=5)
    max_score: int = 5
    summary: str
    tips: list[str] = Field(default_factory=list)


class InterviewAssistState:
    """Shared question text for the Assist panel and grading tool."""

    def __init__(self) -> None:
        self.last_question: str | None = None
        self.bot_buf: list[str] = []
        self.bot_speaking: bool = False
        self._grade_generation: int = 0
        self._grade_tasks: set[asyncio.Task[None]] = set()
        self._grade_lock = asyncio.Lock()

    def begin_grading(self) -> int:
        """Start a new grading turn; invalidates any in-flight grade."""
        self._grade_generation += 1
        return self._grade_generation

    def invalidate_grading(self) -> None:
        """Discard in-flight grading (e.g. after barge-in)."""
        self._grade_generation += 1

    def grading_still_current(self, turn_id: int) -> bool:
        return turn_id == self._grade_generation

    def track_grade_task(self, task: asyncio.Task[None]) -> None:
        self._grade_tasks.add(task)
        task.add_done_callback(self._grade_tasks.discard)


class MossContextInjector(FrameProcessor):
    """Query Moss on each user turn and inject rubric context into the LLM prompt."""

    def __init__(
        self,
        client: MossClient,
        *,
        index_name: str = INDEX_NAME,
        top_k: int = 1,
        alpha: float = 0.6,
    ) -> None:
        super().__init__()
        self._client = client
        self._index_name = index_name
        self._top_k = top_k
        self._alpha = alpha
        self.last_moss_ms: float | None = None
        self.last_rubric_id: str | None = None
        self.last_rubric_text: str | None = None
        self.last_user_answer: str | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMContextFrame):
            await self._inject_rubric(frame)

        await self.push_frame(frame, direction)

    async def _inject_rubric(self, frame: LLMContextFrame) -> None:
        user_text = _last_user_text(frame.context)
        if not user_text:
            return

        self.last_user_answer = user_text
        started = time.perf_counter()
        try:
            results = await self._client.query(
                self._index_name,
                user_text,
                QueryOptions(top_k=self._top_k, alpha=self._alpha),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Moss query failed: {exc}")
            return

        elapsed_ms = (time.perf_counter() - started) * 1000.0
        reported = getattr(results, "time_taken_ms", None)
        self.last_moss_ms = float(reported) if isinstance(reported, (int, float)) else elapsed_ms

        if not results.docs:
            logger.info(f"Moss returned no docs ({self.last_moss_ms:.2f} ms)")
            return

        top = results.docs[0]
        self.last_rubric_id = top.id
        self.last_rubric_text = top.text
        rubric_block = (
            f"Context/Rubric Guidelines:\n"
            f"Matched topic id={top.id} score={top.score:.3f}\n"
            f"{top.text}"
        )
        _upsert_system_message(frame.context, f"{BASE_SYSTEM_PROMPT}\n\n{rubric_block}")
        logger.info(
            f"Moss retrieved '{top.id}' in {self.last_moss_ms:.2f} ms "
            f"(score={top.score:.3f})"
        )


class CoachQuestionEmitter(FrameProcessor):
    """Emit current_question only after a full coach utterance (no mid-turn flicker)."""

    def __init__(self, assist_state: InterviewAssistState) -> None:
        super().__init__()
        self._state = assist_state

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        # Welcome / queued speak frames may enter at the pipeline head.
        if isinstance(frame, TTSSpeakFrame) and frame.text.strip():
            self._state.bot_buf = [frame.text.strip() + " "]
            await self._maybe_emit_question(prefer_interrogative=False)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._state.bot_buf = []

        if isinstance(frame, LLMTextFrame) and frame.text:
            self._state.bot_buf.append(frame.text)

        # Emit once when the LLM finishes — not on BotStoppedSpeaking (barge-in flicker).
        if isinstance(frame, LLMFullResponseEndFrame):
            await self._maybe_emit_question(prefer_interrogative=True)

        await self.push_frame(frame, direction)

    async def _maybe_emit_question(self, *, prefer_interrogative: bool) -> None:
        question = _extract_question(
            "".join(self._state.bot_buf),
            prefer_interrogative=prefer_interrogative,
        )
        if not question or question == self._state.last_question:
            return
        # Ignore tiny fragments that flash during tools / interruptions.
        if len(question) < 12:
            return
        self._state.last_question = question
        await self.push_frame(
            RTVIServerMessageFrame(
                data={"type": "current_question", "text": question}
            ),
            FrameDirection.DOWNSTREAM,
        )


class InterruptionBridge(FrameProcessor):
    """Publish barge-in events and track when the coach is speaking."""

    def __init__(self, assist_state: InterviewAssistState) -> None:
        super().__init__()
        self._assist = assist_state

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, UserStartedSpeakingFrame) and self._assist.bot_speaking:
            self._assist.invalidate_grading()
            await self._emit({"type": "interruption", "interrupted": True})

        if isinstance(frame, InterruptionFrame) and self._assist.bot_speaking:
            self._assist.invalidate_grading()
            await self._emit({"type": "interruption", "interrupted": True})

        if isinstance(frame, BotStartedSpeakingFrame):
            self._assist.bot_speaking = True

        if isinstance(frame, BotStoppedSpeakingFrame):
            self._assist.bot_speaking = False

        await self.push_frame(frame, direction)

    async def _emit(self, payload: dict[str, Any]) -> None:
        await self.push_frame(
            RTVIServerMessageFrame(data=payload),
            FrameDirection.DOWNSTREAM,
        )


@tool_options(cancel_on_interruption=False, timeout_secs=90)
async def grade_candidate_answer(
    params: FunctionCallParams,
    answer: str,
    question: str | None = None,
) -> None:
    """Grade a candidate's substantive system design answer against the Moss rubric.

    Call this when the candidate finishes a substantive design answer (not for
    greetings, topic picks, or one-word clarifications). Do not narrate the score
    or tips aloud — the assist panel shows feedback.

    Args:
        answer: The candidate's last substantive reply to grade.
        question: Optional interview question being answered; defaults to the last coach question.
    """
    resources = params.app_resources or {}
    moss: MossContextInjector | None = resources.get("moss")
    assist: InterviewAssistState | None = resources.get("assist")

    answer_text = (answer or "").strip()
    if not answer_text and moss and moss.last_user_answer:
        answer_text = moss.last_user_answer
    if not answer_text:
        await params.result_callback(
            {
                "ok": False,
                "error": "empty_answer",
                "instruction": "Continue the spoken interview. Do not mention grading.",
            }
        )
        return

    question_text = (question or "").strip() or (
        (assist.last_question if assist else None) or "General system design answer"
    )
    rubric_id = moss.last_rubric_id if moss else None
    rubric_text = moss.last_rubric_text if moss else None
    turn_id = assist.begin_grading() if assist else 0

    await _queue_rtvi(
        params,
        {"type": "user_answer", "text": answer_text, "turn_id": turn_id},
    )
    await _queue_rtvi(
        params,
        {"type": "grading_started", "topic": rubric_id, "turn_id": turn_id},
    )

    # Ack immediately so Pipecat does not block speech or reinject a long grade into the LLM.
    await params.result_callback(
        {
            "ok": True,
            "status": "queued",
            "instruction": "Continue speaking your follow-up. Never read scores or tips aloud.",
        }
    )

    if assist is None:
        return

    worker = params.pipeline_worker

    async def _background_grade() -> None:
        try:
            # Let the coach finish speaking / TTFT before competing for Ollama GPU.
            await _wait_until_coach_quiet(assist, timeout_secs=12.0)
            if not assist.grading_still_current(turn_id):
                return
            async with assist._grade_lock:
                if not assist.grading_still_current(turn_id):
                    return
                # Brief extra settle so Whisper/Piper aren't fighting inference.
                await asyncio.sleep(0.35)
                if not assist.grading_still_current(turn_id):
                    return
                try:
                    result = await _silent_grade_answer(
                        question=question_text,
                        answer=answer_text,
                        rubric_id=rubric_id,
                        rubric_text=rubric_text,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(f"Background grader failed: {exc}")
                    result = GradeResult(
                        topic=rubric_id,
                        score=3,
                        summary=(
                            "Could not grade this turn automatically. "
                            "Keep covering trade-offs."
                        ),
                        tips=[
                            "State assumptions out loud before diving into components.",
                            "Compare at least two design alternatives with trade-offs.",
                            "Call out bottlenecks and how you would scale them.",
                        ],
                    )
            if not assist.grading_still_current(turn_id):
                return
            grade_payload = result.model_dump()
            grade_payload["turn_id"] = turn_id
            await worker.queue_frame(RTVIServerMessageFrame(data=grade_payload))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Background grade task crashed: {exc}")

    task = asyncio.create_task(_background_grade(), name=f"moss-grade-{turn_id}")
    assist.track_grade_task(task)


async def _queue_rtvi(params: FunctionCallParams, payload: dict[str, Any]) -> None:
    await params.pipeline_worker.queue_frame(RTVIServerMessageFrame(data=payload))


async def _wait_until_coach_quiet(
    assist: InterviewAssistState,
    *,
    timeout_secs: float,
) -> None:
    deadline = time.perf_counter() + timeout_secs
    # First wait out any active TTS / speaking window.
    while assist.bot_speaking and time.perf_counter() < deadline:
        await asyncio.sleep(0.12)
    # Small quiet period so a multi-segment utterance can finish.
    quiet_for = 0.0
    while time.perf_counter() < deadline:
        if assist.bot_speaking:
            quiet_for = 0.0
        else:
            quiet_for += 0.12
            if quiet_for >= 0.45:
                return
        await asyncio.sleep(0.12)


def _extract_question(
    coach_text: str,
    *,
    prefer_interrogative: bool = True,
) -> str | None:
    text = re.sub(r"\s+", " ", coach_text).strip()
    if not text:
        return None
    parts = re.split(r"(?<=[.?!])\s+", text)
    questions = [p.strip() for p in parts if "?" in p]
    if questions:
        return questions[-1]
    if prefer_interrogative:
        # Avoid flashing non-questions mid interview when tools interleave text.
        return None
    return parts[-1] if parts else text


def _parse_grade_json(raw: str) -> GradeResult:
    cleaned = raw.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1)
    else:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            cleaned = cleaned[start : end + 1]

    data = json.loads(cleaned)
    score = int(data.get("score", 3))
    score = max(1, min(5, score))
    tips_raw = data.get("tips") or []
    tips = [str(t).strip() for t in tips_raw if str(t).strip()][:4]
    return GradeResult(
        topic=str(data["topic"]) if data.get("topic") else None,
        score=score,
        summary=str(data.get("summary") or "Review the rubric points for this topic.").strip(),
        tips=tips
        or [
            "Call out concrete trade-offs.",
            "Name the bottleneck and how you scale it.",
        ],
    )


async def _silent_grade_answer(
    *,
    question: str,
    answer: str,
    rubric_id: str | None,
    rubric_text: str | None,
) -> GradeResult:
    rubric = rubric_text or "General system design grading rubric: clarity, trade-offs, scalability."
    prompt = (
        "You are a strict system design interview grader. "
        "Return ONLY valid JSON with keys: score (1-5 integer), summary (one sentence), "
        "tips (array of 2-4 short improvement strings), topic (string).\n\n"
        f"Topic id: {rubric_id or 'unknown'}\n"
        f"Rubric:\n{rubric}\n\n"
        f"Interview question:\n{question}\n\n"
        f"Candidate answer:\n{answer}\n"
    )
    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.post(
            f"{OLLAMA_BASE_URL}/chat/completions",
            json={
                "model": OLLAMA_MODEL,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": "Respond with JSON only. No markdown."},
                    {"role": "user", "content": prompt},
                ],
            },
        )
        resp.raise_for_status()
        payload = resp.json()
        content = payload["choices"][0]["message"]["content"]
    result = _parse_grade_json(content)
    if rubric_id and not result.topic:
        result.topic = rubric_id
    return result


def _last_user_text(context: LLMContext) -> str | None:
    for message in reversed(context.get_messages()):
        if not isinstance(message, dict):
            continue
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            chunks: list[str] = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    chunks.append(str(part.get("text", "")))
                elif isinstance(part, str):
                    chunks.append(part)
            joined = " ".join(chunks).strip()
            if joined:
                return joined
    return None


def _upsert_system_message(context: LLMContext, content: str) -> None:
    messages = list(context.get_messages())
    system_msg = {"role": "system", "content": content}
    if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system":
        messages[0] = system_msg
    else:
        messages.insert(0, system_msg)
    context.set_messages(messages)


def _resolve_whisper_model(name: str) -> str | WhisperModel:
    key = name.strip().lower().replace("-", "_")
    mapping = {
        "tiny": WhisperModel.TINY,
        "base": WhisperModel.BASE,
        "small": WhisperModel.SMALL,
        "medium": WhisperModel.MEDIUM,
        "large": WhisperModel.LARGE,
        "large_v3": WhisperModel.LARGE,
    }
    return mapping.get(key, name)


async def run_interview_bot(webrtc_connection: SmallWebRTCConnection) -> None:
    global active_bots
    if moss_client is None or not moss_ready:
        raise RuntimeError("Moss client is not ready. Run ingest_knowledge.py first.")

    active_bots += 1
    try:
        transport = SmallWebRTCTransport(
            webrtc_connection=webrtc_connection,
            params=TransportParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
            ),
        )

        stt = WhisperSTTService(
            device=WHISPER_DEVICE,
            settings=WhisperSTTService.Settings(model=_resolve_whisper_model(WHISPER_MODEL)),
        )
        llm = OLLamaLLMService(
            base_url=OLLAMA_BASE_URL,
            settings=OLLamaLLMService.Settings(
                model=OLLAMA_MODEL,
                system_instruction=BASE_SYSTEM_PROMPT,
            ),
        )
        tts = PiperTTSService(
            settings=PiperTTSService.Settings(voice=PIPER_VOICE),
        )

        moss_injector = MossContextInjector(moss_client, index_name=INDEX_NAME)
        assist_state = InterviewAssistState()

        context = LLMContext(
            messages=[{"role": "system", "content": BASE_SYSTEM_PROMPT}],
            tools=[grade_candidate_answer],
        )
        user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
        )

        question_emitter = CoachQuestionEmitter(assist_state)
        interruption_bridge = InterruptionBridge(assist_state)

        pipeline = Pipeline(
            [
                transport.input(),
                stt,
                user_aggregator,
                moss_injector,
                llm,
                question_emitter,
                interruption_bridge,
                tts,
                transport.output(),
                assistant_aggregator,
            ]
        )

        worker = PipelineWorker(
            pipeline,
            params=PipelineParams(
                enable_metrics=True,
                enable_usage_metrics=True,
            ),
            app_resources={
                "moss": moss_injector,
                "assist": assist_state,
            },
        )

        @transport.event_handler("on_client_connected")
        async def on_client_connected(transport: SmallWebRTCTransport, client: Any) -> None:
            logger.info("Client connected over SmallWebRTC")
            await asyncio.sleep(0.6)
            welcome = (
                "Welcome to your system design interview. "
                "Pick a topic—WhatsApp, rate limiting, sharding, CDNs, or the CAP theorem—"
                "and we will dive in."
            )
            assist_state.bot_buf = [welcome + " "]
            assist_state.last_question = _extract_question(
                welcome, prefer_interrogative=False
            )
            if assist_state.last_question:
                await worker.queue_frame(
                    RTVIServerMessageFrame(
                        data={
                            "type": "current_question",
                            "text": assist_state.last_question,
                        }
                    )
                )
            await worker.queue_frame(TTSSpeakFrame(welcome))

        @transport.event_handler("on_client_disconnected")
        async def on_client_disconnected(transport: SmallWebRTCTransport, client: Any) -> None:
            logger.info("Client disconnected; ending pipeline.")
            await worker.cancel()

        runner = WorkerRunner()
        await runner.add_workers(worker)
        await runner.run()
    finally:
        active_bots = max(0, active_bots - 1)


async def ensure_moss_loaded() -> None:
    global moss_client, moss_ready
    project_id = os.getenv("MOSS_PROJECT_ID", "").strip()
    project_key = os.getenv("MOSS_PROJECT_KEY", "").strip()
    if not project_id or not project_key:
        logger.warning("Moss credentials missing; server will start but interviews will fail.")
        return

    moss_client = MossClient(project_id, project_key)
    try:
        await moss_client.load_index(INDEX_NAME)
        moss_ready = True
        logger.info(f"Moss index '{INDEX_NAME}' loaded.")
    except Exception as exc:  # noqa: BLE001
        moss_ready = False
        logger.error(
            f"Failed to load Moss index '{INDEX_NAME}': {exc}. "
            "Run `python ingest_knowledge.py` first."
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_moss_loaded()
    yield


app = FastAPI(title="System Design Interview Coach", lifespan=lifespan)

cors_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    ollama_ok = False
    ollama_error: str | None = None
    try:
        base = OLLAMA_BASE_URL.removesuffix("/v1")
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{base}/api/tags")
            ollama_ok = resp.status_code == 200
            if not ollama_ok:
                ollama_error = f"status={resp.status_code}"
    except Exception as exc:  # noqa: BLE001
        ollama_error = str(exc)

    return {
        "ok": moss_ready and ollama_ok,
        "moss_ready": moss_ready,
        "moss_index": INDEX_NAME,
        "ollama_ok": ollama_ok,
        "ollama_error": ollama_error,
        "ollama_model": OLLAMA_MODEL,
        "whisper_model": WHISPER_MODEL,
        "piper_voice": PIPER_VOICE,
        "active_bots": active_bots,
    }


@app.post("/api/offer")
async def offer(request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    if not moss_ready:
        raise HTTPException(
            status_code=503,
            detail="Moss index not loaded. Run ingest_knowledge.py and restart the server.",
        )

    body = await request.json()

    async def webrtc_connection_callback(connection: SmallWebRTCConnection) -> None:
        background_tasks.add_task(run_interview_bot, connection)

    try:
        answer = await small_webrtc_handler.handle_web_request(
            request=SmallWebRTCRequest.from_dict(body),
            webrtc_connection_callback=webrtc_connection_callback,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to handle WebRTC offer")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return answer


@app.patch("/api/offer")
async def offer_patch(request: Request) -> dict[str, str]:
    body = await request.json()
    try:
        await small_webrtc_handler.handle_patch_request(
            SmallWebRTCPatchRequest(
                pc_id=body["pc_id"],
                candidates=[IceCandidate(**c) for c in body.get("candidates", [])],
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to patch WebRTC ICE candidates")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=os.getenv("BACKEND_HOST", "0.0.0.0"),
        port=int(os.getenv("BACKEND_PORT", "8000")),
        reload=True,
    )
