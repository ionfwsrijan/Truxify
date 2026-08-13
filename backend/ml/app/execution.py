"""Bounded execution helpers for CPU-bound / blocking ML work.

FastAPI async endpoints must never run CPU-bound inference or blocking I/O
directly on the event loop: a single expensive request would stall every
other request, including ``/health``.  This module provides shared, bounded
``ThreadPoolExecutor`` instances plus ``asyncio.Semaphore`` guards so
expensive work is executed off the event loop with a configurable concurrency
cap and deterministic backpressure (HTTP 503 when saturated).

Inference and training use **separate** executors and semaphores.  A long
model retrain (``train_model`` runs for minutes) must never occupy the
inference workers that serve real-time ``/predict`` requests, otherwise a
single training job starves the pool and ETA latency spikes.  Training is
therefore offloaded to its own single-worker pool with a long queue timeout
so it yields to real-time traffic without being dropped outright.

Configuration (environment variables):

- ``ML_MAX_CONCURRENT_INFERENCE``         max in-flight inferences (default 4).
- ``ML_INFERENCE_MAX_WORKERS``            executor threads (default 4).
- ``ML_INFERENCE_QUEUE_TIMEOUT_SECONDS``  how long a request waits for an
  inference slot before the service sheds load with 503 (default 5.0).
- ``ML_MAX_CONCURRENT_TRAINING``          max in-flight trainings (default 1).
- ``ML_TRAINING_MAX_WORKERS``             executor threads (default 1).
- ``ML_TRAINING_QUEUE_TIMEOUT_SECONDS``   how long a request waits for a
  training slot before the service sheds load with 503 (default 300.0).

The executors have application/process lifetime: they are created once at
import time and reused for every request.  ``close_inference_executor`` and
``close_training_executor`` are wired into the FastAPI shutdown hook so no
worker threads leak.

The semaphores are per event loop (weakly referenced from the running loop).
``asyncio`` primitives bind to the loop that first awaits them, and the ML
service's unit tests exercise the app across many short-lived event loops
(one per ``TestClient`` / ``asyncio.run``); a single module-level semaphore
would raise ``RuntimeError: bound to a different event loop``.  In production
uvicorn runs exactly one loop, so capacity is still shared globally.
"""

import asyncio
import logging
import os
import weakref
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict

from fastapi import HTTPException

logger = logging.getLogger(__name__)

ML_MAX_CONCURRENT_INFERENCE = int(
    os.environ.get("ML_MAX_CONCURRENT_INFERENCE", "4")
)
ML_INFERENCE_MAX_WORKERS = int(os.environ.get("ML_INFERENCE_MAX_WORKERS", "4"))
ML_INFERENCE_QUEUE_TIMEOUT_SECONDS = float(
    os.environ.get("ML_INFERENCE_QUEUE_TIMEOUT_SECONDS", "5.0")
)

ML_MAX_CONCURRENT_TRAINING = int(
    os.environ.get("ML_MAX_CONCURRENT_TRAINING", "1")
)
ML_TRAINING_MAX_WORKERS = int(os.environ.get("ML_TRAINING_MAX_WORKERS", "1"))
ML_TRAINING_QUEUE_TIMEOUT_SECONDS = float(
    os.environ.get("ML_TRAINING_QUEUE_TIMEOUT_SECONDS", "300.0")
)

# The executor worker counts must never be smaller than their semaphore
# limits: every task that acquires a slot must be able to run promptly
# instead of piling up behind the executor's internal queue.
if ML_INFERENCE_MAX_WORKERS < ML_MAX_CONCURRENT_INFERENCE:
    logger.warning(
        "ML_INFERENCE_MAX_WORKERS (%d) < ML_MAX_CONCURRENT_INFERENCE (%d); "
        "raising workers to match the concurrency limit",
        ML_INFERENCE_MAX_WORKERS,
        ML_MAX_CONCURRENT_INFERENCE,
    )
    ML_INFERENCE_MAX_WORKERS = ML_MAX_CONCURRENT_INFERENCE

if ML_TRAINING_MAX_WORKERS < ML_MAX_CONCURRENT_TRAINING:
    logger.warning(
        "ML_TRAINING_MAX_WORKERS (%d) < ML_MAX_CONCURRENT_TRAINING (%d); "
        "raising workers to match the concurrency limit",
        ML_TRAINING_MAX_WORKERS,
        ML_MAX_CONCURRENT_TRAINING,
    )
    ML_TRAINING_MAX_WORKERS = ML_MAX_CONCURRENT_TRAINING

_inference_executor: ThreadPoolExecutor = ThreadPoolExecutor(
    max_workers=ML_INFERENCE_MAX_WORKERS,
    thread_name_prefix="ml-inference",
)
_training_executor: ThreadPoolExecutor = ThreadPoolExecutor(
    max_workers=ML_TRAINING_MAX_WORKERS,
    thread_name_prefix="ml-training",
)
# One semaphore per live event loop (weak refs so closed loops are reclaimed).
_inference_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary()
)
_training_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary()
)


def _get_semaphore() -> asyncio.Semaphore:
    """Return the inference semaphore bound to the currently running event loop."""
    loop = asyncio.get_running_loop()
    semaphore = _inference_semaphores.get(loop)
    if semaphore is None:
        semaphore = asyncio.Semaphore(ML_MAX_CONCURRENT_INFERENCE)
        _inference_semaphores[loop] = semaphore
    return semaphore


def _get_training_semaphore() -> asyncio.Semaphore:
    """Return the training semaphore bound to the currently running event loop."""
    loop = asyncio.get_running_loop()
    semaphore = _training_semaphores.get(loop)
    if semaphore is None:
        semaphore = asyncio.Semaphore(ML_MAX_CONCURRENT_TRAINING)
        _training_semaphores[loop] = semaphore
    return semaphore


