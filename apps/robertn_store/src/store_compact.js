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
    // the header row: title, then the status after it
    const HEAD = M + 56;
    const title = (t, x) => text('title', x === undefined ? X : x, M + 4, 600, 52, t, 41, 'bold');
    const subtitle = (x, w) => text('subtitle', x, M + 22, w, 28, '', 23, 'label', DIM);
    const back = () => el('back', 'vbutton', X, M, 60, 60, { text: '', vicon: 'back', style: 'round', color: '#f4f7fb' }, 'event:back');
    // a grid of three rows of five tiles
    const GRID_Y = HEAD + 10;
    const grid = () => el('grid', 'appGrid', X - 8, GRID_Y, CW + 8, B - GRID_Y, { items: '', cols: 5, tileH: Math.floor((B - GRID_Y) / 3),
        iconK: 0.46, titleSize: 28, subSize: 22, empty: '' });
    const LIST = { rowH: 86, titleSize: 26, subSize: 21, ctlK: 0.8 };
    const list = (name, x, y, w, h, extra) => el(name, 'appList', x, y, w, h, Object.assign({ items: '' }, LIST, extra || {}));
    const label = (name, x, y, t) => text(name, x, y, 400, 26, t, 20, 'bold', DIM);

    const FILTER_W = 390;
    const ONLINE_W = 190;
    const filterX = R - ONLINE_W - 20 - FILTER_W;
    const store = screen('store', 0, [
        title('Store'),
        subtitle(X + 150, filterX - X - 170),
        el('filter', 'tabs', filterX, M + 4, FILTER_W, 48, { items: 'All,Apps,Tools', sel: 0, style: 'joined', size: 23 }),
        el('online', 'chips', R - ONLINE_W, M + 6, ONLINE_W, 46, { items: '', align: 'right' }),
        grid()
    ]);
    const usb = screen('usb', 2, [title('USB'), subtitle(X + 110, CW - 110), grid()]);

    const colW = (CW - 24) / 2;
    const LIST_Y = HEAD + 40;
    const installed = screen('installed', 1, [
        title('Installed'),
        subtitle(X + 200, CW - 200 - 360),
        button('updateAll', R - 340, M + 4, 340, 50, '', 'primary', 23, { vicon: 'arrowDown', color: BLUE }),
        label('appsLabel', X, HEAD + 10, 'APPS'),
        list('apps', X, LIST_Y, colW, B - LIST_Y, { empty: 'No apps installed' }),
        label('svcLabel', X + colW + 24, HEAD + 10, 'HEAD-UNIT TOOLS'),
        list('services', X + colW + 24, LIST_Y, colW, B - LIST_Y)
    ]);

    const leftW = Math.round(CW * 0.56);
    const rx = X + leftW + 24;
    const rw = R - rx;
    const BTN_H = 64;
    const settings = screen('settings', 3, [
        title('Settings'),
        text('note', X + 190, M + 22, CW - 190, 28, '', 23, 'label', AMBER),
        label('reposLabel', X, HEAD + 10, 'SOURCES'),
        list('repos', X, LIST_Y, leftW, B - BTN_H - 12 - LIST_Y),
        button('addRepo', X, B - BTN_H, leftW, BTN_H, 'Add source', 'tinted', 24, { vicon: 'plus', color: BLUE }),
        el('connPanel', 'rect', rx, HEAD + 4, rw, B - HEAD - 4, { color: 'panelTop', radius: 20 }),
        label('connLabel', rx + 18, HEAD + 18, 'ACCESS'),
        list('access', rx + 12, HEAD + 52, rw - 24, 2 * LIST.rowH),
        text('unit', rx + 18, HEAD + 60 + 2 * LIST.rowH, rw - 36, 32, '', 25, 'bold'),
        text('versions', rx + 18, HEAD + 98 + 2 * LIST.rowH, rw - 36, 28, '', 21, 'label', DIM),
        button('checkNow', rx + 16, B - BTN_H - 14, (rw - 44) / 2, BTN_H, 'Check now', 'outline', 24, { vicon: 'refresh' }),
        button('restart', rx + 28 + (rw - 44) / 2, B - BTN_H - 14, (rw - 44) / 2, BTN_H, 'Restart head unit', 'outline', 24,
            { vicon: 'refresh' })
    ]);

    // a component's page: what it is on the left, the versions and the buttons in the panel on the right
    const PW = 470;
    const px = R - PW;
    const lw = px - X - 24;
    const app = screen('app', 0, [
        back(),
        el('icon', 'appIcon', X + 80, M + 2, 110, 110, { vicon: '', colors: '#3a4352,#232a35' }),
        text('name', X + 214, M + 4, lw - 214, 50, '', 41, 'bold'),
        text('author', X + 214, M + 60, lw - 214, 30, '', 23, 'label', DIM),
        el('facts', 'chips', X + 214, M + 96, lw - 214, 42, { items: '' }),
        text('desc', X, M + 150, lw, B - M - 150, '', 25, 'label', TEXT, { wrap: true }),
        el('panel', 'rect', px, M, PW, H - 2 * M, { color: 'panelTop', radius: 20 }),
        text('instLabel', px + 20, M + 14, 210, 26, '', 21, 'label', DIM),
        text('instValue', px + 20, M + 42, 210, 48, '', 41, 'num'),
        text('availLabel', px + 240, M + 14, 210, 26, '', 21, 'label', DIM),
        text('availValue', px + 240, M + 42, 210, 48, '', 41, 'num', BLUE),
        text('note1', px + 20, M + 108, PW - 40, 30, '', 23, 'label', DIM),
        text('note2', px + 20, M + 142, PW - 40, 30, '', 23, 'label', DIM),
        text('note3', px + 20, M + 176, PW - 40, 30, '', 23, 'label', AMBER),
        el('progress', 'progress', px + 20, B - 2 * BTN_H - 120, PW - 40, 90, { label: '', right: '', sub: '', value: 0, percent: false,
            size: 23, hidden: true }),
        button('primary', px + 20, B - 2 * BTN_H - 26, PW - 40, BTN_H, '', 'primary', 25, { vicon: 'arrowDown', color: BLUE }),
        button('secondary', px + 20, B - BTN_H - 12, PW - 40, BTN_H, '', 'outline', 24, { vicon: 'trash' })
    ]);

    // the confirm sheet over the page
    const SW = Math.min(1100, CW);
    const SH = 330;
    const sx = X + (CW - SW) / 2;
    const sy = (H - SH) / 2;
    const BW = (SW - 100) / 2;
    const confirm = screen('confirm', 0, [
        el('sheet', 'sheet', sx, sy, SW, SH, { radius: 24 }),
        el('icon', 'appIcon', sx + 40, sy + 36, 96, 96, { vicon: '', colors: '#3a4352,#232a35' }),
        text('title', sx + 160, sy + 44, SW - 200, 44, '', 33, 'bold'),
        text('text', sx + 160, sy + 98, SW - 200, 30, '', 23, 'label', DIM),
        button('now', sx + 40, sy + SH - 110, BW, 72, '', 'primary', 26, { color: BLUE }),
        button('later', sx + 60 + BW, sy + SH - 110, BW, 72, 'Cancel', 'outline', 26),
        text('note', sx + 40, sy + SH - 30, SW - 80, 24, '', 20, 'label', DIM, { align: 'center' })
    ]);

    const QR_PW = 430;
    const qx = R - QR_PW;
    const source = screen('source', 3, [
        back(),
        el('icon', 'appIcon', X + 80, M + 2, 96, 96, { vicon: 'lock', kind: 'service', colors: '#3a4352,#232a35' }),
        text('name', X + 196, M + 4, qx - X - 220, 48, '', 37, 'bold'),
        text('state', X + 196, M + 56, qx - X - 220, 30, '', 23, 'label', DIM),
        el('facts', 'chips', X + 196, M + 92, qx - X - 220, 42, { items: [] }),
        text('desc', X, M + 150, qx - X - 24, B - BTN_H - 24 - M - 150, '', 24, 'label', AMBER, { wrap: true }),
        button('remove', X, B - BTN_H, 360, BTN_H, 'Remove', 'outline', 24, { vicon: 'trash' }),
        el('panel', 'rect', qx, M, QR_PW, H - 2 * M, { color: 'panelTop', radius: 20 }),
        text('appLabel', qx + 20, M + 14, QR_PW - 40, 32, '', 25, 'bold'),
        el('appQr', 'qr', qx + 30, M + 58, QR_PW - 60, QR_PW - 60, { text: '' }),
        text('appUrl', qx + 20, B - 40, QR_PW - 40, 26, '', 17, 'label', DIM)
    ]);

    const titleX = X + 80;
    const accounts = screen('accounts', 3, [
        back(),
        title('Accounts', titleX),
        list('list', X, HEAD + 14, Math.min(1100, CW), B - BTN_H - 16 - HEAD - 14, { empty: 'None' }),
        button('signIn', X, B - BTN_H, 460, BTN_H, 'Sign in with GitHub', 'primary', 25, { vicon: 'plus', color: BLUE })
    ]);
    const QR = Math.min(B - HEAD - 14, 520);
    const login = screen('login', 3, [
        back(),
        title('Sign in with GitHub', titleX),
        el('qr', 'qr', X, HEAD + 10, QR, QR, { text: '' }),
        text('code', X + QR + 40, HEAD + 40, CW - QR - 40, 90, '', 77, 'bold'),
        text('url', X + QR + 40, HEAD + 150, CW - QR - 40, 34, '', 25, 'label', DIM),
        text('status', X + QR + 40, HEAD + 200, CW - QR - 40, 34, '', 25, 'label', DIM),
        button('cancel', X + QR + 40, HEAD + 260, 320, BTN_H, 'Cancel', 'outline', 25)
    ]);
    const PQR = Math.min(B - M, 560);
    const phoneW = CW - PQR - 40;
    const phone = screen('phone', 3, [
        back(),
        title('Phone access', titleX),
        list('toggleRow', X, HEAD + 14, phoneW, LIST.rowH),
        text('url', X, HEAD + 120, phoneW, 120, '', 24, 'label', DIM, { wrap: true }),
        text('error', X, HEAD + 260, phoneW, 120, '', 24, 'label', AMBER, { wrap: true }),
        el('qr', 'qr', R - PQR, M, PQR, PQR, { text: '' })
    ]);
    const CB = 360;
    const channel = screen('channel', 3, [
        back(),
        title('Channel', titleX),
        text('repo', titleX + 190, M + 22, CW - 290, 28, '', 23, 'label', DIM),
        button('releases', X, HEAD + 40, CB, 90, 'Releases', 'outline', 30),
        button('tags', X + CB + 24, HEAD + 40, CB, 90, 'Tags', 'outline', 30),
        button('branch', X + 2 * (CB + 24), HEAD + 40, CB, 90, 'Branch', 'outline', 30)
    ]);
    return { design: { w: W, h: H }, screens: [store, app, confirm, installed, usb, settings, source, accounts, login, phone, channel] };
}

module.exports = { compact, MARGIN: M };
