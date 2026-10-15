from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_DIR))

import video_encoder  # noqa: E402


class EncoderMappingTests(unittest.TestCase):
    def test_names_and_ffmpeg_aliases_map_to_immutable_specs(self) -> None:
        cases = {
            "cpu": video_encoder.CPU_ENCODER,
            "libx264": video_encoder.CPU_ENCODER,
            "intel": video_encoder.INTEL_ENCODER,
            "h264_qsv": video_encoder.INTEL_ENCODER,
            "amd": video_encoder.AMD_ENCODER,
            "h264_amf": video_encoder.AMD_ENCODER,
            "nvidia": video_encoder.NVIDIA_ENCODER,
            "h264_nvenc": video_encoder.NVIDIA_ENCODER,
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertIs(video_encoder.encoder_by_name(value), expected)

        with self.assertRaises((AttributeError, TypeError)):
            video_encoder.CPU_ENCODER.codec = "broken"  # type: ignore[misc]

    def test_quality_arguments_are_encoder_specific_and_numeric(self) -> None:
        cpu = video_encoder.encoder_arguments(video_encoder.CPU_ENCODER, 18.4)
        qsv = video_encoder.encoder_arguments(video_encoder.INTEL_ENCODER, 19)
        amf = video_encoder.encoder_arguments(video_encoder.AMD_ENCODER, 20)
        nvenc = video_encoder.encoder_arguments(video_encoder.NVIDIA_ENCODER, 21)

        self.assertEqual(cpu[cpu.index("-crf") + 1], "18")
        self.assertEqual(qsv[qsv.index("-global_quality") + 1], "19")
        self.assertEqual(amf[amf.index("-qp_i") + 1], "18")
        self.assertEqual(amf[amf.index("-qp_p") + 1], "20")
        self.assertEqual(amf[amf.index("-qp_b") + 1], "22")
        self.assertEqual(nvenc[nvenc.index("-qp") + 1], "21")
        self.assertNotIn("-crf", qsv + amf + nvenc)

    def test_pixel_format_is_appended_after_ass_filter(self) -> None:
        base = "scale=1920:1080,ass='overlay.ass'"

        self.assertEqual(
            video_encoder.append_pixel_format_filter(base, video_encoder.INTEL_ENCODER),
            base + ",format=nv12",
        )
        self.assertEqual(
            video_encoder.append_pixel_format_filter(base, video_encoder.AMD_ENCODER),
            base + ",format=nv12",
        )
        self.assertEqual(
            video_encoder.append_pixel_format_filter(base, video_encoder.NVIDIA_ENCODER),
            base + ",format=yuv420p",
        )
        self.assertEqual(
            video_encoder.append_pixel_format_filter(base, video_encoder.CPU_ENCODER),
            base + ",format=yuv420p",
        )


class EncoderResolutionTests(unittest.TestCase):
    def test_electron_resolved_encoder_does_not_probe_again(self) -> None:
        benchmark = mock.Mock(side_effect=AssertionError("must not benchmark"))

        selected = video_encoder.resolve_encoder(
            "ffmpeg",
            environ={"VIDEOAUTO_VIDEO_ENCODER_RESOLVED": "intel"},
            benchmark=benchmark,
        )

        self.assertIs(selected, video_encoder.INTEL_ENCODER)
        benchmark.assert_not_called()

    def test_standalone_auto_benchmarks_cpu_and_hardware_then_uses_fastest(self) -> None:
        attempts: list[tuple[str, float]] = []
        timings = {
            "cpu": 1.2,
            "nvidia": 0.8,
            "amd": None,
            "intel": 0.35,
        }

        def benchmark(
            _ffmpeg: str,
            encoder: video_encoder.EncoderSpec,
            timeout: float,
        ) -> float | None:
            attempts.append((encoder.key, timeout))
            return timings[encoder.key]

        selected = video_encoder.resolve_encoder(
            "ffmpeg",
            environ={},
            benchmark=benchmark,
        )

        self.assertIs(selected, video_encoder.INTEL_ENCODER)
        self.assertEqual(
            [key for key, _timeout in attempts],
            ["cpu", "nvidia", "amd", "intel"],
        )
        self.assertTrue(
            all(
                0 < timeout <= video_encoder.BENCHMARK_ITEM_TIMEOUT_SECONDS
                for _key, timeout in attempts
            )
        )

    def test_existing_fallback_marker_forces_cpu_without_probe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "state" / "fallback.flag"
            marker.parent.mkdir()
            marker.touch()
            benchmark = mock.Mock(side_effect=AssertionError("must not benchmark"))

            selected = video_encoder.resolve_encoder(
                "ffmpeg",
                environ={
                    "VIDEOAUTO_VIDEO_ENCODER_RESOLVED": "nvidia",
                    "VIDEOAUTO_VIDEO_ENCODER_FALLBACK_FILE": str(marker),
                },
                benchmark=benchmark,
            )

        self.assertIs(selected, video_encoder.CPU_ENCODER)
        benchmark.assert_not_called()

    def test_benchmark_executes_a_real_encode_with_item_timeout(self) -> None:
        runner = mock.Mock()
        clock = mock.Mock(side_effect=[10.0, 10.4])

        elapsed = video_encoder.benchmark_encoder(
            "ffmpeg-test",
            video_encoder.INTEL_ENCODER,
            timeout=2.25,
            runner=runner,
            clock=clock,
        )

        self.assertAlmostEqual(elapsed or 0, 0.4)
        command = runner.call_args.args[0]
        self.assertEqual(command[0], "ffmpeg-test")
        self.assertIn("-frames:v", command)
        self.assertEqual(
            command[command.index("-frames:v") + 1],
            str(video_encoder.BENCHMARK_FRAMES),
        )
        self.assertIn("h264_qsv", command)
        self.assertEqual(runner.call_args.kwargs["check"], True)
        self.assertEqual(runner.call_args.kwargs["timeout"], 2.25)

    def test_standalone_benchmark_respects_total_budget(self) -> None:
        now = [0.0]
        allocated: list[float] = []

        def clock() -> float:
            return now[0]

        def benchmark(
            _ffmpeg: str,
            _encoder: video_encoder.EncoderSpec,
            timeout: float,
        ) -> float:
            allocated.append(timeout)
            now[0] += timeout
            return timeout

        video_encoder.resolve_encoder(
            "ffmpeg",
            environ={},
            benchmark=benchmark,
            clock=clock,
        )

        self.assertLessEqual(
            sum(allocated),
            video_encoder.BENCHMARK_TOTAL_BUDGET_SECONDS,
        )


class HardwareFallbackTests(unittest.TestCase):
    def test_hardware_failure_removes_partial_output_marks_and_retries_cpu(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "segment.mp4"
            output.write_bytes(b"partial")
            marker = root / "nested" / "fallback.flag"
            calls: list[tuple[list[str], float]] = []

            def command_for(encoder: video_encoder.EncoderSpec) -> list[str]:
                return [encoder.codec, str(output)]

            def runner(command: list[str], timeout: float) -> None:
                calls.append((command, timeout))
                if len(calls) == 1:
                    raise subprocess.CalledProcessError(1, command)
                self.assertFalse(output.exists())
                self.assertTrue(marker.exists())
                output.write_bytes(b"x" * 2048)

            selected = video_encoder.run_with_hardware_fallback(
                video_encoder.NVIDIA_ENCODER,
                output=output,
                duration_seconds=12,
                command_for=command_for,
                runner=runner,
                marker=marker,
            )

            self.assertIs(selected, video_encoder.CPU_ENCODER)
            self.assertEqual(calls[0][0][0], "h264_nvenc")
            self.assertEqual(calls[1][0][0], "libx264")
            self.assertEqual(
                calls[0][1],
                video_encoder.encode_timeout_seconds(12, video_encoder.NVIDIA_ENCODER),
            )
            self.assertEqual(
                calls[1][1],
                video_encoder.encode_timeout_seconds(12, video_encoder.CPU_ENCODER),
            )
            self.assertEqual(output.stat().st_size, 2048)

    def test_cpu_failure_is_not_retried(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "partial.mp4"
            output.write_bytes(b"partial")
            runner = mock.Mock(side_effect=subprocess.CalledProcessError(1, ["ffmpeg"]))

            with self.assertRaises(subprocess.CalledProcessError):
                video_encoder.run_with_hardware_fallback(
                    video_encoder.CPU_ENCODER,
                    output=output,
                    duration_seconds=4,
                    command_for=lambda encoder: [encoder.codec],
                    runner=runner,
                )

            self.assertFalse(output.exists())
            runner.assert_called_once()

    def test_hardware_timeout_marks_then_cpu_timeout_is_raised_without_loop(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "partial.mp4"
            marker = root / "fallback.flag"
            calls: list[str] = []

            def runner(command: list[str], timeout: float) -> None:
                del timeout
                calls.append(command[0])
                output.write_bytes(b"partial")
                raise subprocess.TimeoutExpired(command, 1)

            with self.assertRaises(subprocess.TimeoutExpired):
                video_encoder.run_with_hardware_fallback(
                    video_encoder.INTEL_ENCODER,
                    output=output,
                    duration_seconds=6,
                    command_for=lambda encoder: [encoder.codec],
                    runner=runner,
                    marker=marker,
                )

            self.assertEqual(calls, ["h264_qsv", "libx264"])
            self.assertTrue(marker.exists())
            self.assertFalse(output.exists())

    def test_cpu_os_error_is_cleaned_and_raised(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "partial.mp4"

            def runner(_command: list[str], _timeout: float) -> None:
                output.write_bytes(b"partial")
                raise OSError("ffmpeg unavailable")

            with self.assertRaises(OSError):
                video_encoder.run_with_hardware_fallback(
                    video_encoder.CPU_ENCODER,
                    output=output,
                    duration_seconds=4,
                    command_for=lambda encoder: [encoder.codec],
                    runner=runner,
                )

            self.assertFalse(output.exists())

    def test_timeouts_scale_with_duration_and_are_capped(self) -> None:
        short_hardware = video_encoder.encode_timeout_seconds(
            2,
            video_encoder.NVIDIA_ENCODER,
        )
        long_hardware = video_encoder.encode_timeout_seconds(
            120,
            video_encoder.NVIDIA_ENCODER,
        )
        short_cpu = video_encoder.encode_timeout_seconds(2, video_encoder.CPU_ENCODER)
        long_cpu = video_encoder.encode_timeout_seconds(120, video_encoder.CPU_ENCODER)

        self.assertGreater(long_hardware, short_hardware)
        self.assertGreater(long_cpu, short_cpu)
        self.assertGreater(short_cpu, short_hardware)
        self.assertLessEqual(long_hardware, 600)
        self.assertLessEqual(long_cpu, 1200)


class GeneratedMaterialEncoderTests(unittest.TestCase):
    def test_remotion_uses_safe_optional_hardware_acceleration(self) -> None:
        renderer = (TOOLS_DIR / "material_gen" / "remotion" / "render.mjs").read_text(
            encoding="utf-8",
        )
        self.assertIn("hardwareAcceleration: 'if-possible'", renderer)


if __name__ == "__main__":
    unittest.main()
