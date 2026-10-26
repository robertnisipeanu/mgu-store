#!/usr/bin/env node
/*
 * Writes the HMI page template that shows mgu-render's embed surface, for the
 * HmiMain3D it is given.
 *
 *   node hmi_template.js [--hmi /usr/bin/HmiMain3D] [--surface-id 0x500] --out DIR
 *
 * HmiMain3D builds its pages from widget definitions it reads from the *.pbw
 * files of its widget directories (protobuf; every name is an index into an
 * identifier table compiled into the binary, so the numbers belong to one
 * build). The binary names seven page templates that no file defines; this
 * defines one of them, LT_State_A4A_WelcomeApp: a state with the stock title
 * bar and, below it, an embedded-surface widget over the content area that
 * samples the ivi surface `surface id` from the HMI's embedded compositor
 * (wayland-1), stretched to the box (mgu-render.conf's embed_area is the same
 * box). Writes DIR/LT_State_A4A_WelcomeApp.pbw; systemd/mgu-render-hmi.sh runs it on
 * the unit's Node 8 whenever HmiMain3D changes.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE = 'eGfxIdWidgetType_LT_State_A4A_WelcomeApp';
// The stream box: the HMI's content area of an app's page on the 1920x720
// centre display. The layout puts it below the title bar (y 88); x and size
// are the template's.
const AREA = { x: 104, w: 1796, h: 632 };

/* Identifier name -> number from HmiMain3D's table of pointers to names. */
function identifiers(data) {
    const u64 = (off) => data.readUInt32LE(off) + data.readUInt32LE(off + 4) * 0x100000000;
    const phoff = u64(0x20);
    const phentsize = data.readUInt16LE(0x36);
    const phnum = data.readUInt16LE(0x38);
    const loads = [];
    for (let i = 0; i < phnum; i++) {
        const h = phoff + i * phentsize;
        if (data.readUInt32LE(h) === 1) {
            loads.push({ off: u64(h + 8), vaddr: u64(h + 16), size: u64(h + 32) });
        }
    }
    const toOff = (va) => {
        const l = loads.find((s) => va >= s.vaddr && va < s.vaddr + s.size);
        return l ? va - l.vaddr + l.off : -1;
    };
    const toVaddr = (off) => {
        const l = loads.find((s) => off >= s.off && off < s.off + s.size);
        return l ? off - l.off + l.vaddr : -1;
    };
    const nameAt = (ptrOff) => {
        if (ptrOff < 0 || ptrOff + 8 > data.length) {
            return null;
        }
        const off = toOff(u64(ptrOff));
        if (off < 0) {
            return null;
        }
        const end = data.indexOf(0, off);
        if (end <= off || end - off > 1024 || data.toString('latin1', off, off + 6) !== 'eGfxId') {
            return null;
        }
        return data.toString('latin1', off, end);
    };
    const table = (entry) => {
        let start = entry;
        while (nameAt(start - 8)) {
            start -= 8;
        }
        const ids = new Map();
        for (let off = start, name; (name = nameAt(off)); off += 8) {
            if (!ids.has(name)) {
                ids.set(name, (off - start) / 8 + 1);
            }
        }
        return ids;
    };
    // The names are pointed to from several tables; the identifier table is
    // the long run of consecutive pointers.
    const anchor = data.indexOf('\0eGfxIdWidgetType_eWidgetType_EmbeddedSurface\0', 0, 'latin1') + 1;
    let best = new Map();
    if (anchor > 0) {
        const va = toVaddr(anchor);
        const ptr = Buffer.alloc(8);
        ptr.writeUInt32LE(va % 0x100000000, 0);
        ptr.writeUInt32LE(Math.floor(va / 0x100000000), 4);
        for (let e = data.indexOf(ptr); e >= 0; e = data.indexOf(ptr, e + 1)) {
            const ids = table(e);
            if (ids.size > best.size) {
                best = ids;
            }
        }
    }
    if (best.size < 1000) {
        throw new Error('no identifier table');
    }
    return best;
}

/* protobuf encoding */
function varint(n) {
    const out = [];
    do {
        let b = n % 128;
        n = Math.floor(n / 128);
        if (n) {
            b |= 0x80;
        }
        out.push(b);
    } while (n);
    return Buffer.from(out);
}

