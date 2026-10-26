#!/usr/bin/env python3
"""Writes src/am_screens.js from IterioDev's App Manager 2 screens.json
(mgu-app-store apps/oap-appmanager/renderer/screens.json): his store, app,
restart (as confirm), installed, usb and settings screens with the Store's
labels, and the Store's own pages in the same frame.

    python3 tools/gen_screens.py <screens.json> src/am_screens.js <mgu-app-store commit>
"""
import json, copy, sys
src, out, commit = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src))
S = {s['name']: s for s in d['screens']}
def comp(name, gpu, x, y, w, h, opts, onTap=None):
    c = {'name': name, 'rtype': 'gpu', 'gpu': gpu, 'x': x, 'y': y, 'w': w, 'h': h, 'opts': opts}
    if onTap: c['onTap'] = onTap
    return c
def get(st, n): return next(c for c in st['components'] if c['name'] == n)
def drop(st, *names): st['components'] = [c for c in st['components'] if c['name'] not in names]
NAV = copy.deepcopy(get(S['store'], 'nav'))
NAV['opts']['items'] = 'Store, grid\nInstalled, check\nUSB, usb\nSettings, gear'
def base(name):
    return {'kind': 'gpu', 'name': name, 'theme': S['store']['theme'], 'bg': S['store']['bg'], 'components': [copy.deepcopy(NAV)]}
def text(name, x, y, w, h, t, size, font='label', color='text', align='left', wrap=False):
    o = {'text': t, 'size': size, 'font': font, 'align': align, 'color': color}
    if wrap: o['wrap'] = True
    return comp(name, 'text', x, y, w, h, o)
