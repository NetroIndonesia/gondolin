#!/usr/bin/env bash
# Advisory preflight for VM-dependent tooling (make test, make fuzz-cbor, ...).
# Prints what's available and how to install what's missing; does not mutate
# anything. Exits 0 unless GONDOLIN_REQUIRE_QEMU=1 (CI can opt into strict).
set -u

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) QEMU_SYS="qemu-system-aarch64" ;;
  *) QEMU_SYS="qemu-system-x86_64" ;;
esac

missing=0
note() { printf 'preflight-qemu: %s\n' "$*"; }

if command -v "$QEMU_SYS" >/dev/null 2>&1; then
  note "ok: $QEMU_SYS found ($(command -v "$QEMU_SYS"))"
else
  note "MISSING: $QEMU_SYS — VM tests will fail; install qemu (apt install qemu-system / brew install qemu)"
  missing=1
fi

if command -v qemu-img >/dev/null 2>&1; then
  note "ok: qemu-img found ($(command -v qemu-img))"
else
  note "MISSING: qemu-img — overlay root disks cannot be prepared (part of qemu: apt install qemu-utils)"
  missing=1
fi

if [ "$(uname -s)" = "Linux" ]; then
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    note "ok: /dev/kvm accessible"
  else
    note "warn: /dev/kvm unavailable — VM tests self-skip (no hardware acceleration; TCG is too slow)"
  fi
fi

GUEST_DIR="${GONDOLIN_GUEST_DIR:-guest/image/out}"
if [ -f "$GUEST_DIR/manifest.json" ]; then
  note "ok: guest assets present ($GUEST_DIR)"
else
  note "warn: guest assets missing at $GUEST_DIR — run 'make -C guest build' (VM tests skip or fail without them)"
fi

if [ "$missing" -ne 0 ] && [ "${GONDOLIN_REQUIRE_QEMU:-0}" = "1" ]; then
  note "strict mode (GONDOLIN_REQUIRE_QEMU=1): failing"
  exit 1
fi
exit 0
