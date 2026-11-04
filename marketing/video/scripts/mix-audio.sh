#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Generate the original score first when regenerating all audio.
if [ -f public/audio/music-original.wav ]; then
  ffmpeg -y -i public/audio/music-original.wav -c:a aac -b:a 192k public/audio/music.m4a
fi
ffmpeg -y -i public/audio/voiceover-full.wav -i public/audio/music.m4a \
  -filter_complex '[0:a]loudnorm=I=-16:TP=-2:LRA=7,asplit=2[v][side];[1:a]volume=0.38,afade=t=in:d=2,afade=t=out:st=59:d=3[m];[m][side]sidechaincompress=threshold=0.025:ratio=5:attack=100:release=450[duck];[v][duck]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=9[a]' \
  -map '[a]' -c:a aac -b:a 192k public/audio/mix.m4a
