# mgu-python

Python 3.12 for the head unit. Repositories whose apps build with Python
(`mgu-repo.json` `"build": {"python": ...}`, docs/PUBLISHING.md) require
it, and the updater installs it before such an app. It is optional:
only those apps need it.

| On the unit | |
|---|---|
| `/var/opt/mgu-python/current/bin/python3` | the interpreter, libpython and its libraries built in (it needs the system's glibc 2.17 or newer; the unit has 2.27) |
| `lib/python312.zip` | the standard library's `.py` files, imported from the zip |
| `lib/python3.12/lib-dynload/` | empty: every extension module is built in |
| `ssl/cacert.pem` | CA bundle for builds that download (`SSL_CERT_FILE`) |
| `LICENSES.txt` | the licences of CPython, the libraries built into it, and certifi |

About 32 MB installed, a 14 MB artifact.

`node build.js` (the component's `build`, run by `deploy/hu artifact` and
`release/release.js`; Node 10 or newer and a `tar` that reads zstd)
downloads one pinned
[python-build-standalone](https://github.com/astral-sh/python-build-standalone)
release (`cpython-3.12.15+20261003-x86_64-unknown-linux-gnu`): the
`install_only_stripped` distribution, and the `pgo+lto-full` one for its
`python/licenses/`. It checks both by sha256 and writes `build/python/`.
The zip leaves out the GUI, IDE, test, packaging and 2to3 parts of the
standard library. The downloads are kept in `build/download/` and reused
while their sha256 matches.

Licences: CPython is under the PSF licence; the interpreter has OpenSSL
(Apache 2.0), libffi, zlib, bzip2, xz, SQLite, mpdecimal, expat and others
built in; the CA bundle is certifi's (MPL 2.0). `LICENSES.txt` holds all
their texts and is installed with it.
