"""Run at the start of every Python build (build.js, PYTHONPATH).

On a unit whose clock is past 2106, times written into archives do not fit
their fields: a gzip header holds a 32-bit time (to 2106), a zip entry a
DOS date (to 2107), and writing one fails with struct.error. Such a time is
written as none in gzip (0, RFC 1952) and as the last DOS date in zip;
every other time is written as it is.
"""
import gzip
import time
import zipfile

_write32u = gzip.write32u


def _gzip_write32u(output, value):
    # also writes the CRC and size, which are always in range
    if not 0 <= value <= 0xFFFFFFFF:
        value = 0
    _write32u(output, value)


gzip.write32u = _gzip_write32u

_compress = gzip.compress


def _gzip_compress(data, *args, **kwargs):
    # builds its header itself, from time.time() when mtime is None
    if kwargs.get('mtime') is None and time.time() > 0xFFFFFFFF:
        kwargs['mtime'] = 0
    return _compress(data, *args, **kwargs)


gzip.compress = _gzip_compress

_LAST_DOS = (2107, 12, 31, 23, 59, 58)
_file_header = zipfile.ZipInfo.FileHeader


def _zip_file_header(self, *args, **kwargs):
    # the central directory is written later from the same date_time
    if tuple(self.date_time[:6]) > _LAST_DOS:
        self.date_time = _LAST_DOS
    return _file_header(self, *args, **kwargs)


zipfile.ZipInfo.FileHeader = _zip_file_header
