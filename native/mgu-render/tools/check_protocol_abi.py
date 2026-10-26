#!/usr/bin/env python3
"""Compare a Wayland protocol XML with the wl_interface tables in an ELF library.

The bridge compiles its own protocol glue from protocol/*.xml. The head unit
ships the same protocols as libivi-application.so.1.11.0 and
libivi-controller.so.1.11.0. This checks, for every interface exported by the
library, that the XML declares the same version and the same requests and
events in the same opcode order, with identical wire signatures and argument
interfaces. A mismatch would mis-marshal requests or mis-dispatch events.

    check_protocol_abi.py --lib /usr/lib/libivi-controller.so.1.11.0 \
                          --xml protocol/ivi-controller.xml

Exit status 0 when every interface matches, 1 otherwise. Needs pyelftools.
Reads x86-64 / aarch64 little-endian ELF64 (pointer fields resolved through
the dynamic relocations).
"""
import argparse
import struct
import sys
import xml.etree.ElementTree as ET

from elftools.elf.elffile import ELFFile
from elftools.elf.relocation import RelocationSection

TYPE_CHARS = {'int': 'i', 'uint': 'u', 'fixed': 'f', 'string': 's',
              'object': 'o', 'new_id': 'n', 'array': 'a', 'fd': 'h'}


class Elf:
    def __init__(self, path):
        self.f = open(path, 'rb')
        self.e = ELFFile(self.f)
        dynsym = self.e.get_section_by_name('.dynsym')
        self.syms = {s.name: s for s in dynsym.iter_symbols()}
        self.by_addr = {s['st_value']: s.name for s in dynsym.iter_symbols()
                        if s['st_value']}
        self.relocs = {}
        for sec in self.e.iter_sections():
            if isinstance(sec, RelocationSection):
                for r in sec.iter_relocations():
                    sym = (dynsym.get_symbol(r['r_info_sym']).name
                           if r['r_info_sym'] else None)
                    self.relocs[r['r_offset']] = (r['r_addend'], sym)

    def read(self, va, n):
        for seg in self.e.iter_segments():
            if (seg['p_type'] == 'PT_LOAD' and
                    seg['p_vaddr'] <= va < seg['p_vaddr'] + seg['p_filesz']):
                self.f.seek(seg['p_offset'] + va - seg['p_vaddr'])
                return self.f.read(n)
        raise ValueError('address %#x not in a loaded segment' % va)

    def ptr(self, va):
        """(address, symbol name or None) stored at va."""
        if va in self.relocs:
            addend, sym = self.relocs[va]
            if sym:
                return None, sym
            return addend, self.by_addr.get(addend)
        value = struct.unpack('<Q', self.read(va, 8))[0]
        return value, self.by_addr.get(value)

    def cstr(self, va):
        out = b''
        while True:
            c = self.read(va, 1)
            if c in (b'', b'\0'):
                return out.decode()
            out += c
            va += 1

    def interface(self, symbol):
        va = self.syms[symbol]['st_value']
        name = self.cstr(self.ptr(va)[0])
        version, method_count = struct.unpack('<ii', self.read(va + 8, 8))
        methods = self.ptr(va + 16)[0]
        event_count = struct.unpack('<i', self.read(va + 24, 4))[0]
        events = self.ptr(va + 32)[0]
        return {'name': name, 'version': version,
                'requests': self.messages(methods, method_count),
                'events': self.messages(events, event_count)}

    def messages(self, va, count):
        out = []
        for i in range(count):
            m = va + 24 * i
            name = self.cstr(self.ptr(m)[0])
            sig = self.cstr(self.ptr(m + 8)[0])
            types_va = self.ptr(m + 16)[0]
            types = []
            for j in range(sum(1 for c in sig if c.isalpha())):
                addr, sym = self.ptr(types_va + 8 * j)
                if sym:
                    types.append(sym[:-len('_interface')]
                                 if sym.endswith('_interface') else sym)
                else:
                    types.append(None if not addr else '%#x' % addr)
            out.append((name, sig, types))
        return out


def xml_interfaces(path):
    out = {}
    for iface in ET.parse(path).getroot().iter('interface'):
        def messages(tag):
            msgs = []
            for msg in iface.iter(tag):
                sig, types = '', []
                since = msg.get('since')
                if since and int(since) > 1:
                    sig += since
                for arg in msg.iter('arg'):
                    t = arg.get('type')
                    if arg.get('allow-null') == 'true':
                        sig += '?'
                    if t == 'new_id' and not arg.get('interface'):
                        sig += 'sun'
                        types += [None, None, None]
                        continue
                    sig += TYPE_CHARS[t]
                    types.append(arg.get('interface')
                                 if t in ('object', 'new_id') else None)
                msgs.append((msg.get('name'), sig, types))
            return msgs
        out[iface.get('name')] = {'name': iface.get('name'),
                                  'version': int(iface.get('version')),
                                  'requests': messages('request'),
                                  'events': messages('event')}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--lib', required=True)
    ap.add_argument('--xml', required=True)
    args = ap.parse_args()

    elf = Elf(args.lib)
    want = xml_interfaces(args.xml)
    exported = sorted(s for s in elf.syms if s.endswith('_interface')
                      and elf.syms[s]['st_shndx'] != 'SHN_UNDEF')
    if not exported:
        print('no *_interface symbols exported by %s' % args.lib)
        return 1
    ok = True
    for sym in exported:
        have = elf.interface(sym)
        mine = want.get(have['name'])
        if mine is None:
            print('MISSING  %s: in library, not in XML' % have['name'])
            ok = False
            continue
        problems = []
        if have['version'] != mine['version']:
            problems.append('version %d != %d' % (have['version'], mine['version']))
        for kind in ('requests', 'events'):
            a, b = have[kind], mine[kind]
            if len(a) != len(b):
                problems.append('%s count %d != %d' % (kind, len(a), len(b)))
            for op, (x, y) in enumerate(zip(a, b)):
                if x != y:
                    problems.append('%s %d: library %s, XML %s' % (kind, op, x, y))
        if problems:
            ok = False
            print('MISMATCH %s v%d' % (have['name'], have['version']))
            for p in problems:
                print('         ' + p)
        else:
            print('OK       %s v%d: %d requests, %d events' % (
                have['name'], have['version'],
                len(have['requests']), len(have['events'])))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
