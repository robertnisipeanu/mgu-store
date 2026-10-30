'use strict';
/**
 * Writes robertn_store@0.9.13's application.xml and uiDescription.json for
 * iDrive 7 (uiDescriptions/ID7) and iDrive 8 (uiDescriptions/ID8) from the
 * tables below, so container and component ids, names, widgets and cells
 * stay in lockstep.
 *
 * The widget screens, shown while mgu-render is not there (LT_State_Wide on
 * iDrive 7, LT_State_Wide_List with LT_Button_MediaEntry_1Row rows on
 * iDrive 8):
 *
 *   1  ST_OnlineApps_Store             the entry state: a status line, Check for
 *                                      updates, the progress of the running
 *                                      install, the rows Apps, Head-unit tools,
 *                                      Sources and Phone access, and Restart
 *                                      head unit
 *   2  ST_OnlineApps_StoreApps         one list, a row (name | state) per app
 *   3  ST_OnlineApps_StoreTools        one list, a row per head-unit tool
 *   4  ST_OnlineApps_StoreRestart      the confirm step of Restart head unit:
 *                                      Cancel (focused first) and Restart
 *   5  ST_OnlineApps_StoreSources      a status line, one list, a row (name |
 *                                      status or account) per source, Add
 *                                      source (the HMI's speller,
 *                                      src/speller.js), Accounts and Phone
 *                                      access
 *   6  ST_OnlineApps_StoreSource       one source: its name and status, Channel,
 *                                      Account, Components, its error, Remove,
 *                                      and the GitHub App's install page (QR
 *                                      code and address) while it needs one
 *  34  ST_OnlineApps_StoreSourcePick   a GitHub repo being added: a status line
 *                                      (the repo, Checking, Not found or
 *                                      private, ...), one list, a row (name |
 *                                      kind) per channel it has (Releases,
 *                                      Tags, each branch), Sign in with
 *                                      GitHub, Add token, Try again
 *  32  ST_OnlineApps_StoreAccounts     a status line (Add token's), the
 *                                      updater's tokens: one list, a row
 *                                      (name | sources) per account, Sign in
 *                                      with GitHub, Add token (the speller)
 *  33  ST_OnlineApps_StoreAccountRemove the confirm step of an account's
 *                                      Remove: its name, its sources, Cancel,
 *                                      Remove
 *   7  ST_OnlineApps_StoreLogin        GitHub sign-in: Cancel (first, so the
 *                                      focus on it scrolls nothing away), the
 *                                      QR code of the sign-in page with the
 *                                      code beside it, the code and page as
 *                                      text, the status
 *   8  ST_OnlineApps_StoreSourceRemove the confirm step of a source's Remove
 *   9  ST_OnlineApps_StoreRemove       the confirm step of a component's Remove:
 *                                      its name, Cancel, Remove
 *  30  ST_OnlineApps_StorePhone        Phone access: On/Off, the page's QR code,
 *                                      its address, its error
 *
 * The host states of the screens mgu-render draws (src/am_screens.js),
 * one per page depth: ST_OnlineApps_StoreLayer1..3 (LT_State_Wide, under the
 * renderer's own layer) and, on iDrive 7, ST_OnlineApps_StoreEmbed1..3
 * (LT_State_A4A_WelcomeApp, the page template the renderer draws into).
 * Each holds focusable buttons, the proxies of what the drawn page has to
 * press in focus order (48, 24, 12 by depth): the HMI moves its focus over
 * them with the controller and reports focus and presses; BACK closes the
 * state. Each depth's state has the one below as its parent (on iDrive 8
 * none, statesFor); depth 1 is the entry state while its mode is in use.
 *
 * A list is one button component; the app sets its row count at runtime.
 * Ids share one space across containers, layout groups (100 + 2 * state
 * id, + 1) and components. iDrive 8's description has the hidden label
 * storeHmiID8, by which the app knows its widgets. tools/test_rhmi.js
 * checks the generated files.
 *
 *   node tools/gen_rhmi.js
 */
const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..', 'robertn_store@0.9.13');
const DIR = (hmi) => path.join(PKG, 'rhmiData', 'uiDescriptions', hmi);
const ID7 = DIR('ID7');
const ID8 = DIR('ID8');
const PROXIES = [48, 24, 12];

