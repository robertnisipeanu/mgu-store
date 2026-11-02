# mgu-uplink. See README.md.
#
#   make target   head-unit binaries: build/target/mgu-uplink and build/target/mgu-fetch
#                 (cmd/mgu-fetch; static linux/amd64), and
#                 build/target/mgu-wpa (wpa/: upstream 2.10 with our patch, glibc 2.27,
#                 built in Ubuntu 18.04 with Docker, linux/amd64)
#   make test     vet and unit tests (Linux; on a Mac: make test-docker)

GO      ?= go
DOCKER  ?= docker
BUILD   ?= build
VERSION ?= $(shell sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' component.json)
LDFLAGS  = -s -w -X main.version=$(VERSION)
WPA_IMAGE = mgu-uplink-wpa

.PHONY: target test test-docker clean

target: build/target/mgu-wpa
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -buildvcs=false \
		-ldflags='$(LDFLAGS)' -o $(BUILD)/target/mgu-uplink .
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -buildvcs=false \
		-ldflags='-s -w' -o $(BUILD)/target/mgu-fetch ./cmd/mgu-fetch

# wpa/build.sh writes build/ (component.json ships it from there).
build/target/mgu-wpa: wpa/Dockerfile wpa/build.sh wpa/check.sh wpa/config wpa/wpa-mgu-sme-connect.patch
	$(DOCKER) build -q --platform linux/amd64 -t $(WPA_IMAGE) wpa >/dev/null
	$(DOCKER) run --rm --platform linux/amd64 -v "$(CURDIR):/w" -w /w -u $$(id -u):$$(id -g) \
		$(WPA_IMAGE) sh wpa/build.sh

test:
	$(GO) vet ./...
	$(GO) test ./...

test-docker:
	docker run --rm -v "$(CURDIR)":/src -w /src golang:1.22 make test

clean:
	rm -rf $(BUILD)
