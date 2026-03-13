"""Serial GPU task queue — one task at a time."""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Awaitable

logger = logging.getLogger("gpu-manager.queue")


class TaskType(str, Enum):
    COMFYUI = "comfyui"
    TTS = "tts"
    CREATE_VOICE = "create_voice"


TASK_TIMEOUTS: dict[TaskType, float] = {
    TaskType.COMFYUI: 600.0,      # 10 minutes
    TaskType.TTS: 120.0,          # 2 minutes
    TaskType.CREATE_VOICE: 300.0, # 5 minutes
}


@dataclass
class Task:
    type: TaskType
    payload: dict
    submitted_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class QueueStatus:
    queue_size: int
    current_task: dict | None


class QueueManager:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[tuple[Task, asyncio.Future]] = asyncio.Queue()
        self._current_task: Task | None = None
        self._handlers: dict[TaskType, Callable[[dict], Awaitable[Any]]] = {}

    def register_handler(
        self, task_type: TaskType, handler: Callable[[dict], Awaitable[Any]]
    ) -> None:
        self._handlers[task_type] = handler

    async def submit(self, task: Task) -> Any:
        """Submit a task and wait for completion."""
        future: asyncio.Future[Any] = asyncio.get_event_loop().create_future()
        await self._queue.put((task, future))
        return await future

    async def worker(self) -> None:
        """Process tasks one at a time, forever."""
        logger.info("Queue worker started")
        while True:
            task, future = await self._queue.get()
            self._current_task = task
            handler = self._handlers.get(task.type)
            if not handler:
                future.set_exception(ValueError(f"No handler for {task.type}"))
                self._current_task = None
                continue

            timeout = TASK_TIMEOUTS.get(task.type, 120.0)
            try:
                result = await asyncio.wait_for(handler(task.payload), timeout=timeout)
                future.set_result(result)
            except asyncio.TimeoutError:
                logger.error("Task %s timed out after %.0fs", task.type, timeout)
                future.set_exception(TimeoutError(f"Task timed out after {timeout}s"))
            except Exception as e:
                logger.error("Task %s failed: %s", task.type, e)
                future.set_exception(e)
            finally:
                self._current_task = None
                self._queue.task_done()

    def status(self) -> QueueStatus:
        current = None
        if self._current_task:
            current = {
                "type": self._current_task.type.value,
                "started_at": self._current_task.submitted_at.isoformat(),
            }
        return QueueStatus(queue_size=self._queue.qsize(), current_task=current)
