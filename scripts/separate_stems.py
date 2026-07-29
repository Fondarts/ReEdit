"""Separate a source video's audio into VO (vocals) + Music (no_vocals)
stems.

Two engines, same output contract:
  - demucs (default): htdemucs two-stem split. Fast, decent, already
    battle-tested here.
  - bsroformer: BS-RoFormer via the `audio-separator` package
    (pip install "audio-separator[gpu]"). State-of-the-art vocal
    isolation (SDR ~12.9 vs htdemucs' ~8) — noticeably better on hard
    material like chants, crowd singing and heavily produced mixes
    where Demucs leaves vocal bleed in the music stem.

Pipeline:
  1. Probe the source with ffprobe to confirm there's an audio stream.
  2. Extract the audio to a temporary stereo 44.1 kHz WAV with ffmpeg.
  3. Invoke `python -m demucs --two-stems vocals` which writes
     <tmp>/<model>/<basename>/vocals.wav + no_vocals.wav.
  4. Move + rename those files to <out_dir>/<prefix>_vocals.wav and
     <out_dir>/<prefix>_music.wav.
  5. Clean up the scratch directories.

Progress goes to stderr as `[stem] <stage>: <message>` lines so the
main-process handler that invoked this script (runPython in Electron)
can parse them and forward progress events to the renderer.

Usage:
  python separate_stems.py --src <video> --out-dir <dir> --out-prefix <basename>
                            [--engine demucs|bsroformer]
                            [--model htdemucs] [--device auto|cuda|cpu]
                            [--ffmpeg <path>] [--ffprobe <path>]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

# Windows consoles (and Electron pipes) default to cp1252, which chokes
# on the arrows in our log/help strings. Force UTF-8 like the sibling
# scripts do.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


def log(stage, message):
    # Progress lines are `[stem] stage: message` on stderr. The IPC
    # handler in electron/main.js matches this prefix and re-emits the
    # stage to the renderer.
    print(f"[stem] {stage}: {message}", file=sys.stderr, flush=True)


def probe_has_audio(ffprobe_bin, src):
    # Count audio streams without decoding the video. If ffprobe isn't
    # available at all we fall through and let demucs fail naturally —
    # better to surface the real error than to block on our check.
    if not ffprobe_bin or not os.path.exists(ffprobe_bin):
        return True
    try:
        out = subprocess.check_output([
            ffprobe_bin, "-v", "error",
            "-select_streams", "a",
            "-show_entries", "stream=codec_type",
            "-of", "json",
            src,
        ], stderr=subprocess.STDOUT)
        data = json.loads(out.decode("utf-8", errors="replace"))
        return bool(data.get("streams"))
    except (subprocess.CalledProcessError, json.JSONDecodeError, ValueError):
        return True


def extract_audio(ffmpeg_bin, src, dst_wav):
    # 16-bit PCM stereo 44.1 kHz — what Demucs trains on. Skipping video
    # decode with `-vn` keeps extraction fast on 1080p sources.
    if not ffmpeg_bin:
        ffmpeg_bin = "ffmpeg"
    cmd = [
        ffmpeg_bin, "-y", "-v", "error",
        "-i", src,
        "-vn",
        "-ac", "2",
        "-ar", "44100",
        "-c:a", "pcm_s16le",
        dst_wav,
    ]
    log("extracting", f"ffmpeg → {os.path.basename(dst_wav)}")
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise SystemExit(
            f"ffmpeg audio extraction failed (code {res.returncode}). "
            f"stderr tail: {res.stderr[-300:]}"
        )


def run_demucs(python_exe, wav_path, tmp_out, model, device):
    # Stream demucs stderr straight through — it prints progress percent
    # lines like "  2%|▌ ..." that the main process can surface.
    cmd = [
        python_exe, "-m", "demucs",
        "--two-stems", "vocals",
        "--device", device,
        "-n", model,
        "-o", tmp_out,
        wav_path,
    ]
    log("separating", f"demucs model={model} device={device}")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    # Pass everything demucs prints straight to our stderr so the parent
    # process sees it. Demucs uses carriage-return progress bars which
    # are fine for a terminal viewer but noisy for parsing — we prefix
    # each line so the parent can filter.
    last_percent_line = None
    for line in proc.stdout or []:
        stripped = line.rstrip("\r\n")
        if not stripped:
            continue
        if "%" in stripped:
            # Squash repeat percent lines to just the latest — cuts
            # ~1000x log volume on long videos.
            last_percent_line = stripped
            log("demucs_progress", stripped)
        else:
            log("demucs", stripped)
    code = proc.wait()
    if code != 0:
        tail = last_percent_line or "(no output)"
        raise SystemExit(f"demucs failed (code {code}). Last line: {tail}")


# The BS-RoFormer checkpoint used for the alternative engine. viperx's
# ep_317 build is the community-standard SOTA vocal model; audio-separator
# downloads it on first use (~600 MB) and caches it under its model dir.
BSROFORMER_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"


def run_bsroformer(wav_path, out_dir, prefix, device):
    try:
        from audio_separator.separator import Separator  # noqa: WPS433
    except ImportError:
        raise SystemExit(
            "audio-separator is not installed. Run:\n"
            '  pip install "audio-separator[gpu]"\n'
            "(or audio-separator[cpu] on machines without CUDA)"
        )

    log("separating", f"bs-roformer model={BSROFORMER_MODEL} device={device}")
    # audio-separator picks CUDA automatically when the [gpu] extra +
    # torch see a device; there's no explicit device kwarg on this API,
    # so `device` here is informational only.
    separator = Separator(
        output_dir=out_dir,
        output_format="wav",
        model_file_dir=os.path.join(tempfile.gettempdir(), "reedit_audio_separator_models"),
    )
    log("separating", "loading model (first run downloads ~600 MB)")
    separator.load_model(model_filename=BSROFORMER_MODEL)
    # custom_output_names writes straight to our final contract paths —
    # no post-hoc renaming, and re-runs overwrite in place like demucs.
    outputs = separator.separate(wav_path, custom_output_names={
        "Vocals": f"{prefix}_vocals",
        "Instrumental": f"{prefix}_music",
    })
    log("separating", f"bs-roformer wrote {len(outputs)} stems")
    dst_vocals = os.path.join(out_dir, f"{prefix}_vocals.wav")
    dst_music = os.path.join(out_dir, f"{prefix}_music.wav")
    if not os.path.exists(dst_vocals) or not os.path.exists(dst_music):
        raise SystemExit(
            f"bs-roformer finished but the expected stems are missing "
            f"(looked for {dst_vocals} and {dst_music}; got: {outputs})"
        )
    return dst_vocals, dst_music


def find_stems_dir(tmp_out, wav_basename):
    # Demucs writes to <tmp_out>/<model_name>/<basename>/ where
    # model_name is whatever it actually used (e.g. 'htdemucs'). We
    # don't hard-code the model dir because the model_name varies with
    # --model. Walk instead.
    if not os.path.isdir(tmp_out):
        return None
    for model_dir in os.listdir(tmp_out):
        candidate = os.path.join(tmp_out, model_dir, wav_basename)
        if os.path.isdir(candidate):
            return candidate
    return None


def move_stems(stems_dir, out_dir, prefix):
    src_vocals = os.path.join(stems_dir, "vocals.wav")
    src_music = os.path.join(stems_dir, "no_vocals.wav")
    if not os.path.exists(src_vocals):
        raise SystemExit(f"demucs did not produce vocals.wav at {src_vocals}")
    if not os.path.exists(src_music):
        raise SystemExit(f"demucs did not produce no_vocals.wav at {src_music}")
    dst_vocals = os.path.join(out_dir, f"{prefix}_vocals.wav")
    dst_music = os.path.join(out_dir, f"{prefix}_music.wav")
    # Overwrite in place so re-runs don't leave stale copies.
    for dst in (dst_vocals, dst_music):
        if os.path.exists(dst):
            os.remove(dst)
    shutil.move(src_vocals, dst_vocals)
    shutil.move(src_music, dst_music)
    return dst_vocals, dst_music


def resolve_device(requested):
    # 'auto' picks cuda when torch can see a GPU, else cpu. We avoid
    # importing torch unless the user asked for auto — importing it
    # loads ~500 MB and is slow on cold startup.
    if requested and requested != "auto":
        return requested
    try:
        import torch  # noqa: WPS433
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True, help="Path to source video.")
    p.add_argument("--out-dir", required=True, help="Directory for final WAV outputs.")
    p.add_argument("--out-prefix", required=True, help="Basename prefix for the two WAVs (e.g. 'scene-022' → scene-022_vocals.wav).")
    p.add_argument("--engine", default="demucs", choices=["demucs", "bsroformer"], help="Separation engine. demucs = htdemucs (fast, default); bsroformer = BS-RoFormer via audio-separator (best vocal isolation, handles chants/crowd vocals).")
    p.add_argument("--model", default="htdemucs", help="Demucs model name. htdemucs is the default balance of quality/speed; htdemucs_ft is higher quality but ~3x slower.")
    p.add_argument("--device", default="auto", help="'auto' (default), 'cuda', or 'cpu'.")
    p.add_argument("--ffmpeg", default=None, help="Path to ffmpeg binary. Falls back to PATH lookup.")
    p.add_argument("--ffprobe", default=None, help="Path to ffprobe binary. Used only to check for audio streams.")
    args = p.parse_args()

    if not os.path.isfile(args.src):
        raise SystemExit(f"Source video not found: {args.src}")
    os.makedirs(args.out_dir, exist_ok=True)

    log("starting", f"source={os.path.basename(args.src)} out={args.out_dir} prefix={args.out_prefix}")

    # 1. Audio presence check. If the video has no audio stream we
    #    exit cleanly with a specific message the main process can
    #    recognise instead of letting demucs crash confusingly.
    if not probe_has_audio(args.ffprobe, args.src):
        raise SystemExit("source video has no audio stream — nothing to separate")

    device = resolve_device(args.device)
    log("device", device)

    tmp_root = tempfile.mkdtemp(prefix="reedit_stems_")
    try:
        # 2. Extract to WAV.
        wav_path = os.path.join(tmp_root, "input.wav")
        extract_audio(args.ffmpeg, args.src, wav_path)

        # 3+4. Separate with the chosen engine. Both paths end with the
        #    same two files at the same names — the manifest contract
        #    (and everything downstream: ducking, dubs, VO cloning)
        #    doesn't know which engine ran.
        if args.engine == "bsroformer":
            dst_vocals, dst_music = run_bsroformer(wav_path, args.out_dir, args.out_prefix, device)
            effective_model = BSROFORMER_MODEL
        else:
            demucs_out = os.path.join(tmp_root, "demucs_out")
            os.makedirs(demucs_out, exist_ok=True)
            run_demucs(sys.executable, wav_path, demucs_out, args.model, device)
            log("finalizing", "moving stems to project dir")
            stems_dir = find_stems_dir(demucs_out, os.path.splitext(os.path.basename(wav_path))[0])
            if not stems_dir:
                raise SystemExit(f"could not locate demucs output dir under {demucs_out}")
            dst_vocals, dst_music = move_stems(stems_dir, args.out_dir, args.out_prefix)
            effective_model = args.model

        # 5. Final manifest line the parent parses to grab the paths.
        #    JSON on a single stdout line keeps the contract tight.
        manifest = {
            "vocalsPath": dst_vocals,
            "musicPath": dst_music,
            "engine": args.engine,
            "model": effective_model,
            "device": device,
        }
        print(json.dumps(manifest), flush=True)
        log("done", f"vocals={dst_vocals} music={dst_music}")
    finally:
        # Always wipe the scratch dir, even on error, so repeated runs
        # don't fill the temp partition.
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
