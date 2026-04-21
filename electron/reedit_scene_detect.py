"""
project:re-edit — PySceneDetect bridge for the Electron main process.

Invoked by the `analysis:detectScenes` IPC handler. Takes a video path and
detection params on argv, prints a single-line JSON blob to stdout. On
error we still print a JSON payload ({"success": false, "error": ...}) so
the Node side has exactly one thing to parse, and we mirror the error on
stderr for log collection. Exit code is 0 on success, 2 for "PySceneDetect
not installed" (so the UI can surface an actionable install hint), 1 for
everything else.

Schema (kept identical to the previous FFmpeg-based handler so the
renderer stays agnostic to which detector ran):

    {
      "success": true,
      "scenes": [
        {"index": 1, "id": "scene-001", "tcIn": 0.0, "tcOut": 2.5, "duration": 2.5},
        ...
      ]
    }
"""
from __future__ import annotations

import json
import os
import sys


def emit(payload: dict, exit_code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()
    sys.exit(exit_code)


def fail(msg: str, code: int = 1) -> None:
    sys.stderr.write(msg + "\n")
    emit({"success": False, "error": msg}, exit_code=code)


def main() -> None:
    if len(sys.argv) < 2:
        fail("Usage: reedit_scene_detect.py <video_path> [threshold] [min_scene_len_sec]")

    video_path = sys.argv[1]
    threshold = float(sys.argv[2]) if len(sys.argv) > 2 else 27.0
    min_scene_len_sec = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5

    if not os.path.isfile(video_path):
        fail(f"Video not found: {video_path}")

    try:
        from scenedetect import open_video, SceneManager, ContentDetector
    except ImportError:
        fail(
            "PySceneDetect is not installed. Run:\n"
            "  pip install scenedetect[opencv-headless]",
            code=2,
        )

    try:
        video = open_video(video_path)
        # `frame_rate` is the authoritative fps on the VideoStream the
        # library is about to walk. Falling back to 24 keeps this robust
        # against exotic inputs; the detector is still dominated by the
        # threshold, not min_scene_len.
        fps = float(getattr(video, "frame_rate", 0)) or 24.0

        # ContentDetector takes min_scene_len as an integer number of
        # frames in scenedetect 0.6.x. Passing a "1.5s" string triggers
        # an int-vs-str comparison crash deep inside the library.
        min_frames = max(1, int(round(min_scene_len_sec * fps)))

        scene_manager = SceneManager()
        scene_manager.add_detector(
            ContentDetector(threshold=threshold, min_scene_len=min_frames)
        )
        # `show_progress=False` keeps the tqdm bar off stderr; we want
        # stderr clean so the Node-side error path has a clear signal.
        scene_manager.detect_scenes(video, show_progress=False)
        scene_list = scene_manager.get_scene_list()
    except Exception as err:  # noqa: BLE001 — surface whatever PySceneDetect raised
        fail(f"PySceneDetect failed: {err}")

    out_scenes = []
    for i, (start, end) in enumerate(scene_list):
        tc_in = start.get_seconds()
        tc_out = end.get_seconds()
        out_scenes.append({
            "index": i + 1,
            "id": f"scene-{i + 1:03d}",
            "tcIn": tc_in,
            "tcOut": tc_out,
            "duration": tc_out - tc_in,
        })

    emit({"success": True, "scenes": out_scenes})


if __name__ == "__main__":
    main()