/* Abstract components: kind button, row (two columns; a list too), label,
 * picture, progress. */
const button = (id, name, text) => ({ id, kind: 'button', name, text, focusable: 3 });
const row = (id, name, text) => ({ id, kind: 'row', name, text, focusable: 3 });
const list = (id, name) => ({ id, kind: 'row', name, text: '', focusable: 3 });
const label = (id, name, text) => ({ id, kind: 'label', name, text: text || '', focusable: 0 });
const picture = (id, name) => ({ id, kind: 'picture', name, focusable: 0 });

/* Each head unit's widget and cells for each kind. */
const media = (primary, freq) => ({ PrimaryText: primary, FrequencyText: freq || '', FrequencyVisible: freq !== null,
    IconVisible: false, ProgressVisible: false, IsPlaying: false });
const WIDGETS = {
    ID7: {
        state: 'LT_State_Wide',
        button: (c) => ({ type: 'button', widget: 'LT_Button_1Row', cells: { Text: c.text } }),
        row: (c) => ({ type: 'button', widget: 'LT_Button_1Row_2Col7030_2Text', cells: { Text1stCol: c.text, Text2ndCol: '' } }),
        label: (c) => ({ type: 'label', widget: 'LT_Label_1Row', cells: { Text: c.text } }),
        picture: () => ({ type: 'label', widget: 'LT_Label_1Graphic_Scalable', cells: {} }),
        progress: () => ({ type: 'progressBar', widget: 'LT_Progressbar_Ent_ProgressBig', cells: { TextLeft: '', TextRight: '' } })
    },
    ID8: {
        state: 'LT_State_Wide_List',
        button: (c) => ({ type: 'button', widget: 'LT_Button_MediaEntry_1Row', cells: media(c.text, null) }),
        row: (c) => ({ type: 'button', widget: 'LT_Button_MediaEntry_1Row', cells: media(c.text, '') }),
        label: (c) => ({ type: 'label', widget: 'LT_ScrollLabel', cells: { Text: c.text } }),
        picture: () => ({ type: 'label', widget: null, cells: {} }),
        progress: () => ({ type: 'button', widget: 'LT_Button_MediaEntry_1Row', cells: media('', '') })
    }
};

function state(id, name, titleId, title, parent, components) {
    return { id, name, titleId, title: { value: title, type: 'Text' }, parent, components };
}

const MAIN = {
    id: 1, name: 'ST_OnlineApps_Store', titleId: 10, title: { value: 'SID_STORE_TITLE', type: 'StringId' },
    components: [
        label(20, 'storeStatus', 'Store'),
        button(21, 'storeCheck', 'Check for updates'),
        { id: 22, kind: 'progress', name: 'storeProgress', focusable: 0 },
        row(23, 'storeNavApps', 'Apps'),
        row(24, 'storeNavTools', 'Head-unit tools'),
        row(26, 'storeNavSources', 'Sources'),
        row(27, 'storeNavPhone', 'Phone access'),
        button(25, 'storeRestart', 'Restart head unit')
    ]
};

const SOURCES = state(5, 'ST_OnlineApps_StoreSources', 14, 'Sources', MAIN.id, [
    label(29, 'storeSourcesStatus'),
    list(82, 'storeSourceList'),
    button(83, 'storeSourceAdd', 'Add source'),
    row(140, 'storeSourceAccounts', 'Accounts'),
    button(39, 'storeSourcePhone', 'Phone access')
]);

const SOURCE = state(6, 'ST_OnlineApps_StoreSource', 15, 'Source', SOURCES.id, [
    row(84, 'storeSrcStatus', 'Source'),
    row(28, 'storeSrcChannel', 'Channel'),
    row(85, 'storeSrcAccount', 'Account'),
    row(86, 'storeSrcComponents', 'Components'),
    label(89, 'storeSrcError'),
    button(88, 'storeSrcRemove', 'Remove'),
    label(67, 'storeSrcAppLabel', 'Install on GitHub'),
    picture(68, 'storeSrcAppQr'),
    label(69, 'storeSrcAppUrl')
]);

