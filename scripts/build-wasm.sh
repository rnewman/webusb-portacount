#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Activate emsdk
source "$ROOT/emsdk/emsdk_env.sh" 2>/dev/null

LWIP_DIR="$ROOT/vendor/lwip"
CSRC_DIR="$ROOT/csrc"
BUILD_DIR="$ROOT/build"

mkdir -p "$BUILD_DIR"

LWIP_SOURCES=(
    # Core
    "$LWIP_DIR/src/core/init.c"
    "$LWIP_DIR/src/core/def.c"
    "$LWIP_DIR/src/core/inet_chksum.c"
    "$LWIP_DIR/src/core/ip.c"
    "$LWIP_DIR/src/core/mem.c"
    "$LWIP_DIR/src/core/memp.c"
    "$LWIP_DIR/src/core/netif.c"
    "$LWIP_DIR/src/core/pbuf.c"
    "$LWIP_DIR/src/core/stats.c"
    "$LWIP_DIR/src/core/sys.c"
    "$LWIP_DIR/src/core/tcp.c"
    "$LWIP_DIR/src/core/tcp_in.c"
    "$LWIP_DIR/src/core/tcp_out.c"
    "$LWIP_DIR/src/core/timeouts.c"
    "$LWIP_DIR/src/core/udp.c"
    # IPv4
    "$LWIP_DIR/src/core/ipv4/acd.c"
    "$LWIP_DIR/src/core/ipv4/autoip.c"
    "$LWIP_DIR/src/core/ipv4/dhcp.c"
    "$LWIP_DIR/src/core/ipv4/etharp.c"
    "$LWIP_DIR/src/core/ipv4/icmp.c"
    "$LWIP_DIR/src/core/ipv4/ip4.c"
    "$LWIP_DIR/src/core/ipv4/ip4_addr.c"
    "$LWIP_DIR/src/core/ipv4/ip4_frag.c"
    # Netif
    "$LWIP_DIR/src/netif/ethernet.c"
    # Glue
    "$CSRC_DIR/glue.c"
    "$CSRC_DIR/sys_arch.c"
)

INCLUDE_FLAGS="-I$LWIP_DIR/src/include -I$CSRC_DIR/include"

echo "Building lwIP Wasm..."

emcc \
    "${LWIP_SOURCES[@]}" \
    $INCLUDE_FLAGS \
    -O2 \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s EXPORT_NAME='createLwipModule' \
    -s ENVIRONMENT='web,node' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=2097152 \
    -s STACK_SIZE=65536 \
    -s FILESYSTEM=0 \
    -s "EXPORTED_FUNCTIONS=[\"_lwip_wasm_init\",\"_lwip_wasm_inject_frame\",\"_lwip_wasm_check_timeouts\",\"_lwip_wasm_get_frame_buf\",\"_lwip_wasm_get_inject_buf\",\"_lwip_wasm_get_ip\",\"_lwip_wasm_get_gateway\",\"_lwip_wasm_get_netmask\",\"_lwip_wasm_echo_server_start\",\"_lwip_wasm_tcp_connect\",\"_lwip_wasm_tcp_write\",\"_lwip_wasm_tcp_close\",\"_lwip_wasm_get_tcp_write_buf\",\"_lwip_wasm_server_listen\",\"_lwip_wasm_server_write\",\"_lwip_wasm_server_close\",\"_lwip_wasm_get_server_write_buf\",\"_malloc\",\"_free\"]" \
    -s "EXPORTED_RUNTIME_METHODS=[\"ccall\",\"cwrap\",\"HEAPU8\"]" \
    -s NO_EXIT_RUNTIME=1 \
    -o "$BUILD_DIR/lwip.js"

echo ""
echo "Build complete: build/lwip.js + build/lwip.wasm"
