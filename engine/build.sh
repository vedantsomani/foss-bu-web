#!/usr/bin/env bash
# Build the Fragline engine (Crispy Doom + WebSocket networking) to WebAssembly.
#
# Needs Emscripten (emcc) with the SDL2 and SDL2_mixer ports. Writes:
#   public/websockets-doom.js         loader
#   public/websockets-doom.wasm.gz    engine, gzip-compressed for download
# Usage: engine/build.sh [--debug]
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
src="$here/crispy-doom"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

opt=(-O3 -flto)
[ "${1:-}" = "--debug" ] && opt=(-O1 -g)

common=(a11y aes_prng crispy d_event d_iwad d_loop d_mode deh_str gusconf i_cdmus i_endoom
  i_flmusic i_glob i_input i_joystick i_main i_musicpack i_oplmusic i_pcsound i_sdlmusic
  i_sdlsound i_sound i_system i_timer i_truecolor i_video i_videohr m_argv m_bbox m_cheat
  m_config m_controls m_fixed m_misc memio midifallback midifile mus2mid net_client net_common
  net_dedicated net_gui net_io net_loop net_packet net_petname net_query net_sdl net_server net_structrw
  net_websockets p_mapformat p_rejectpad sha1 tables v_diskicon v_trans v_video w_checksum
  w_file w_file_stdc w_main w_merge w_wad z_zone deh_io deh_main deh_mapping deh_text)
files=()
for f in "${common[@]}"; do files+=("$src/src/$f.c"); done
files+=("$src"/src/doom/*.c "$src"/textscreen/*.c "$src"/opl/*.c "$src"/pcsound/*.c)

flags=(
  -I"$here" -I"$src/src" -I"$src/src/doom" -I"$src/textscreen" -I"$src/opl" -I"$src/pcsound"
  -include "$here/config.h" -DHAVE_CONFIG_H
  -sUSE_SDL=2 -sUSE_SDL_MIXER=2 '-sSDL2_MIXER_FORMATS=[]'
)
link=(
  -sASYNCIFY -sASYNCIFY_STACK_SIZE=65536
  -sINITIAL_MEMORY=134217728 -sALLOW_MEMORY_GROWTH=1
  -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0
  '-sEXPORTED_RUNTIME_METHODS=["FS","callMain","addRunDependency","removeRunDependency"]'
  -sENVIRONMENT=web -lwebsocket.js
)

objs=()
for f in "${files[@]}"; do
  o="$out/$(echo "${f#$src/}" | tr '/' '_').o"
  objs+=("$o")
  emcc "${opt[@]}" "${flags[@]}" -c "$f" -o "$o" &
  while [ "$(jobs -rp | wc -l)" -ge "$(nproc)" ]; do wait -n; done
done
wait
emcc "${opt[@]}" "${flags[@]}" "${objs[@]}" "${link[@]}" -o "$out/websockets-doom.js"

public="${FRAGLINE_OUT:-$here/../public}"
cp "$out/websockets-doom.js" "$public/websockets-doom.js"
gzip -9 -n -c "$out/websockets-doom.wasm" > "$public/websockets-doom.wasm.gz"
ls -l "$out/websockets-doom.wasm" "$public/websockets-doom.wasm.gz"