const PICK = state(34, 'ST_OnlineApps_StoreSourcePick', 43, 'Add source', SOURCES.id, [
    label(143, 'storePickStatus'),
    list(144, 'storePickList'),
    button(145, 'storePickSignIn', 'Sign in with GitHub'),
    button(146, 'storePickAddToken', 'Add token'),
    button(147, 'storePickRetry', 'Try again')
]);

const ACCOUNTS = state(32, 'ST_OnlineApps_StoreAccounts', 41, 'Accounts', SOURCES.id, [
    label(141, 'storeAccountsStatus'),
    list(134, 'storeAccountList'),
    button(135, 'storeAccountSignIn', 'Sign in with GitHub'),
    button(142, 'storeAccountAddToken', 'Add token')
]);

const WIDGET_STATES = [
    MAIN,
    state(2, 'ST_OnlineApps_StoreApps', 11, 'Apps', MAIN.id, [list(40, 'storeAppList')]),
    state(3, 'ST_OnlineApps_StoreTools', 12, 'Head-unit tools', MAIN.id, [list(60, 'storeToolList')]),
    state(4, 'ST_OnlineApps_StoreRestart', 13, 'Restart head unit?', MAIN.id, [
        button(80, 'storeRestartCancel', 'Cancel'),
        button(81, 'storeRestartConfirm', 'Restart')
    ]),
    SOURCES,
    SOURCE,
    PICK,
    ACCOUNTS,
    state(33, 'ST_OnlineApps_StoreAccountRemove', 42, 'Remove account?', ACCOUNTS.id, [
        label(136, 'storeAccountName'),
        label(137, 'storeAccountSources'),
        button(138, 'storeAccountRemoveCancel', 'Cancel'),
        button(139, 'storeAccountRemoveConfirm', 'Remove')
    ]),
    state(7, 'ST_OnlineApps_StoreLogin', 16, 'Sign in with GitHub', ACCOUNTS.id, [
        button(93, 'storeLoginCancel', 'Cancel'),
        picture(90, 'storeLoginQr'),
        label(94, 'storeLoginCode'),
        label(91, 'storeLoginUrl'),
        label(92, 'storeLoginStatus')
    ]),
    state(8, 'ST_OnlineApps_StoreSourceRemove', 17, 'Remove source?', SOURCE.id, [
        button(95, 'storeSrcRemoveCancel', 'Cancel'),
        button(96, 'storeSrcRemoveConfirm', 'Remove')
    ]),
    state(9, 'ST_OnlineApps_StoreRemove', 18, 'Remove?', MAIN.id, [
        label(97, 'storeRemoveName'),
        button(98, 'storeRemoveCancel', 'Cancel'),
        button(99, 'storeRemoveConfirm', 'Remove')
    ]),
    state(30, 'ST_OnlineApps_StorePhone', 19, 'Phone access', MAIN.id, [
        row(130, 'storePhoneToggle', 'Phone access'),
        picture(131, 'storePhoneQr'),
        label(132, 'storePhoneUrl'),
        label(133, 'storePhoneError')
    ])
];

/* The host states of the drawn screens, by mode and depth. */
const HOST_MODES = [{ mode: 'layer', name: 'Layer', first: 51, widget: null },
    { mode: 'embed', name: 'Embed', first: 54, widget: 'LT_State_A4A_WelcomeApp' }];

function hostName(mode, depth) {
    return `ST_OnlineApps_Store${HOST_MODES.find((h) => h.mode === mode).name}${depth}`;
}

function proxyName(mode, depth, i) {
    return `store${HOST_MODES.find((h) => h.mode === mode).name}${depth}P${i}`;
}

function hostStates(modes) {
    const out = [];
    HOST_MODES.forEach((h, mi) => {
        if (modes.indexOf(h.mode) < 0) {
            return;
        }
        PROXIES.forEach((n, d) => {
            const id = h.first + d;
            const comps = [];
            for (let i = 0; i < n; i++) {
                comps.push(button(1000 + (mi * 3 + d) * 100 + i, proxyName(h.mode, d + 1, i), ''));
            }
            const s = state(id, hostName(h.mode, d + 1), 61 + mi * 3 + d, 'Store', d ? id - 1 : null, comps);
            s.title = { value: 'SID_STORE_TITLE', type: 'StringId' };
            s.widget = h.widget;
            out.push(s);
        });
    });
    return out;
}

