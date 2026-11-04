#!/usr/bin/env python3
"""Generate Pilion's six public narration scenes with installed edge-tts/FFmpeg.

Run: python3 scripts/generate-voiceover.py
Existing matching segments are reused. --regenerate explicitly replaces them.
No keys are needed. Only the public TEXTS below are sent to Edge's online TTS.
"""

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VOICE = "zh-CN-XiaoxiaoNeural"
RATE = "-3%"
PITCH = "+0Hz"
FPS = 30
TEXTS = [
    "你已经有自己的 AI Agent。现在，让它用上你的浏览器。",
    "安装一次，Claude Code 和 Codex 就能调用 Pilion。读网页，填表单，直接完成任务。",
    "每个对话，都有独立的任务空间。Agent 在后台工作，你继续浏览，互不打扰。",
    "关键操作，先问过你。过程可追溯，随时停止或接管。浏览器的控制权，始终在你手里。",
    "空间、固定标签和快捷搜索，把常用页面整理好。让 AI 的能力，进入你熟悉的日常。",
    "Pilion。你自己的浏览器，你自己的 Agent。现在，开始你的第一个任务。",
]
PLANNED_SECONDS = [8, 12, 11, 12, 10, 9]


def run(command, timeout=60):
    return subprocess.run(command, check=True, capture_output=True, text=True, timeout=timeout)


def timestamp(value):
    hours, minutes, seconds = value.replace(",", ".").split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def srt_time(seconds):
    milliseconds = round(seconds * 1000)
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def parse_subtitles(path, duration):
    cues = []
    for block in path.read_text(encoding="utf-8-sig").strip().split("\n\n"):
        lines = block.splitlines()
        if len(lines) < 3 or " --> " not in lines[1]:
            continue
        left, right = lines[1].split(" --> ")
        # Edge sometimes overlaps adjacent sentence boundaries by ~50 ms.
        start = max(timestamp(left), cues[-1]["end"] if cues else 0)
        end = min(timestamp(right), duration)
        if end <= start:
            raise ValueError(f"Invalid subtitle boundary in {path}")
        cues.append({"start": round(start, 3), "end": round(end, 3), "text": " ".join(lines[2:])})
    if not cues:
        raise ValueError(f"No sentence subtitles in {path}")
    return cues


def write_srt(path, cues):
    path.write_text(
        "\n\n".join(
            f"{index}\n{srt_time(cue['start'])} --> {srt_time(cue['end'])}\n{cue['text']}"
            for index, cue in enumerate(cues, 1)
        ) + "\n",
        encoding="utf-8",
    )


