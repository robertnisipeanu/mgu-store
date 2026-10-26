# mgu-render. See README.md.
#
#   make target         head-unit binary build/target/mgu-render: x86-64, glibc 2.27, built in
#                       Ubuntu 18.04 (Docker)
#   make check-target   its loader, libraries and glibc versions
#   make check-protocol IVI_LIB_DIR=<dir>   protocol/*.xml against the unit's libivi-*.so
#   make test           protocol unit tests, and recorded sessions of both legacy kits replayed
#                       through the original daemons and this one, frames compared (Docker, Mesa)
#
# The in-* targets run inside those containers.

DOCKER  ?= docker
CFLAGS  ?= -O2 -g0 -Wall -Wextra -Wno-unused-parameter -Wno-misleading-indentation -Werror
CFLAGS  += -std=gnu11 -Isrc -Ibuild/$(OUT)/protocol
LIBS     = -lwayland-client -lwayland-egl -lEGL -lGLESv2 -lm
SRC      = $(wildcard src/*.c)
HDR      = $(wildcard src/*.h)
XML      = protocol/ivi-application.xml protocol/ivi-controller.xml
GEN_DIR  = build/$(OUT)/protocol
GEN_H    = $(XML:protocol/%.xml=$(GEN_DIR)/%-client-protocol.h)
GEN_C    = $(XML:protocol/%.xml=$(GEN_DIR)/%-protocol.c)
TARGET_IMAGE = mgu-render-target
TEST_IMAGE   = mgu-render-test
RUN = $(DOCKER) run --rm -v "$(CURDIR):/w" -w /w -u $$(id -u):$$(id -g)

.PHONY: target check-target check-protocol test in-build in-check in-test clean

check-protocol:
	@test -n "$(IVI_LIB_DIR)" || { echo "set IVI_LIB_DIR to a directory with libivi-application.so.1.11.0 and libivi-controller.so.1.11.0"; exit 2; }
	python3 tools/check_protocol_abi.py --lib $(IVI_LIB_DIR)/libivi-application.so.1.11.0 --xml protocol/ivi-application.xml
	python3 tools/check_protocol_abi.py --lib $(IVI_LIB_DIR)/libivi-controller.so.1.11.0 --xml protocol/ivi-controller.xml

target:
	$(DOCKER) build -q --platform linux/amd64 -t $(TARGET_IMAGE) docker/target >/dev/null
	$(RUN) --platform linux/amd64 $(TARGET_IMAGE) make -s in-build OUT=target LDFLAGS=-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2

check-target: target
	$(RUN) --platform linux/amd64 $(TARGET_IMAGE) sh tools/check_target.sh build/target/mgu-render

test:
	$(DOCKER) build -q -t $(TEST_IMAGE) docker/test >/dev/null
	$(RUN) $(TEST_IMAGE) make -s in-test OUT=host

$(GEN_DIR)/%-client-protocol.h: protocol/%.xml
	@mkdir -p $(GEN_DIR)
	wayland-scanner client-header $< $@
$(GEN_DIR)/%-protocol.c: protocol/%.xml
	@mkdir -p $(GEN_DIR)
	wayland-scanner private-code $< $@ 2>/dev/null || wayland-scanner code $< $@

build/$(OUT)/mgu-render: $(SRC) $(HDR) $(GEN_H) $(GEN_C)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(SRC) $(GEN_C) $(LIBS)
	strip $@

in-build: build/$(OUT)/mgu-render

in-test: build/$(OUT)/mgu-render
	$(CC) $(CFLAGS) -o build/$(OUT)/test_dialect test/test_dialect.c src/dialect.c
	build/$(OUT)/test_dialect
	sh test/replay.sh build/$(OUT)

clean:
	rm -rf build