def configure(
    *,
    max_concurrent: int = ML_MAX_CONCURRENT_INFERENCE,
    max_workers: int = ML_INFERENCE_MAX_WORKERS,
    queue_timeout: float = ML_INFERENCE_QUEUE_TIMEOUT_SECONDS,
) -> None:
    """Rebuild the inference executor and semaphore with the given limits.

    Used by tests to exercise backpressure deterministically.  In-flight work
    still holds a reference to the previous executor / semaphore and releases
    safely, so replacing them never leaks capacity.
    """
    global ML_MAX_CONCURRENT_INFERENCE, ML_INFERENCE_MAX_WORKERS
    global ML_INFERENCE_QUEUE_TIMEOUT_SECONDS, _inference_executor

    if max_workers < max_concurrent:
        logger.warning("max_workers raised to %d to match max_concurrent", max_concurrent)
        max_workers = max_concurrent

    ML_MAX_CONCURRENT_INFERENCE = max_concurrent
    ML_INFERENCE_MAX_WORKERS = max_workers
    ML_INFERENCE_QUEUE_TIMEOUT_SECONDS = queue_timeout

    _inference_executor.shutdown(wait=False, cancel_futures=False)
    _inference_executor = ThreadPoolExecutor(
        max_workers=max_workers,
        thread_name_prefix="ml-inference",
    )
    _inference_semaphores.clear()


def configure_training(
    *,
    max_concurrent: int = ML_MAX_CONCURRENT_TRAINING,
    max_workers: int = ML_TRAINING_MAX_WORKERS,
    queue_timeout: float = ML_TRAINING_QUEUE_TIMEOUT_SECONDS,
) -> None:
    """Rebuild the training executor and semaphore with the given limits.

    Training runs on its own bounded pool so a long retrain can never occupy
    the inference workers that serve real-time predictions.  In-flight work
    still holds a reference to the previous executor / semaphore and releases
    safely, so replacing them never leaks capacity.
    """
    global ML_MAX_CONCURRENT_TRAINING, ML_TRAINING_MAX_WORKERS
    global ML_TRAINING_QUEUE_TIMEOUT_SECONDS, _training_executor

    if max_workers < max_concurrent:
        logger.warning("max_workers raised to %d to match max_concurrent", max_concurrent)
        max_workers = max_concurrent

    ML_MAX_CONCURRENT_TRAINING = max_concurrent
    ML_TRAINING_MAX_WORKERS = max_workers
    ML_TRAINING_QUEUE_TIMEOUT_SECONDS = queue_timeout

    _training_executor.shutdown(wait=False, cancel_futures=False)
    _training_executor = ThreadPoolExecutor(
        max_workers=max_workers,
        thread_name_prefix="ml-training",
    )
    _training_semaphores.clear()


async def run_inference(func: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run ``func(*args, **kwargs)`` off the event loop under the concurrency cap.

    The callable is executed on a worker thread so neither CPU-bound inference
    nor blocking I/O (e.g. weather HTTP) can stall the event loop.

    When no inference slot is free within ``ML_INFERENCE_QUEUE_TIMEOUT_SECONDS``
    an ``HTTPException`` with status 503 is raised so the client can retry
    instead of queueing requests indefinitely.  Capacity is always released
    (also when the callable raises) and never leaked.
    """
    semaphore = _get_semaphore()
    try:
        await asyncio.wait_for(
            semaphore.acquire(),
            timeout=ML_INFERENCE_QUEUE_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "Inference capacity exhausted (limit=%d); returning 503",
            ML_MAX_CONCURRENT_INFERENCE,
        )
        raise HTTPException(
            status_code=503,
            detail="ML inference capacity exhausted; retry later",
        )

    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            _inference_executor,
            lambda: func(*args, **kwargs),
        )
    finally:
        semaphore.release()


async def run_training(func: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run ``func(*args, **kwargs)`` on the dedicated training executor.

    Training is CPU-bound and can run for minutes; it must never share the
    inference pool or real-time ``/predict`` requests would queue behind a
    retrain and starve.  The training executor is bounded separately, so a
    concurrent retrain request is shed with an ``HTTPException`` 503 after
    ``ML_TRAINING_QUEUE_TIMEOUT_SECONDS`` instead of piling up unbounded.
    Capacity is always released (also when the callable raises) and never
    leaked.
    """
    semaphore = _get_training_semaphore()
    try:
        await asyncio.wait_for(
            semaphore.acquire(),
            timeout=ML_TRAINING_QUEUE_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "Training capacity exhausted (limit=%d); returning 503",
            ML_MAX_CONCURRENT_TRAINING,
        )
        raise HTTPException(
            status_code=503,
            detail="ML training capacity exhausted; retry later",
        )

    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            _training_executor,
            lambda: func(*args, **kwargs),
        )
    finally:
        semaphore.release()


def inference_capacity() -> int:
    """Return the configured maximum number of concurrent inferences."""
    return ML_MAX_CONCURRENT_INFERENCE


def training_capacity() -> int:
    """Return the configured maximum number of concurrent trainings."""
    return ML_MAX_CONCURRENT_TRAINING


def close_inference_executor() -> None:
    """Gracefully stop the shared inference executor (app shutdown)."""
    _inference_executor.shutdown(wait=False, cancel_futures=False)
    logger.info("ML inference executor shut down")


def close_training_executor() -> None:
    """Gracefully stop the dedicated training executor (app shutdown)."""
    _training_executor.shutdown(wait=False, cancel_futures=False)
    logger.info("ML training executor shut down")
