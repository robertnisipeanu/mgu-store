# Reference daemons

The two renderers mgu-render must stay compatible with, unchanged, for `make test`: recorded
sessions are replayed (`--replay`) through each original and through mgu-render, and the frames
must match byte for byte.

- `upstream/`: idrive7-apps `kit/renderd/src` at commit 7829757 (protocol 1), MIT,
  Copyright (c) 2026 cauliflowermossgrape (`upstream/LICENSE`).
- `iterio/`: IterioDev's mgu-renderd 1.1.2 `src` (protocol 3: upstream f277cc9 plus touch routing
  and pictures), MIT as above (`iterio/LICENSE`).

They are built against `../../protocol/*.xml` and are never installed.
