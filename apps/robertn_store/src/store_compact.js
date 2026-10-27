'use strict';
/**
 * The Store's screens laid out for a box under 700 px high (iDrive 7: the
 * page template's 1796 x 632, or the app area's 1790 x 638), at scale 1:
 * the same screens and element names as src/am_screens.js (App Manager 2's
 * iDrive 8 design), so src/store_ui.js gives both their values, but with a
 * one-row header (title, status, filters, online state), small margins,
 * three rows of tiles, list rows and buttons sized for the iDrive 7's text.
 *
 *   compact(w, h) -> { design: { w, h }, screens }
 *
 * Every element stays inside the box with room for the focus ring (8 px
 * out, 5 px wide).
 */

const M = 14;                 // the box's margin: the focus ring's room
const RAIL = 150;
const NAV_ITEMS = 'Store, grid\nInstalled, check\nUSB, usb\nSettings, gear';
const TEXT = 'text';
const DIM = 'dim';
const AMBER = '#ffb020';
const BLUE = '#3d9bff';

const el = (name, gpu, x, y, w, h, opts, onTap) => Object.assign({ name, rtype: 'gpu', gpu, x: Math.round(x), y: Math.round(y),
    w: Math.round(w), h: Math.round(h), opts }, onTap ? { onTap } : {});
const text = (name, x, y, w, h, t, size, font, color, extra) => el(name, 'text', x, y, w, h,
    Object.assign({ text: t, size, font: font || 'label', align: 'left', color: color || TEXT }, extra || {}));
const button = (name, x, y, w, h, t, style, size, extra) => el(name, 'vbutton', x, y, w, h,
    Object.assign({ text: t, vicon: '', style: style || 'outline', size }, extra || {}), `event:${name}`);

