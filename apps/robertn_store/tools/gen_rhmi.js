'use strict';
/**
 * Writes robertn_store@0.4.0's application.xml and uiDescription.json from
 * the tables below, so container and component ids, names, widgets and cells
 * stay in lockstep. LT_State_Wide states, as in the reference apps:
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
 *   5  ST_OnlineApps_StoreSources      one list, a row (name | status) per
 *                                      source, and Add source
 *   6  ST_OnlineApps_StoreSource       one source: its name and status, Channel,
 *                                      Account, Components, its error, Sign in
 *                                      with GitHub, Remove
 *   7  ST_OnlineApps_StoreLogin        GitHub sign-in: the QR code of the
 *                                      sign-in page with the code beside it,
 *                                      the code and page as text, the status,
 *                                      Cancel
 *   8  ST_OnlineApps_StoreSourceRemove the confirm step of a source's Remove
 *   9  ST_OnlineApps_StoreRemove       the confirm step of a component's Remove:
 *                                      its name, Cancel, Remove
 *  30  ST_OnlineApps_StorePhone        Phone access: On/Off, the page's QR code,
 *                                      its address, its error
 *
 * A list is one LT_Button_1Row_2Col7030_2Text component; the app sets its
 * row count at runtime. The HMI opens a state only along its ParentState (9)
 * chain to the entry state. Ids share one space across containers, layout
 * groups (100 + 2 * state id, + 1) and components; tools/test_rhmi.js checks
 * the generated files.
 *
 *   node tools/gen_rhmi.js
 */
const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..', 'robertn_store@0.4.0');
const ID7 = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID7');
const ROW = 'LT_Button_1Row_2Col7030_2Text';
const TWO_COLS = [{ Text1stCol: '', Text2ndCol: '' }];

const button = (id, name, text) => ({ id, type: 'button', widget: 'LT_Button_1Row', name, focusable: 3,
    rows: [{ Text: text }] });
const row = (id, name, text) => ({ id, type: 'button', widget: ROW, name, focusable: 3,
    rows: [{ Text1stCol: text, Text2ndCol: '' }] });
const label = (id, name) => ({ id, type: 'label', widget: 'LT_Label_1Row', name, focusable: 0, rows: [{ Text: '' }] });
const picture = (id, name) => ({ id, type: 'label', widget: 'LT_Label_1Graphic_Scalable', name, focusable: 0,
    rows: [{}] });

const MAIN = {
    id: 1, name: 'ST_OnlineApps_Store', titleId: 10, title: { value: 'SID_STORE_TITLE', type: 'StringId' },
    components: [
        { id: 20, type: 'label', widget: 'LT_Label_1Row', name: 'storeStatus', focusable: 0, rows: [{ Text: 'Store' }] },
        button(21, 'storeCheck', 'Check for updates'),
        { id: 22, type: 'progressBar', widget: 'LT_Progressbar_Ent_ProgressBig', name: 'storeProgress', focusable: 0,
            rows: [{ TextLeft: '', TextRight: '' }] },
        row(23, 'storeNavApps', 'Apps'),
        row(24, 'storeNavTools', 'Head-unit tools'),
        row(26, 'storeNavSources', 'Sources'),
        row(27, 'storeNavPhone', 'Phone access'),
        button(25, 'storeRestart', 'Restart head unit')
    ]
};

function state(id, name, titleId, title, parent, components) {
    return { id, name, titleId, title: { value: title, type: 'Text' }, parent, components };
}

function list(id, name, titleId, title, listName, listId) {
    return state(id, name, titleId, title, MAIN.id,
        [{ id: listId, type: 'button', widget: ROW, name: listName, focusable: 3, rows: TWO_COLS }]);
}

const SOURCES = state(5, 'ST_OnlineApps_StoreSources', 14, 'Sources', MAIN.id, [
    { id: 82, type: 'button', widget: ROW, name: 'storeSourceList', focusable: 3, rows: TWO_COLS },
    button(83, 'storeSourceAdd', 'Add source')
]);

const SOURCE = state(6, 'ST_OnlineApps_StoreSource', 15, 'Source', SOURCES.id, [
    row(84, 'storeSrcStatus', 'Source'),
    row(28, 'storeSrcChannel', 'Channel'),
    row(85, 'storeSrcAccount', 'Account'),
    row(86, 'storeSrcComponents', 'Components'),
    label(89, 'storeSrcError'),
    button(87, 'storeSrcSignIn', 'Sign in with GitHub'),
    button(88, 'storeSrcRemove', 'Remove')
]);

const STATES = [
    MAIN,
    list(2, 'ST_OnlineApps_StoreApps', 11, 'Apps', 'storeAppList', 40),
    list(3, 'ST_OnlineApps_StoreTools', 12, 'Head-unit tools', 'storeToolList', 60),
    state(4, 'ST_OnlineApps_StoreRestart', 13, 'Restart head unit?', MAIN.id, [
        button(80, 'storeRestartCancel', 'Cancel'),
        button(81, 'storeRestartConfirm', 'Restart')
    ]),
    SOURCES,
    SOURCE,
    state(7, 'ST_OnlineApps_StoreLogin', 16, 'Sign in with GitHub', SOURCE.id, [
        picture(90, 'storeLoginQr'),
        label(94, 'storeLoginCode'),
        label(91, 'storeLoginUrl'),
        label(92, 'storeLoginStatus'),
        button(93, 'storeLoginCancel', 'Cancel')
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

function xml() {
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>'];
    STATES.forEach((s) => {
        lines.push(`    <container id="${s.id}" type="state" widget="LT_State_Wide">`);
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
            lines.push(`            <component id="${c.id}" type="${c.type}" widget="${c.widget}">`,
                '                <property id="2" value="1"/>',
                `                <property id="3" value="${c.focusable}"/>`,
                '            </component>');
        });
        lines.push('        </layoutGroup>', '    </container>');
    });
    lines.push('</application>', '');
    return lines.join('\n');
}

function uiDescription() {
    const containers = {};
    STATES.forEach((s) => {
        const components = {
            [s.titleId]: {
                type: 'title',
                name: `${s.name}_Title`,
                properties: { Visible: { value: 1, type: 'UInt' } },
                rows: [{ Text: s.title }]
            }
        };
        s.components.forEach((c) => {
            components[c.id] = {
                type: c.type,
                name: c.name,
                properties: { Visible: { value: 1, type: 'UInt' }, Focusable: { value: c.focusable, type: 'UInt' } },
                rows: c.rows.map((r) => {
                    const cells = {};
                    Object.keys(r).forEach((k) => { cells[k] = { value: r[k], type: 'Text' }; });
                    return cells;
                })
            };
        });
        containers[s.id] = Object.assign({ type: 'state', name: s.name },
            s.parent ? { properties: { ParentState: { value: s.parent, type: 'UInt' } } } : {},
            { components });
    });
    return { schemaVersion: '1.3.0', containers };
}

function write() {
    fs.writeFileSync(path.join(ID7, 'application.xml'), xml());
    fs.writeFileSync(path.join(ID7, 'uiDescription.json'), JSON.stringify(uiDescription(), null, 2) + '\n');
}

if (require.main === module) {
    write();
    const count = STATES.reduce((n, s) => n + s.components.length, 0);
    console.log(`wrote ${path.relative(process.cwd(), ID7)}/{application.xml,uiDescription.json}: ` +
        `${STATES.length} states, ${count} components`);
}

module.exports = { write, STATES, ID7 };
