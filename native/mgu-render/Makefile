# mgu-render. See README.md.
#
#   make target         head-unit binary build/target/mgu-render: x86-64, glibc 2.27, built in
#                       Ubuntu 18.04 (Docker)
#   make check-target   its loader, libraries and glibc versions
#   make check-protocol IVI_LIB_DIR=<dir>   protocol/*.xml against the unit's libivi-*.so
#   make test           protocol (all four dialects), touch-routing, community-socket, kit-return, video-file, page-template-script, boot-count,
#                       embed-buffer (a mock HMI compositor) and layer-list (a mock Winston) unit tests, and recorded sessions of both legacy kits replayed
#                       through the original daemons and this one, frames compared (Docker, Mesa)
#
# The in-* targets run inside those containers.

DOCKER  ?= docker
CFLAGS  ?= -O2 -g0 -Wall -Wextra -Wno-unused-parameter -Wno-misleading-indentation -Werror
CFLAGS  += -std=gnu11 -Isrc -Ibuild/$(OUT)/protocol
LIBS     = -lwayland-client -lwayland-egl -lEGL -lGLESv2 -lm -ldl
SRC      = $(wildcard src/*.c)
HDR      = $(wildcard src/*.h)
XML      = protocol/ivi-application.xml protocol/ivi-controller.xml protocol/wayland-drm.xml
GEN_DIR  = build/$(OUT)/protocol
GEN_H    = $(XML:protocol/%.xml=$(GEN_DIR)/%-client-protocol.h)
GEN_C    = $(XML:protocol/%.xml=$(GEN_DIR)/%-protocol.c)
# The build image's tag is a hash of its build context (file names and contents):
# different definitions never share a tag, identical ones reuse the image.
SHA256  := $(shell command -v sha256sum >/dev/null 2>&1 && echo sha256sum || echo 'shasum -a 256')
TARGET_HASH := $(shell cd docker/target && find . -type f | LC_ALL=C sort | while read -r f; do echo "$$f"; cat "$$f"; done | $(SHA256) | cut -c1-16)
TARGET_IMAGE = mgu-render-target:$(TARGET_HASH)
TEST_IMAGE   = mgu-render-test
RUN = $(DOCKER) run --rm -v "$(CURDIR):/w" -w /w -u $$(id -u):$$(id -g)

.PHONY: target check-target check-protocol test in-build in-check in-test clean

check-protocol:
	@test -n "$(IVI_LIB_DIR)" || { echo "set IVI_LIB_DIR to a directory with libivi-application.so.1.11.0 and libivi-controller.so.1.11.0"; exit 2; }
	python3 tools/check_protocol_abi.py --lib $(IVI_LIB_DIR)/libivi-application.so.1.11.0 --xml protocol/ivi-application.xml
	python3 tools/check_protocol_abi.py --lib $(IVI_LIB_DIR)/libivi-controller.so.1.11.0 --xml protocol/ivi-controller.xml

target:
	@test -n "$(TARGET_HASH)" || { echo "could not hash docker/target"; exit 2; }
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
	$(CC) $(CFLAGS) -o build/$(OUT)/test_config test/test_config.c src/config.c src/log.c
	build/$(OUT)/test_config
	$(CC) $(CFLAGS) -o build/$(OUT)/test_gate test/test_gate.c src/gate.c src/log.c
	build/$(OUT)/test_gate
	node test/test_gate.js
	$(CC) $(CFLAGS) -o build/$(OUT)/test_dbr test/test_dbr.c src/dbr.c
	build/$(OUT)/test_dbr
	$(CC) $(CFLAGS) -o build/$(OUT)/test_touch test/test_touch.c
	build/$(OUT)/test_touch
	$(CC) $(CFLAGS) -o build/$(OUT)/test_share test/test_share.c src/log.c
	build/$(OUT)/test_share
	$(CC) $(CFLAGS) -o build/$(OUT)/test_kit test/test_kit.c src/kit.c src/share.c src/log.c
	build/$(OUT)/test_kit
	$(CC) $(CFLAGS) -o build/$(OUT)/test_video test/test_video.c src/gfx.c src/log.c -lEGL -lGLESv2 -lm
	LIBGL_ALWAYS_SOFTWARE=1 EGL_PLATFORM=surfaceless build/$(OUT)/test_video
	sh test/test_hmi.sh
	sh test/test_hmi_count.sh
	wayland-scanner server-header protocol/ivi-controller.xml $(GEN_DIR)/ivi-controller-server-protocol.h
	$(CC) $(CFLAGS) -o build/$(OUT)/mock_winston test/mock_winston.c $(GEN_DIR)/ivi-controller-protocol.c -lwayland-server
	$(CC) $(CFLAGS) -o build/$(OUT)/ivi_client test/ivi_client.c src/relist.c src/log.c $(GEN_DIR)/ivi-controller-protocol.c -lwayland-client
	sh test/test_relist.sh build/$(OUT)
	for x in ivi-application wayland-drm; do wayland-scanner server-header protocol/$$x.xml $(GEN_DIR)/$$x-server-protocol.h; done
	$(CC) $(CFLAGS) -o build/$(OUT)/mock_hmi test/mock_hmi.c $(GEN_DIR)/ivi-application-protocol.c $(GEN_DIR)/wayland-drm-protocol.c -lwayland-server
	$(CC) $(CFLAGS) -DMGU_FAKE_DMABUF -o build/$(OUT)/test_embed test/test_embed.c src/embed.c src/embed_gl.c src/gfx.c src/log.c \
		$(GEN_DIR)/ivi-application-protocol.c $(GEN_DIR)/wayland-drm-protocol.c -lwayland-client -lEGL -lGLESv2 -lm -ldl
	LIBGL_ALWAYS_SOFTWARE=1 EGL_PLATFORM=surfaceless build/$(OUT)/test_embed build/$(OUT)/mock_hmi
	sh test/replay.sh build/$(OUT)

clean:
	rm -rf build