function compact(W, H) {
    const X = M + RAIL + 16;          // the content's left edge
    const R = W - M;                  // its right edge
    const B = H - M;                  // its bottom
    const CW = R - X;
    const nav = (sel) => el('nav', 'sideNav', M, M, RAIL, H - 2 * M, { items: NAV_ITEMS, sel, labelSize: 24 });
    const screen = (name, sel, components) => ({ kind: 'gpu', name, theme: 'm_tricolour', bg: 'theme',
        components: [nav(sel)].concat(components) });
    // the header row: the title, then the status on its baseline
    const HEAD = M + 64;
    const title = (t, x) => text('title', x === undefined ? X : x, M + 2, 640, 60, t, 50, 'bold');
    const status = (name, x, w, color) => text(name, x, M + 24, w, 30, '', 23, 'label', color || DIM);
    const back = () => el('back', 'vbutton', X, M, 64, 64, { text: '', vicon: 'back', style: 'round', color: '#f4f7fb' }, 'event:back');
    const BTN_H = 76;
    const GRID_Y = HEAD + 10;
    const grid = () => el('grid', 'appGrid', X - 8, GRID_Y, CW + 8, B - GRID_Y, { items: '', cols: 5, tileH: Math.floor((B - GRID_Y) / 3),
        iconK: 0.46, titleSize: 28, subSize: 22, empty: '' });
    const LIST = { rowH: 92, titleSize: 28, subSize: 22, ctlK: 0.85 };
    const list = (name, x, y, w, h, extra) => el(name, 'appList', x, y, w, h, Object.assign({ items: '' }, LIST, extra || {}));
    const label = (name, x, y, t) => text(name, x, y, 400, 26, t, 20, 'bold', DIM);

    const FILTER_W = 420;
    const ONLINE_W = 190;
    const filterX = R - ONLINE_W - 20 - FILTER_W;
    const store = screen('store', 0, [
        title('Store'),
        status('subtitle', X + 160, filterX - X - 180),
        el('filter', 'tabs', filterX, M + 2, FILTER_W, 60, { items: 'All,Apps,Tools', sel: 0, style: 'joined', size: 24 }),
        el('online', 'chips', R - ONLINE_W, M + 8, ONLINE_W, 48, { items: '', align: 'right' }),
        grid()
    ]);
    const usb = screen('usb', 2, [title('USB'), status('subtitle', X + 130, CW - 130), grid()]);

    const colW = (CW - 24) / 2;
    const LIST_Y = HEAD + 38;
    const installed = screen('installed', 1, [
        title('Installed'),
        status('subtitle', X + 240, CW - 240 - 380),
        button('updateAll', R - 360, M, 360, 66, '', 'primary', 25, { vicon: 'arrowDown', color: BLUE }),
        label('appsLabel', X, HEAD + 8, 'APPS'),
        list('apps', X, LIST_Y, colW, B - LIST_Y, { empty: 'No apps installed' }),
        label('svcLabel', X + colW + 24, HEAD + 8, 'HEAD-UNIT TOOLS'),
        list('services', X + colW + 24, LIST_Y, colW, B - LIST_Y)
    ]);

    const leftW = Math.round(CW * 0.56);
    const rx = X + leftW + 24;
    const rw = R - rx;
    const SET_H = 72;
    const settings = screen('settings', 3, [
        title('Settings'),
        status('note', X + 230, CW - 230, AMBER),
        label('reposLabel', X, HEAD + 8, 'SOURCES'),
        list('repos', X, LIST_Y, leftW, B - SET_H - 12 - LIST_Y),
        button('addRepo', X, B - SET_H, leftW, SET_H, 'Add source', 'tinted', 25, { vicon: 'plus', color: BLUE }),
        el('connPanel', 'rect', rx, HEAD + 4, rw, B - HEAD - 4, { color: 'panelTop', radius: 20 }),
        label('connLabel', rx + 18, HEAD + 18, 'ACCESS'),
        list('access', rx + 12, HEAD + 52, rw - 24, 2 * LIST.rowH),
        text('unit', rx + 18, HEAD + 60 + 2 * LIST.rowH, rw - 36, 34, '', 26, 'bold'),
        text('versions', rx + 18, HEAD + 100 + 2 * LIST.rowH, rw - 36, 60, '', 22, 'label', DIM, { wrap: true }),
        button('checkNow', rx + 16, B - SET_H - 14, (rw - 44) / 2, SET_H, 'Check now', 'outline', 25, { vicon: 'refresh' }),
        button('restart', rx + 28 + (rw - 44) / 2, B - SET_H - 14, (rw - 44) / 2, SET_H, 'Restart head unit', 'outline', 25,
            { vicon: 'refresh' })
    ]);

    // a component's page: what it is on the left, the versions and the buttons in the panel on the right
    const PW = 470;
    const px = R - PW;
    const lw = px - X - 24;
    const ix = X + 224;
    const secondaryY = B - BTN_H - 14;
    const primaryY = secondaryY - 12 - 84;
    const app = screen('app', 0, [
        back(),
        el('icon', 'appIcon', X + 84, M, 120, 120, { vicon: '', colors: '#3a4352,#232a35' }),
        text('name', ix, M, lw - 224, 72, '', 63, 'bold'),
        text('author', ix, M + 76, lw - 224, 32, '', 27, 'label', DIM),
        el('facts', 'chips', ix, M + 114, lw - 224, 44, { items: '' }),
        text('desc', X, M + 176, lw, B - M - 176, '', 27, 'label', TEXT, { wrap: true }),
        el('panel', 'rect', px, M, PW, H - 2 * M, { color: 'panelTop', radius: 20 }),
        text('instLabel', px + 20, M + 16, 200, 28, '', 22, 'label', DIM),
        text('instValue', px + 20, M + 46, 200, 58, '', 46, 'num'),
        text('availLabel', px + 230, M + 16, 220, 28, '', 22, 'label', DIM),
        text('availValue', px + 230, M + 46, 220, 58, '', 46, 'num', BLUE),
        text('note1', px + 20, M + 118, PW - 40, 32, '', 25, 'label', DIM),
        text('note2', px + 20, M + 154, PW - 40, 32, '', 25, 'label', DIM),
        text('note3', px + 20, M + 190, PW - 40, 32, '', 25, 'label', AMBER),
        el('progress', 'progress', px + 20, primaryY - 104, PW - 40, 90, { label: '', right: '', sub: '', value: 0, percent: false,
            size: 24, hidden: true }),
        button('primary', px + 20, primaryY, PW - 40, 84, '', 'primary', 30, { vicon: 'arrowDown', color: BLUE }),
        button('secondary', px + 20, secondaryY, PW - 40, BTN_H, '', 'outline', 28, { vicon: 'trash' })
    ]);

    // the confirm sheet over the page
    const SW = Math.min(1200, CW);
    const SH = 380;
    const sx = X + (CW - SW) / 2;
    const sy = (H - SH) / 2;
    const BW = (SW - 100) / 2;
    const confirm = screen('confirm', 0, [
        el('sheet', 'sheet', sx, sy, SW, SH, { radius: 24 }),
        el('icon', 'appIcon', sx + 40, sy + 36, 110, 110, { vicon: '', colors: '#3a4352,#232a35' }),
        text('title', sx + 176, sy + 44, SW - 216, 50, '', 41, 'bold'),
        text('text', sx + 176, sy + 104, SW - 216, 32, '', 26, 'label', DIM),
        button('now', sx + 40, sy + SH - 126, BW, 90, '', 'primary', 31, { color: BLUE }),
        button('later', sx + 60 + BW, sy + SH - 126, BW, 90, 'Cancel', 'outline', 31),
        text('note', sx + 40, sy + SH - 30, SW - 80, 24, '', 21, 'label', DIM, { align: 'center' })
    ]);

    const QR_PW = 430;
    const qx = R - QR_PW;
    const sw = qx - ix - 24;
    const source = screen('source', 3, [
        back(),
        el('icon', 'appIcon', X + 84, M, 120, 120, { vicon: 'lock', kind: 'service', colors: '#3a4352,#232a35' }),
        text('name', ix, M, sw, 62, '', 53, 'bold'),
        text('state', ix, M + 66, sw, 32, '', 27, 'label', DIM),
        el('facts', 'chips', ix, M + 104, sw, 44, { items: [] }),
        text('desc', X, M + 166, qx - X - 24, B - BTN_H - 24 - M - 166, '', 26, 'label', AMBER, { wrap: true }),
        button('remove', X, B - BTN_H, 420, BTN_H, 'Remove', 'outline', 29, { vicon: 'trash' }),
        el('panel', 'rect', qx, M, QR_PW, H - 2 * M, { color: 'panelTop', radius: 20 }),
        text('appLabel', qx + 20, M + 14, QR_PW - 40, 34, '', 26, 'bold'),
        el('appQr', 'qr', qx + 30, M + 58, QR_PW - 60, QR_PW - 60, { text: '' }),
        text('appUrl', qx + 20, B - 40, QR_PW - 40, 26, '', 17, 'label', DIM)
    ]);

    const titleX = X + 84;
    const accounts = screen('accounts', 3, [
        back(),
        title('Accounts', titleX),
        status('status', titleX + 260, CW - 360),
        list('list', X, HEAD + 14, Math.min(1100, CW), B - BTN_H - 16 - HEAD - 14, { empty: 'None' }),
        button('signIn', X, B - BTN_H, 520, BTN_H, 'Sign in with GitHub', 'primary', 29, { vicon: 'plus', color: BLUE }),
        button('addToken', X + 544, B - BTN_H, 360, BTN_H, 'Add token', 'outline', 29, { vicon: 'plus' })
    ]);
    const pick = screen('pick', 3, [
        back(),
        // a repo's name takes what the status leaves
        text('title', titleX, M + 2, CW - 84 - 440, 60, '', 50, 'bold'),
        status('status', R - 420, 420),
        list('list', X, HEAD + 14, Math.min(1100, CW), B - BTN_H - 16 - HEAD - 14, { empty: '' }),
        button('signIn', X, B - BTN_H, 520, BTN_H, 'Sign in with GitHub', 'primary', 29, { vicon: 'plus', color: BLUE }),
        button('addToken', X + 544, B - BTN_H, 360, BTN_H, 'Add token', 'outline', 29, { vicon: 'plus' }),
        button('retry', X, B - BTN_H, 360, BTN_H, 'Try again', 'outline', 29, { vicon: 'refresh' })
    ]);
    const QR = Math.min(B - HEAD - 10, 520);
    const login = screen('login', 3, [
        back(),
        title('Sign in with GitHub', titleX),
        el('qr', 'qr', X, HEAD + 10, QR, QR, { text: '' }),
        text('code', X + QR + 40, HEAD + 36, CW - QR - 40, 94, '', 80, 'bold'),
        text('url', X + QR + 40, HEAD + 150, CW - QR - 40, 34, '', 27, 'label', DIM),
        text('status', X + QR + 40, HEAD + 200, CW - QR - 40, 34, '', 27, 'label', DIM),
        button('cancel', X + QR + 40, HEAD + 270, 360, BTN_H, 'Cancel', 'outline', 29)
    ]);
    const PQR = Math.min(B - M, 560);
    const phoneW = CW - PQR - 40;
    const phone = screen('phone', 3, [
        back(),
        title('Phone access', titleX),
        list('toggleRow', X, HEAD + 14, phoneW, LIST.rowH),
        text('url', X, HEAD + 124, phoneW, 130, '', 26, 'label', DIM, { wrap: true }),
        text('error', X, HEAD + 264, phoneW, 130, '', 26, 'label', AMBER, { wrap: true }),
        el('qr', 'qr', R - PQR, M, PQR, PQR, { text: '' })
    ]);
    return { design: { w: W, h: H }, screens: [store, app, confirm, installed, usb, settings, source, accounts, pick, login, phone] };
}

module.exports = { compact };