def duration_of(ffprobe, path):
    data = json.loads(run([
        ffprobe, "-v", "error", "-show_entries", "format=duration:stream=sample_rate,channels",
        "-of", "json", str(path),
    ]).stdout)
    duration = float(data["format"]["duration"])
    if duration <= 0 or path.stat().st_size < 1024:
        raise ValueError(f"Empty audio: {path}")
    return duration, data["streams"][0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "public/audio")
    parser.add_argument("--regenerate", action="store_true", help="Explicitly replace cached speech")
    args = parser.parse_args()
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise SystemExit("Installed ffmpeg and ffprobe are required; this script installs nothing.")
    import edge_tts
    import importlib.metadata

    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    scenes = []
    for number, text in enumerate(TEXTS, 1):
        stem = f"voice-{number:02}"
        audio, raw_srt, subtitle = [output / (stem + suffix) for suffix in (".mp3", ".raw.srt", ".srt")]
        cache = output / (stem + ".generation.json")
        signature = hashlib.sha256(json.dumps([VOICE, RATE, PITCH, text], ensure_ascii=False).encode()).hexdigest()
        matched = cache.exists() and json.loads(cache.read_text())["signature"] == signature
        if not (matched and audio.exists() and raw_srt.exists()) or args.regenerate:
            if audio.exists() and not args.regenerate:
                raise SystemExit(f"Unmatched existing {audio}; inspect before using --regenerate.")
            started = time.monotonic()
            with tempfile.TemporaryDirectory(prefix="pilion-tts-") as temporary:
                temp_audio, temp_srt = Path(temporary) / "speech.mp3", Path(temporary) / "speech.srt"
                run([
                    sys.executable, "-m", "edge_tts", "--voice", VOICE, f"--rate={RATE}",
                    f"--pitch={PITCH}", "--text", text, "--write-media", str(temp_audio),
                    "--write-subtitles", str(temp_srt), "--no-progress",
                ], timeout=45)
                duration, _ = duration_of(ffprobe, temp_audio)
                parse_subtitles(temp_srt, duration)
                shutil.copyfile(temp_audio, audio)
                shutil.copyfile(temp_srt, raw_srt)
            cache.write_text(json.dumps({
                "signature": signature, "generationSeconds": round(time.monotonic() - started, 3),
            }, indent=2) + "\n")
            print(f"Generated {stem}", flush=True)
        else:
            print(f"Reused {stem}; no network request", flush=True)
        duration, stream = duration_of(ffprobe, audio)
        cues = parse_subtitles(raw_srt, duration)
        write_srt(subtitle, cues)
        scenes.append({
            "id": number, "file": f"audio/{audio.name}", "duration": round(duration, 6),
            "text": text, "subtitleFile": f"audio/{subtitle.name}", "subtitles": cues,
            "sampleRate": int(stream["sample_rate"]), "channels": stream["channels"],
        })
        print(f"  {duration:.3f}s / {len(cues)} sentence cues", flush=True)

    minimum_frames = [math.ceil((scene["duration"] + 0.9) * FPS) for scene in scenes]
    target_frames = max(62 * FPS, sum(minimum_frames))
    if target_frames > 65 * FPS:
        raise SystemExit("Speech requires over 65s including pauses. Shorten copy; do not accelerate.")
    slots = [max(planned * FPS, minimum) for planned, minimum in zip(PLANNED_SECONDS, minimum_frames)]
    # Borrow spare frames from roomier scenes if one narration exceeds its storyboard slot.
    while sum(slots) > target_frames:
        index = max(range(6), key=lambda i: slots[i] - minimum_frames[i])
        slots[index] -= 1
    while sum(slots) < target_frames:
        slots[-1] += 1
    timeline_cues, cursor = [], 0
    with tempfile.TemporaryDirectory(prefix="pilion-voice-mix-") as temporary:
        padded = []
        for scene, frames in zip(scenes, slots):
            scene.update({"startFrame": cursor, "start": cursor / FPS,
                          "sceneDurationFrames": frames, "sceneDuration": frames / FPS,
                          "audioOffset": 0.25})
            padded_path = Path(temporary) / f"scene-{scene['id']:02}.wav"
            # Delay and pad only; no time stretching or speed adjustment.
            run([ffmpeg, "-y", "-v", "error", "-i", str(output / Path(scene["file"]).name),
                 "-af", "adelay=250:all=1,apad", "-t", str(frames / FPS),
                 "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(padded_path)])
            padded.append(padded_path)
            for cue in scene["subtitles"]:
                offset = scene["start"] + scene["audioOffset"]
                timeline_cues.append({"start": round(offset + cue["start"], 3),
                                      "end": round(offset + cue["end"], 3), "text": cue["text"]})
            cursor += frames
        concat = Path(temporary) / "concat.txt"
        concat.write_text("".join(f"file '{path}'\n" for path in padded))
        wav = output / "voiceover-full.wav"
        run([ffmpeg, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(concat),
             "-c:a", "pcm_s16le", str(wav)])
        run([ffmpeg, "-y", "-v", "error", "-i", str(wav), "-c:a", "libmp3lame", "-b:a", "160k",
             str(output / "voiceover-full.mp3")])
    write_srt(output / "voiceover-full.srt", timeline_cues)
    full_duration, _ = duration_of(ffprobe, output / "voiceover-full.wav")
    manifest = {
        "schemaVersion": 1, "voice": VOICE, "rate": RATE, "pitch": PITCH, "fps": FPS,
        "provider": "Microsoft Edge online TTS via edge-tts",
        "edgeTtsVersion": importlib.metadata.version("edge-tts"),
        "brandPronunciation": "Pilion kept in English; no phonetic substitution or voice cloning",
        "totalDuration": full_duration, "speechDuration": round(sum(s["duration"] for s in scenes), 6),
        "fullFile": "audio/voiceover-full.mp3", "losslessFile": "audio/voiceover-full.wav",
        "fullSubtitleFile": "audio/voiceover-full.srt", "scenes": scenes,
        "timingNotes": "Subtitles are relative to each segment. Add scene.start + audioOffset for timeline. "
                       "Adjacent Edge sentence overlaps normalized; raw SRT retained. No speed processing.",
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Complete: speech {manifest['speechDuration']:.3f}s; timeline {full_duration:.3f}s", flush=True)


if __name__ == "__main__":
    main()
