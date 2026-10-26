# Third-party notices

mgu-store is MIT-licensed (`LICENSE`). These parts come from others and keep
their own licences; each licence text sits next to the code that uses it.

| Part | Where | Licence | Text |
|---|---|---|---|
| idrive7-apps renderer daemon and app kit (cauliflowermossgrape) | `native/mgu-render`, `apps/robertn_store/src` | MIT | `native/mgu-render/LICENSE.mgu-renderd`, `apps/robertn_store/src/LICENSE-kit.txt` |
| IterioDev's mgu-renderd (protocol v3, touch), used with his permission | `native/mgu-render` | MIT | `native/mgu-render/LICENSE.mgu-renderd` |
| Reference copies of both renderers, for protocol tests | `native/mgu-render/test/reference` | MIT | `LICENSE` in each folder |
| Wayland ivi-application / ivi-controller protocols (DENSO, BMW Car IT) | `native/mgu-render/protocol` | MIT | in each XML file |
| Inter font (The Inter Project Authors) | `apps/robertn_store/src` | SIL Open Font License 1.1 | `apps/robertn_store/src/LICENSE-Inter.txt` |
| QR Code generator (Project Nayuki) | `apps/robertn_store/src/qrcodegen.js` | MIT | `apps/robertn_store/src/LICENSE-qrcodegen.txt` |
| netlink, netns (vishvananda) | `native/mgu-uplink` (Go modules) | Apache-2.0 | the modules' own `LICENSE` |
| golang.org/x/sys (The Go Authors) | `native/mgu-uplink` (Go module) | BSD-3-Clause | the module's own `LICENSE` |
| CPython and the libraries built into it, certifi (python-build-standalone) | `native/mgu-python` (downloaded at build time) | PSF and others; certifi MPL-2.0 | `LICENSES.txt` in the built tool |

The oap-sdk the head unit uses is BMW's and is not part of this repository:
apps are linked against the copy already on the head unit.