function template(ids, surfaceId) {
    const v = (f, n) => Buffer.concat([varint(f * 8), varint(n)]);
    const f32 = (f, x) => {
        const b = Buffer.alloc(4);
        b.writeFloatLE(x, 0);
        return Buffer.concat([varint(f * 8 + 5), b]);
    };
    const m = (f, ...parts) => {
        const body = Buffer.concat(parts);
        return Buffer.concat([varint(f * 8 + 2), varint(body.length), body]);
    };
    const id = (f, name) => {
        if (!ids.has(name)) {
            throw new Error(`HmiMain3D has no identifier ${name}`);
        }
        return m(f, v(1, ids.get(name)));
    };
    // a child's parameter bound to the page's `source`, or set to a value
    const bind = (param, source, mode) => m(3, id(1, param), m(2, id(1, source), m(2, v(4, mode))));
    const set = (param, value) => m(3, id(1, param), m(2, m(2, m(1, value))));
    const float = (x) => m(5, f32(3, x));
    const int = (n) => m(5, v(2, n));
    const ident = (name) => Buffer.concat([v(6, 16), id(7, name)]);
    const ref = (param) => m(3, id(1, param), m(2, v(4, 4)));
    const val = (x) => m(3, m(2, m(1, float(x))));
    const vec3 = (a, b, c) => m(2, m(5, v(1, 21), v(2, 2), v(2, 2), v(2, 2), a, b, c));
    const zero = m(2, m(1, float(0)));
    const flow = m(6, m(2, m(1, m(20, v(1, 0), v(2, 5), v(3, 2)))));
    const P = (s) => `eGfxIdParameter_${s}`;

    const titlebar = m(3, id(1, 'eGfxIdWidget_Titlebar'), id(2, 'eGfxIdWidgetType_eWidgetType_TitlebarProxy'),
        ...['eParam_CursorAvailable', 'eParam_CursorTouchScrollingActive', 'eParam_DayTime',
            'eParam_DomainSelf', 'eParam_InputModality', 'eParam_IsSelectionOpened'].map((p) => bind(P(p), P(p), 0)),
        set(P('eParam_Location'), ident('eGfxIdParameterValue_Title')),
        bind(P('eParam_TabletFocused'), P('eParam_TabletFocused'), 0),
        bind(P('eParam_UsrModality'), P('eParam_UsrModality'), 0),
        bind(P('eParam_Visible'), P('eParam_ContentVisible'), 1),
        m(5));
    const stream = m(3, id(1, 'eGfxIdWidget_layer'), id(2, 'eGfxIdWidgetType_eWidgetType_EmbeddedSurface'),
        set(P('eParam_SurfaceId'), int(surfaceId)),
        set(P('eParam_FallbackType'), ident('eGfxIdParameterValue_disabled')),
        bind(P('eParam_TextureRectangle'), P('TextureRectangle'), 0),
        bind(P('eParam_Visible'), P('eParam_ContentVisible'), 1),
        m(5));
    const params = [
        m(4, id(1, P('eParam_Raster')), m(3, m(2, m(1, float(0))))),
        m(4, id(1, P('TextureRectangle')), m(2, m(5, m(6, f32(1, 0), f32(2, 0), f32(3, 1), f32(4, 1)))))
    ];
    const margins = [2, 3, 4, 5, 6, 7].map((k) => m(k, zero));
    const titlebarBox = m(1,
        m(2, id(1, 'eGfxIdLayout_Layout_2'),
            m(3,
                m(1, m(1, m(2, m(1, v(40, 0)))), ...margins),
                m(2, m(1, id(1, 'eGfxIdWidget_Titlebar'),
                    m(3, id(1, P('titlebarRegularW_ID7')), m(2, v(4, 4))),
                    m(4, m(2, m(1, float(1)))),
                    m(5, m(2, m(1, v(41, 1)))),
                    flow)))),
        m(3, vec3(ref(P('titlebarRegularDynTextW_ID7')), ref(P('defaultD_ID7')), ref(P('titlebarH_ID7')))),
        m(5, vec3(ref(P('titlebarX_ID7')), m(3, zero), ref(P('titlebarMB_ID7')))),
        flow,
        m(7, m(2, m(1, v(41, 0)))));
    const streamBox = m(1, id(1, 'eGfxIdWidget_layer'),
        m(3, vec3(val(AREA.w), ref(P('defaultD_ID7')), val(AREA.h))),
        m(5, vec3(val(AREA.x), val(0), val(0))),
        flow,
        m(7, m(2, m(1, v(41, 0)))));
    const layout = m(9, id(1, 'eGfxIdLayout_content'),
        m(2, m(1, m(2, id(1, 'eGfxIdLayout_spec'), m(2, titlebarBox, streamBox)))));
    return m(1, id(1, TEMPLATE), id(2, 'eGfxIdWidgetType_eWidgetType_PlayerBasic'),
        titlebar, stream, ...params, layout,
        id(14, 'eGfxIdImportDefinition_WID_State_Generic'),
        id(14, 'eGfxIdImportDefinition_StatesWithTitlebarImport'),
        m(20, id(1, 'eGfxIdLayout_default')));
}

if (require.main === module) {
    const opt = { hmi: '/usr/bin/HmiMain3D', 'surface-id': '0x500' };
    for (let i = 2; i + 1 < process.argv.length; i += 2) {
        opt[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
    }
    const surfaceId = Number(opt['surface-id']);
    if (!opt.out || !Number.isInteger(surfaceId) || surfaceId < 0) {
        console.error('usage: node hmi_template.js [--hmi FILE] [--surface-id ID] --out DIR');
        process.exit(2);
    }
    const file = path.join(opt.out, `${TEMPLATE.replace('eGfxIdWidgetType_', '')}.pbw`);
    fs.writeFileSync(file, template(identifiers(fs.readFileSync(opt.hmi)), surfaceId));
    console.log(`${file}: surface ${opt['surface-id']}`);
}

module.exports = { identifiers, template, TEMPLATE };
