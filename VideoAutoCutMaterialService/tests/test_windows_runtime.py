from app.__main__ import create_windows_selector_loop, uvicorn_loop_factory


def test_windows_runtime_passes_selector_loop_factory_to_uvicorn() -> None:
    assert uvicorn_loop_factory("win32") == "app.__main__:create_windows_selector_loop"


def test_non_windows_runtime_keeps_uvicorn_auto_loop() -> None:
    assert uvicorn_loop_factory("linux") == "auto"


def test_windows_selector_loop_factory_creates_selector_loop() -> None:
    loop = create_windows_selector_loop()
    try:
        assert "SelectorEventLoop" in type(loop).__name__
    finally:
        loop.close()