BACK = copy.deepcopy(get(S['app'], 'back'))
screens = []
# store: his, filter Apps / Tools
st = copy.deepcopy(S['store']); get(st, 'filter')['opts']['items'] = 'All,Apps,Tools'; screens.append(st)
# app: his
screens.append(copy.deepcopy(S['app']))
# confirm: his restart sheet, for every confirm step
st = copy.deepcopy(S['restart']); st['name'] = 'confirm'; screens.append(st)
# installed: his, tools for system services
st = copy.deepcopy(S['installed']); get(st, 'svcLabel')['opts']['text'] = 'HEAD-UNIT TOOLS'; screens.append(st)
st = copy.deepcopy(S['usb']); get(st, 'title')['opts']['text'] = 'USB'; screens.append(st)
# settings: sources on the left, access and the head unit on the right
st = copy.deepcopy(S['settings'])
get(st, 'reposLabel')['opts']['text'] = 'SOURCES'
get(st, 'addRepo')['opts']['text'] = 'Add source'
get(st, 'connLabel')['opts']['text'] = 'ACCESS'
drop(st, 'tetherIcon', 'tetherName', 'tetherState', 'tether', 'checkNow', 'lastCheck', 'versions', 'subtitle')
st['components'] += [
    comp('access', 'appList', 1880, 412, 920, 260, {'items': [], 'rowH': 120}),
    text('unit', 1880, 668, 920, 40, '', 32, 'bold'),
    text('versions', 1880, 714, 920, 38, '', 28, 'label', 'dim'),
    comp('checkNow', 'vbutton', 1880, 764, 440, 56, {'text': 'Check now', 'vicon': 'refresh', 'style': 'outline', 'size': 26}, 'event:checkNow'),
    comp('restart', 'vbutton', 2340, 764, 460, 56, {'text': 'Restart head unit', 'vicon': 'refresh', 'style': 'outline', 'size': 26}, 'event:restart'),
    text('note', 480, 227, 1300, 43, '', 34, 'label', '#ffb020'),
]
get(st, 'connPanel').update({'y': 336, 'h': 494})
screens.append(st)
# a source's page: the app page's frame
st = base('source')
st['components'] += [copy.deepcopy(BACK),
    comp('icon', 'appIcon', 630, 150, 220, 220, {'vicon': 'lock', 'kind': 'service', 'colors': '#3a4352,#232a35'}),
    text('name', 900, 161, 1200, 110, '', 80, 'bold'),
    text('state', 904, 262, 1100, 50, '', 40, 'label', 'dim'),
    comp('facts', 'chips', 900, 340, 1180, 68, {'items': []}),
    text('desc', 480, 470, 1560, 300, '', 40, 'label', '#ffb020', wrap=True),
    comp('panel', 'rect', 2100, 136, 740, 700, {'color': 'panelTop', 'radius': 28}),
    text('appLabel', 2140, 180, 660, 48, 'Install on GitHub', 38, 'bold'),
    comp('appQr', 'qr', 2240, 250, 460, 460, {'text': ''}),
    text('appUrl', 2140, 730, 660, 36, '', 26, 'label', 'dim'),
    comp('remove', 'vbutton', 480, 720, 520, 106, {'text': 'Remove', 'vicon': 'trash', 'style': 'outline'}, 'event:remove'),
]
screens.append(st)
# accounts
st = base('accounts')
st['components'] += [copy.deepcopy(BACK),
    text('title', 610, 138, 1200, 90, 'Accounts', 72, 'bold'),
    text('status', 610, 227, 1600, 43, '', 34, 'label', 'dim'),
    comp('list', 'appList', 610, 292, 1500, 400, {'items': [], 'rowH': 120, 'empty': 'None'}),
    comp('signIn', 'vbutton', 610, 724, 760, 106, {'text': 'Sign in with GitHub', 'vicon': 'plus', 'style': 'primary', 'color': '#3d9bff'}, 'event:signIn'),
    comp('addToken', 'vbutton', 1400, 724, 560, 106, {'text': 'Add token', 'vicon': 'plus', 'style': 'outline'}, 'event:addToken'),
]
screens.append(st)
# GitHub sign-in
st = base('login')
st['components'] += [copy.deepcopy(BACK),
    text('title', 610, 138, 1600, 90, 'Sign in with GitHub', 72, 'bold'),
    comp('qr', 'qr', 610, 290, 520, 520, {'text': ''}),
    text('code', 1220, 330, 1400, 140, '', 120, 'bold'),
    text('url', 1224, 500, 1400, 50, '', 40, 'label', 'dim'),
    text('status', 1224, 580, 1400, 50, '', 38, 'label', 'dim'),
    comp('cancel', 'vbutton', 1220, 700, 520, 106, {'text': 'Cancel', 'style': 'outline'}, 'event:cancel'),
]
screens.append(st)
# Phone access
st = base('phone')
st['components'] += [copy.deepcopy(BACK),
    text('title', 610, 138, 1200, 90, 'Phone access', 72, 'bold'),
    comp('toggleRow', 'appList', 610, 292, 1100, 120, {'items': [], 'rowH': 120}),
    text('url', 610, 450, 1100, 200, '', 34, 'label', 'dim', wrap=True),
    text('error', 610, 680, 1100, 120, '', 34, 'label', '#ffb020', wrap=True),
    comp('qr', 'qr', 1900, 220, 600, 600, {'text': ''}),
]
screens.append(st)
body = json.dumps({'design': d['design'], 'screens': screens}, indent=1)
open(out, 'w').write("""'use strict';
/**
 * The Store's renderer screens, in iDrive 8 design pixels (2880 x 960; the
 * Store scales them into iDrive 8's box, src/store_compact.js lays the same
 * screens out for iDrive 7's). store,
 * app, confirm (the sheet), installed, usb and settings are IterioDev's App
 * Manager 2 screens (mgu-app-store apps/oap-appmanager/renderer/screens.json
 * @ %s, the HMI UI builder's export of projects/app-manager.json, reused with
 * his permission) with the Store's labels; source, accounts, login and phone
 * are the Store's own in the same frame. Each element is drawn by
 * am_gpu.js; src/store_ui.js gives their values.
 */
module.exports = %s;
""" % (commit[:7], body))
