# mgu-uplink. See README.md.
#
#   make target   head-unit binary build/target/mgu-uplink (static linux/amd64)
#   make test     vet and unit tests (Linux; on a Mac: make test-docker)

GO      ?= go
BUILD   ?= build
VERSION ?= $(shell sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' component.json)
LDFLAGS  = -s -w -X main.version=$(VERSION)

.PHONY: target test test-docker clean

target:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -buildvcs=false \
		-ldflags='$(LDFLAGS)' -o $(BUILD)/target/mgu-uplink .

test:
	$(GO) vet ./...
	$(GO) test ./...

test-docker:
	docker run --rm -v "$(CURDIR)":/src -w /src golang:1.22 make test

clean:
	rm -rf $(BUILD)
