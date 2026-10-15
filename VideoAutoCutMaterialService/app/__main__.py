import asyncio
import selectors
import sys

import uvicorn

from .config import Settings


def create_windows_selector_loop() -> asyncio.AbstractEventLoop:
    return asyncio.SelectorEventLoop(selectors.SelectSelector())


def uvicorn_loop_factory(platform_name: str = sys.platform) -> str:
    return "app.__main__:create_windows_selector_loop" if platform_name == "win32" else "auto"


def main() -> None:
    settings = Settings.from_env()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        loop=uvicorn_loop_factory(),
    )


if __name__ == "__main__":
    main()