/* On iDrive 8 no state has a ParentState: Hmi8 refuses a description
 * (initialize: INVALID_PARAMETER) with a parent that has a parent of its
 * own, and its BACK closes a state's parent with it. Its history takes the
 * Store's states back one at a time. */
function statesFor(hmi) {
    let states = WIDGET_STATES.concat(hostStates(hmi === 'ID7' ? ['layer', 'embed'] : ['layer']));
    if (hmi === 'ID8') {
        states = states.map((s) => Object.assign({}, s, { parent: null }));
        states[0] = Object.assign({}, states[0], { components: states[0].components.concat([
            Object.assign(label(70, 'storeHmiID8'), { visible: 0 })]) });
    }
    return states;
}

/* The widget, type and cells of component c on hmi. */
function widgetOf(hmi, c) {
    return WIDGETS[hmi][c.kind](c);
}

function xml(hmi) {
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>'];
    statesFor(hmi).forEach((s) => {
        lines.push(`    <container id="${s.id}" type="state" widget="${s.widget || WIDGETS[hmi].state}">`);
        if (s.parent) {
            lines.push(`        <property id="9" value="${s.parent}"/>`);
        }
        lines.push(`        <layoutGroup id="${100 + 2 * s.id}" name="Titlebar">`,
            `            <component id="${s.titleId}" type="title">`,
            '                <property id="2" value="1"/>',
            '            </component>',
            '        </layoutGroup>',
            `        <layoutGroup id="${101 + 2 * s.id}" name="List">`,
            '            <property id="3" value="1"/>');
        s.components.forEach((c) => {
            const w = widgetOf(hmi, c);
            lines.push(`            <component id="${c.id}" type="${w.type}"${w.widget ? ` widget="${w.widget}"` : ''}>`,
                `                <property id="2" value="${c.visible === 0 ? 0 : 1}"/>`,
                `                <property id="3" value="${c.focusable}"/>`,
                '            </component>');
        });
        lines.push('        </layoutGroup>', '    </container>');
    });
    lines.push('</application>', '');
    return lines.join('\n');
}

function uiDescription(hmi) {
    const containers = {};
    statesFor(hmi).forEach((s) => {
        const components = {
            [s.titleId]: {
                type: 'title',
                name: `${s.name}_Title`,
                properties: { Visible: { value: 1, type: 'UInt' } },
                rows: [{ Text: s.title }]
            }
        };
        s.components.forEach((c) => {
            const w = widgetOf(hmi, c);
            const cells = {};
            Object.keys(w.cells).forEach((k) => {
                const v = w.cells[k];
                cells[k] = { value: v, type: typeof v === 'boolean' ? 'Bool' : 'Text' };
            });
            components[c.id] = {
                type: w.type,
                name: c.name,
                properties: { Visible: { value: c.visible === 0 ? 0 : 1, type: 'UInt' }, Focusable: { value: c.focusable, type: 'UInt' } },
                rows: [cells]
            };
        });
        containers[s.id] = Object.assign({ type: 'state', name: s.name },
            s.parent ? { properties: { ParentState: { value: s.parent, type: 'UInt' } } } : {},
            { components });
    });
    return { schemaVersion: '1.3.0', containers };
}

function write() {
    ['ID7', 'ID8'].forEach((hmi) => {
        fs.mkdirSync(DIR(hmi), { recursive: true });
        fs.writeFileSync(path.join(DIR(hmi), 'application.xml'), xml(hmi));
        fs.writeFileSync(path.join(DIR(hmi), 'uiDescription.json'), JSON.stringify(uiDescription(hmi), null, 2) + '\n');
    });
}

if (require.main === module) {
    write();
    ['ID7', 'ID8'].forEach((hmi) => {
        const states = statesFor(hmi);
        const count = states.reduce((n, s) => n + s.components.length, 0);
        console.log(`wrote ${path.relative(process.cwd(), DIR(hmi))}/{application.xml,uiDescription.json}: ` +
            `${states.length} states, ${count} components`);
    });
}

module.exports = { write, statesFor, widgetOf, hostName, proxyName, PROXIES, ID7, ID8 };
