"""ComfyUI HTTP API proxy — submit prompts, poll history, extract filenames."""

import asyncio
import logging
import time

import httpx

logger = logging.getLogger("gpu-manager.comfyui")

# Timeout for individual HTTP requests to ComfyUI
REQUEST_TIMEOUT = 30.0


class ComfyUIProxy:
    def __init__(self, comfyui_url: str) -> None:
        self.comfyui_url = comfyui_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=REQUEST_TIMEOUT)

    async def check_connection(self) -> bool:
        """Check if ComfyUI is reachable."""
        try:
            resp = await self._client.get(f"{self.comfyui_url}/system_stats")
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def generate(self, payload: dict) -> dict:
        """Submit prompt to ComfyUI, poll until complete, return filenames."""
        prompt = payload["prompt"]
        timeout_ms = payload.get("timeout", 600_000)

        # Submit prompt
        resp = await self._client.post(
            f"{self.comfyui_url}/prompt",
            json={"prompt": prompt},
        )
        resp.raise_for_status()
        prompt_id = resp.json()["prompt_id"]
        logger.info("Submitted prompt %s to ComfyUI", prompt_id)

        # Poll history
        history = await self._poll_history(prompt_id, timeout_ms / 1000)

        # Extract filenames
        filenames = self._extract_filenames(history)
        logger.info("Prompt %s complete: %s", prompt_id, filenames)

        return {
            "prompt_id": prompt_id,
            "filenames": filenames,
            "history": history,
        }

    async def _poll_history(
        self, prompt_id: str, timeout_s: float
    ) -> dict:
        """Poll GET /history/{prompt_id}: wait 10s before first poll, then 2s→8s backoff."""
        deadline = time.monotonic() + timeout_s

        # Image generation rarely finishes in <10s — skip early polling entirely
        # to avoid hammering ComfyUI (and exhausting ephemeral ports).
        await asyncio.sleep(10.0)

        delay = 2.0
        while time.monotonic() < deadline:
            try:
                resp = await self._client.get(
                    f"{self.comfyui_url}/history/{prompt_id}"
                )
                data = resp.json()
                if prompt_id in data:
                    return data[prompt_id]
            except httpx.HTTPError as e:
                logger.warning("Poll error: %s", e)

            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 8.0)

        # Timeout — try to cancel
        try:
            await self._client.post(
                f"{self.comfyui_url}/queue",
                json={"delete": [prompt_id]},
            )
        except httpx.HTTPError:
            pass
        raise TimeoutError(f"ComfyUI prompt {prompt_id} timed out")

    @staticmethod
    def _extract_filenames(history_entry: dict) -> list[str]:
        """Extract image/audio filenames from ComfyUI history output."""
        filenames: list[str] = []
        outputs = history_entry.get("outputs", {})
        for _node_id, node_out in outputs.items():
            for key in ("images", "audio"):
                items = node_out.get(key, [])
                if isinstance(items, list):
                    for item in items:
                        if isinstance(item, dict) and "filename" in item:
                            filenames.append(item["filename"])
        return filenames

    async def close(self) -> None:
        await self._client.aclose()
