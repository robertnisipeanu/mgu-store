'use strict';
/**
 * Offline check of the RHMI files tools/gen_rhmi.js writes, for iDrive 7
 * and iDrive 8: application.xml and uiDescription.json name the same
 * containers and components with the same types, widgets' cells and
 * Focusable, ids are unique across containers, layout groups and
 * components, every ParentState chain ends at an entry state (the widget
 * screens' or a drawn screens' depth 1), each component has one row, the
 * host states have their proxies, and every state and component name
 * src/store.js binds exists. Node 8+.
 *
 *   node tools/gen_rhmi.js && node tools/test_rhmi.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ID7, ID8, hostName, proxyName, PROXIES } = require('./gen_rhmi.js');

let checks = 0;
const ok = (cond, msg) => { checks += 1; assert(cond, msg); };

const CELLS = {
    ID7: { LT_Label_1Row: 'Text', LT_Button_1Row: 'Text', LT_Button_1Row_2Col7030_2Text: 'Text1stCol,Text2ndCol' },
    ID8: { LT_ScrollLabel: 'Text',
        LT_Button_MediaEntry_1Row: 'PrimaryText,FrequencyText,FrequencyVisible,IconVisible,ProgressVisible,IsPlaying' }
};
const STATE_WIDGETS = { ID7: ['LT_State_Wide', 'LT_State_A4A_WelcomeApp'], ID8: ['LT_State_Wide_List'] };
const MODES = { ID7: ['layer', 'embed'], ID8: ['layer'] };
const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');
const bound = store.match(/'(ST_OnlineApps_\w+|store[A-Z]\w*)'/g).map((s) => s.slice(1, -1));

function checkHmi(hmi, dir) {
    const xml = fs.readFileSync(path.join(dir, 'application.xml'), 'utf8');
    const ui = JSON.parse(fs.readFileSync(path.join(dir, 'uiDescription.json'), 'utf8'));
    const ids = [];
    const xmlContainers = {};
    xml.split('<container ').slice(1).forEach((block) => {
        const id = /^id="(\d+)"/.exec(block)[1];
        const widget = /type="state" widget="(\w+)"/.exec(block);
        ok(widget && STATE_WIDGETS[hmi].indexOf(widget[1]) >= 0, `${hmi} container ${id} is a state of ${STATE_WIDGETS[hmi]}`);
        ids.push(id);
        const parent = /<property id="9" value="(\d+)"\/>\s*<layoutGroup/.exec(block);
        const groups = [];
        const re = /<layoutGroup id="(\d+)" name="(\w+)">/g;
        let m;
        while ((m = re.exec(block)) !== null) {
            ids.push(m[1]);
            groups.push(m[2]);
        }
        ok(groups.join(',') === 'Titlebar,List', `${hmi} container ${id} has Titlebar and List`);
        const components = {};
        const cre = /<component id="(\d+)" type="(\w+)"(?: widget="(\w+)")?>([\s\S]*?)<\/component>/g;
        while ((m = cre.exec(block)) !== null) {
            ids.push(m[1]);
            const focus = /<property id="3" value="(\d+)"\/>/.exec(m[4]);
            const visible = /<property id="2" value="(\d+)"\/>/.exec(m[4]);
            components[m[1]] = { type: m[2], widget: m[3], focusable: focus ? Number(focus[1]) : null,
                visible: visible ? Number(visible[1]) : null };
        }
        xmlContainers[id] = { parent: parent ? parent[1] : null, components };
    });
    ok(new Set(ids).size === ids.length, `${hmi} ids are unique`);
    ok(xml.indexOf('<property id="18"') < 0 && xml.indexOf('<property id="15"') < 0, `${hmi} no state focus properties`);

    ok(ui.schemaVersion === '1.3.0', 'schemaVersion 1.3.0');
    ok(Object.keys(ui.containers).join() === Object.keys(xmlContainers).join(), `${hmi} the same containers`);
    const names = new Set();
    const byName = {};
    Object.keys(ui.containers).forEach((id) => { byName[ui.containers[id].name] = id; });
    const roots = ['ST_OnlineApps_Store'].concat(MODES[hmi].map((m) => hostName(m, 1))).map((n) => byName[n]);
    Object.keys(ui.containers).forEach((id) => {
        const c = ui.containers[id];
        const x = xmlContainers[id];
        ok(!names.has(c.name), `state name ${c.name} unique`);
        names.add(c.name);
        const parent = c.properties && c.properties.ParentState ? String(c.properties.ParentState.value) : null;
        ok(parent === x.parent, `${c.name} ParentState matches the XML`);
        let at = id;
        for (let hops = 0; xmlContainers[at].parent; hops += 1) {
            ok(hops < 10 && xmlContainers[xmlContainers[at].parent], `${c.name} ParentState chain`);
            at = xmlContainers[at].parent;
        }
        ok(roots.indexOf(at) >= 0, `${hmi} ${c.name} chains to an entry state`);
        ok(Object.keys(c.components).sort().join() === Object.keys(x.components).sort().join(),
            `${c.name} has the same components`);
        Object.keys(c.components).forEach((cid) => {
            const comp = c.components[cid];
            const xc = x.components[cid];
            ok(comp.type === xc.type, `${comp.name} type matches the XML`);
            ok(!names.has(comp.name), `component name ${comp.name} unique`);
            names.add(comp.name);
            ok(comp.properties.Visible.value === (comp.name === 'storeHmiID8' ? 0 : 1), `${comp.name} Visible`);
            if (comp.type !== 'title') {
                ok(xc.visible === comp.properties.Visible.value, `${comp.name} Visible matches the XML`);
                ok(comp.properties.Focusable.value === xc.focusable, `${comp.name} Focusable matches the XML`);
                ok(comp.rows.length === 1, `${comp.name} has one row`);
            }
            if (CELLS[hmi][xc.widget]) {
                ok(Object.keys(comp.rows[0]).join() === CELLS[hmi][xc.widget], `${hmi} ${comp.name} has the cells of ${xc.widget}`);
            }
        });
    });
    // the drawn screens' host states and their proxies
    MODES[hmi].forEach((mode) => PROXIES.forEach((n, d) => {
        ok(names.has(hostName(mode, d + 1)), `${hmi} has ${hostName(mode, d + 1)}`);
        for (let i = 0; i < n; i++) {
            ok(names.has(proxyName(mode, d + 1, i)), `${hmi} has ${proxyName(mode, d + 1, i)}`);
        }
        ok(!names.has(proxyName(mode, d + 1, n)), `${hmi} ${hostName(mode, d + 1)} has ${n} proxies`);
    }));
    ok(names.has('storeHmiID8') === (hmi === 'ID8'), `${hmi}: storeHmiID8 only on iDrive 8`);
    ok(names.has(hostName('embed', 1)) === (hmi === 'ID7'), `${hmi}: the embed host states only on iDrive 7`);
    bound.filter((n) => n !== 'storeHmiID8').forEach((name) => ok(names.has(name), `${name} (src/store.js) is in ${hmi}'s uiDescription.json`));
    return Object.keys(xmlContainers).length;
}

const counts = [checkHmi('ID7', ID7), checkHmi('ID8', ID8)];
const app = JSON.parse(fs.readFileSync(path.join(ID7, '..', '..', 'application.json'), 'utf8')).application;
ok(app.uiDescriptions.map((u) => u.hmi.join()).join() === 'ID7,ID8', 'application.json names both descriptions');
const pkg = JSON.parse(fs.readFileSync(path.join(ID7, '..', '..', '..', 'package.json'), 'utf8'));
ok(JSON.stringify(pkg.mguHmi) === '["ID7","ID8"]', 'package.json: mguHmi ID7 and ID8');
console.log(`rhmi: ${counts[0]} states (iDrive 7), ${counts[1]} (iDrive 8), ${checks} checks pass`);
