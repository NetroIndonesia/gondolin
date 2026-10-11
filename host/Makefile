.PHONY: build typecheck lint test format clean fuzz fuzz-ci

PNPM ?= pnpm
NODE ?= node
RUN_PARALLEL ?= ../scripts/run-parallel
BIOME ?= ../node_modules/.bin/biome
TSC ?= ./node_modules/.bin/tsc

# Host fuzzer target name (see host/fuzz/targets)
TARGET ?= virtio

build:
	@$(PNPM) run build

typecheck:
	@$(TSC) -p tsconfig.json --noEmit

lint:
	@$(BIOME) check --error-on-warnings . ../scripts

format:
	@$(BIOME) check --write . ../scripts

test:
	@$(RUN_PARALLEL) -j 1 \
		"host:test" "$(NODE) --test test/*.test.ts"

fuzz:
	@$(PNPM) run fuzz -- $(TARGET)

# Bounded fuzz smoke run over every target (CI)
ITERS ?= 20000
SEED ?= 1
fuzz-ci:
	@$(PNPM) run fuzz -- --all --iters $(ITERS) --seed $(SEED)

clean:
	@rm -rf dist
