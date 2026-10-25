'use strict';
/**
 * Writes robertn_store@0.3.2's application.xml and uiDescription.json from
 * the tables below, so container and component ids, names, widgets and cells
 * stay in lockstep. Four LT_State_Wide states, as in the reference apps:
 *
 *   ST_OnlineApps_Store        the entry state: a status line, Check for
 *                              updates, the progress of the running install,
 *                              one row each for Apps and Head-unit tools,
 *                              and Restart head unit
 *   ST_OnlineApps_StoreApps    one list, a row (name | state) per app
 *   ST_OnlineApps_StoreTools   one list, a row per head-unit tool
 *   ST_OnlineApps_StoreRestart the confirm step of Restart head unit: Cancel
 *                              (focused first) and Restart
 *
 * A list is one LT_Button_1Row_2Col7030_2Text component; the app sets its
 * row count at runtime. The HMI opens a state only along its ParentState (9)
 * chain to the entry state, so the lists and the confirm step name the entry
 * state.
 *
 *   node tools/gen_rhmi.js
 */
const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..', 'robertn_store@0.3.2');
const ID7 = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID7');
const ROW = 'LT_Button_1Row_2Col7030_2Text';
const TWO_COLS = [{ Text1stCol: '', Text2ndCol: '' }];

const MAIN = {
    id: 1, name: 'ST_OnlineApps_Store', titleId: 10, title: { value: 'SID_STORE_TITLE', type: 'StringId' },
    components: [
        { id: 20, type: 'label', widget: 'LT_Label_1Row', name: 'storeStatus', focusable: 0, rows: [{ Text: 'Store' }] },
        { id: 21, type: 'button', widget: 'LT_Button_1Row', name: 'storeCheck', focusable: 3,
            rows: [{ Text: 'Check for updates' }] },
        { id: 22, type: 'progressBar', widget: 'LT_Progressbar_Ent_ProgressBig', name: 'storeProgress', focusable: 0,
            rows: [{ TextLeft: '', TextRight: '' }] },
        { id: 23, type: 'button', widget: ROW, name: 'storeNavApps', focusable: 3,
            rows: [{ Text1stCol: 'Apps', Text2ndCol: '' }] },
        { id: 24, type: 'button', widget: ROW, name: 'storeNavTools', focusable: 3,
            rows: [{ Text1stCol: 'Head-unit tools', Text2ndCol: '' }] },
        { id: 25, type: 'button', widget: 'LT_Button_1Row', name: 'storeRestart', focusable: 3,
            rows: [{ Text: 'Restart head unit' }] }
    ]
};

function list(id, name, titleId, title, listName, listId) {
    const components = [{ id: listId, type: 'button', widget: ROW, name: listName, focusable: 3, rows: TWO_COLS }];
    return { id, name, titleId, title: { value: title, type: 'Text' }, parent: MAIN.id, components };
}

const CONFIRM_RESTART = {
    id: 4, name: 'ST_OnlineApps_StoreRestart', titleId: 13, title: { value: 'Restart head unit?', type: 'Text' },
    parent: MAIN.id,
    components: [
        { id: 80, type: 'button', widget: 'LT_Button_1Row', name: 'storeRestartCancel', focusable: 3,
            rows: [{ Text: 'Cancel' }] },
        { id: 81, type: 'button', widget: 'LT_Button_1Row', name: 'storeRestartConfirm', focusable: 3,
            rows: [{ Text: 'Restart' }] }
    ]
};

const STATES = [
    MAIN,
    list(2, 'ST_OnlineApps_StoreApps', 11, 'Apps', 'storeAppList', 40),
    list(3, 'ST_OnlineApps_StoreTools', 12, 'Head-unit tools', 'storeToolList', 60),
    CONFIRM_RESTART
];

function xml() {
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>'];
    STATES.forEach((s) => {
        lines.push(`    <container id="${s.id}" type="state" widget="LT_State_Wide">`);
        if (s.parent) {
            lines.push(`        <property id="9" value="${s.parent}"/>`);
        }
        // layoutGroup ids share the id space of components and containers
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

module.exports = { write };
