"""
TLS for a Python build on a head unit whose clock may be days off (build.js
puts this folder on PYTHONPATH). Every SSL context verifies as OpenSSL
does, except for the validity dates (X509_V_FLAG_NO_CHECK_TIME): the chain
to a trusted root, every signature in it, CA constraints, key usages and
the host name are still checked. A context's verify_flags keep the flag
whatever they are set to.
"""
import ssl

NO_CHECK_TIME = 0x200000  # OpenSSL's X509_V_FLAG_NO_CHECK_TIME (1.1.0 and newer)


def _install():
    flags = ssl._SSLContext.verify_flags  # the C getter and setter
    new = ssl.SSLContext.__new__

    def __new__(cls, *args, **kwargs):
        ctx = new(cls, *args, **kwargs)
        flags.__set__(ctx, flags.__get__(ctx) | NO_CHECK_TIME)
        return ctx

    def set_flags(ctx, value):
        flags.__set__(ctx, int(value) | NO_CHECK_TIME)

    ssl.SSLContext.__new__ = staticmethod(__new__)
    ssl.SSLContext.verify_flags = property(ssl.SSLContext.verify_flags.fget, set_flags)


_install()
