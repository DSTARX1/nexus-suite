from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import redis.asyncio as aioredis
import psycopg2
from psycopg2 import pool
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import OneHotEncoder
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split

# ── globals ──────────────────────────────────────────────────────────
redis_client: aioredis.Redis | None = None
db_pool: pool.SimpleConnectionPool | None = None
embed_model: SentenceTransformer | None = None


# ── lifespan ─────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_app: FastAPI):
    global redis_client, db_pool, embed_model

    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    redis_client = aioredis.from_url(redis_url, decode_responses=True)

    db_url = os.environ.get("DATABASE_URL", "")
    if db_url:
        db_pool = pool.SimpleConnectionPool(1, 5, dsn=db_url)

    embed_model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

    Path("/models").mkdir(parents=True, exist_ok=True)

    yield

    if redis_client:
        await redis_client.aclose()
    if db_pool:
        db_pool.closeall()


# ── app ──────────────────────────────────────────────────────────────
app = FastAPI(title="ML Sidecar", lifespan=lifespan)


@app.exception_handler(Exception)
async def global_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": type(exc).__name__, "detail": str(exc)},
    )


# ── health ───────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    checks: dict[str, Any] = {}

    try:
        await redis_client.ping()
        checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"error: {e}"

    try:
        conn = db_pool.getconn()
        cur = conn.cursor()
        cur.execute("SELECT 1")
        cur.close()
        db_pool.putconn(conn)
        checks["db"] = "ok"
    except Exception as e:
        checks["db"] = f"error: {e}"

    status = "healthy" if all(v == "ok" for v in checks.values()) else "degraded"
    code = 200 if status == "healthy" else 503
    return JSONResponse(status_code=code, content={"status": status, **checks})


# ── embeddings ───────────────────────────────────────────────────────
class EmbeddingsRequest(BaseModel):
    texts: list[str]


@app.post("/embeddings")
async def embeddings(req: EmbeddingsRequest):
    vectors: np.ndarray = embed_model.encode(req.texts, normalize_embeddings=True)
    return {"embeddings": vectors.tolist()}


# ── bandit ────────────────────────────────────────────────────────────
class BanditRequest(BaseModel):
    org_id: str
    arms: list[str]
    context: dict[str, Any] | None = None


class BanditFeedbackRequest(BaseModel):
    org_id: str
    arm: str
    success: bool


def _bandit_key(org_id: str) -> str:
    return f"bandit:{org_id}"


async def _get_bandit_state(org_id: str, arms: list[str]) -> dict[str, dict[str, float]]:
    raw = await redis_client.get(_bandit_key(org_id))
    if raw:
        state = json.loads(raw)
    else:
        state = {}
    for arm in arms:
        if arm not in state:
            state[arm] = {"alpha": 1.0, "beta": 1.0}
    return state


@app.post("/predict/bandit")
async def predict_bandit(req: BanditRequest):
    state = await _get_bandit_state(req.org_id, req.arms)
    scores: dict[str, float] = {}
    for arm in req.arms:
        a = state[arm]["alpha"]
        b = state[arm]["beta"]
        scores[arm] = float(np.random.beta(a, b))
    selected = max(scores, key=scores.get)
    return {"selected_arm": selected, "scores": scores}


@app.post("/feedback/bandit")
async def feedback_bandit(req: BanditFeedbackRequest):
    state = await _get_bandit_state(req.org_id, [req.arm])
    if req.success:
        state[req.arm]["alpha"] += 1.0
    else:
        state[req.arm]["beta"] += 1.0
    await redis_client.set(_bandit_key(req.org_id), json.dumps(state))
    return {"status": "ok", "arm": req.arm, "state": state[req.arm]}


# ── adaptability ──────────────────────────────────────────────────────
PLATFORMS = ["youtube", "tiktok", "instagram", "twitter", "linkedin", "other"]
CONTENT_TYPES = ["video", "image", "text", "carousel", "story", "other"]
MODEL_PATH = Path("/models/adaptability.pkl")
ENCODER_PATH = Path("/models/adaptability_encoder.pkl")


class AdaptabilityFeatures(BaseModel):
    views: int = 0
    likes: int = 0
    comments: int = 0
    duration: float = 0.0
    platform: str = "other"
    content_type: str = Field(default="other", alias="content_type")


class AdaptabilityRequest(BaseModel):
    features: AdaptabilityFeatures


def _encode_features(features: AdaptabilityFeatures) -> np.ndarray:
    numerical = [features.views, features.likes, features.comments, features.duration]
    platform_onehot = [1.0 if features.platform == p else 0.0 for p in PLATFORMS]
    ctype_onehot = [1.0 if features.content_type == ct else 0.0 for ct in CONTENT_TYPES]
    return np.array(numerical + platform_onehot + ctype_onehot).reshape(1, -1)


@app.post("/predict/adaptability")
async def predict_adaptability(req: AdaptabilityRequest):
    if not MODEL_PATH.exists():
        return JSONResponse(
            status_code=503,
            content={"error": "model_not_found", "detail": "No trained model. Call POST /retrain first."},
        )
    model: RandomForestClassifier = joblib.load(MODEL_PATH)
    X = _encode_features(req.features)
    probas = model.predict_proba(X)[0]
    score = float(probas[1]) if len(probas) > 1 else float(probas[0])
    confidence = float(max(probas))
    return {"score": score, "confidence": confidence}


# ── retrain ───────────────────────────────────────────────────────────
@app.post("/retrain")
async def retrain():
    if not db_pool:
        return JSONResponse(status_code=503, content={"error": "no_db", "detail": "Database not configured."})

    conn = db_pool.getconn()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT views, likes, comments, duration, platform, content_type, adaptability_label
            FROM content_performance
            WHERE created_at > NOW() - INTERVAL '30 days'
        """)
        rows = cur.fetchall()
        cur.close()
    finally:
        db_pool.putconn(conn)

    if len(rows) < 10:
        return JSONResponse(
            status_code=400,
            content={"error": "insufficient_data", "detail": f"Need >=10 samples, got {len(rows)}."},
        )

    X_list = []
    y_list = []
    for row in rows:
        views, likes, comments, duration, platform, content_type, label = row
        feats = AdaptabilityFeatures(
            views=views, likes=likes, comments=comments,
            duration=float(duration), platform=platform, content_type=content_type,
        )
        X_list.append(_encode_features(feats).flatten())
        y_list.append(int(label))

    X = np.array(X_list)
    y = np.array(y_list)

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X_train, y_train)
    accuracy = float(accuracy_score(y_test, model.predict(X_test)))

    joblib.dump(model, MODEL_PATH)

    return {"status": "ok", "samples": len(rows), "accuracy": accuracy}
