'use strict';
/**
 * Offline check of the RHMI files tools/gen_rhmi.js writes: application.xml
 * and uiDescription.json name the same containers and components with the
 * same types and Focusable, ids are unique across containers, layout groups
 * and components, every ParentState chain ends at the entry state, one-row
 * widgets have one row, and every state and component name src/store.js
 * binds exists. Node 8+.
 *
 *   node tools/gen_rhmi.js && node tools/test_rhmi.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ID7 } = require('./gen_rhmi.js');

const xml = fs.readFileSync(path.join(ID7, 'application.xml'), 'utf8');
const ui = JSON.parse(fs.readFileSync(path.join(ID7, 'uiDescription.json'), 'utf8'));
let checks = 0;
const ok = (cond, msg) => { checks += 1; assert(cond, msg); };

/* application.xml: containers, their layout groups and components, by id. */
const ids = [];
const xmlContainers = {};
xml.split('<container ').slice(1).forEach((block) => {
    const id = /^id="(\d+)"/.exec(block)[1];
    ok(/type="state" widget="LT_State_Wide"/.test(block), `container ${id} is an LT_State_Wide state`);
    ids.push(id);
    const parent = /<property id="9" value="(\d+)"\/>\s*<layoutGroup/.exec(block);
    const groups = [];
    const re = /<layoutGroup id="(\d+)" name="(\w+)">/g;
    let m;
    while ((m = re.exec(block)) !== null) {
        ids.push(m[1]);
        groups.push(m[2]);
    }
    ok(groups.join(',') === 'Titlebar,List', `container ${id} has Titlebar and List`);
    const components = {};
    const cre = /<component id="(\d+)" type="(\w+)"(?: widget="(\w+)")?>([\s\S]*?)<\/component>/g;
    while ((m = cre.exec(block)) !== null) {
        ids.push(m[1]);
        const focus = /<property id="3" value="(\d+)"\/>/.exec(m[4]);
        components[m[1]] = { type: m[2], widget: m[3], focusable: focus ? Number(focus[1]) : null };
    }
    xmlContainers[id] = { parent: parent ? parent[1] : null, components };
});
ok(new Set(ids).size === ids.length, `ids are unique: ${ids.join(' ')}`);
ok(xml.indexOf('<property id="18"') < 0 && xml.indexOf('<property id="15"') < 0, 'no state focus properties');

/* uiDescription.json in lockstep. */
ok(ui.schemaVersion === '1.3.0', 'schemaVersion 1.3.0');
ok(Object.keys(ui.containers).join() === Object.keys(xmlContainers).join(), 'the same containers');
const names = new Set();
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
    ok(at === '1', `${c.name} chains to the entry state`);
    ok(Object.keys(c.components).sort().join() === Object.keys(x.components).sort().join(),
        `${c.name} has the same components`);
    Object.keys(c.components).forEach((cid) => {
        const comp = c.components[cid];
        const xc = x.components[cid];
        ok(comp.type === xc.type, `${comp.name} type matches the XML`);
        ok(!names.has(comp.name), `component name ${comp.name} unique`);
        names.add(comp.name);
        ok(comp.properties.Visible.value === 1, `${comp.name} Visible`);
        if (comp.type !== 'title') {
            ok(comp.properties.Focusable.value === xc.focusable, `${comp.name} Focusable matches the XML`);
            ok(comp.rows.length === 1, `${comp.name} has one row`);
        }
        if (xc.widget === 'LT_Label_1Row' || xc.widget === 'LT_Button_1Row') {
            ok(Object.keys(comp.rows[0]).join() === 'Text', `${comp.name} has the one cell Text`);
        }
        if (xc.widget === 'LT_Button_1Row_2Col7030_2Text') {
            ok(Object.keys(comp.rows[0]).join() === 'Text1stCol,Text2ndCol', `${comp.name} has two columns`);
        }
    });
});

/* Every name src/store.js binds. */
const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');
const bound = store.match(/'(ST_OnlineApps_\w+|store[A-Z]\w*)'/g).map((s) => s.slice(1, -1));
bound.forEach((name) => ok(names.has(name), `${name} (src/store.js) is in uiDescription.json`));

console.log(`rhmi: ${Object.keys(xmlContainers).length} states, ${checks} checks pass`);
