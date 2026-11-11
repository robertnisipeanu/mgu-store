'use strict';
/**
 * Offline check of where a tilt of the controller moves the focus
 * (src/store_frame.js toward): along a row and down a column of the app
 * grid, between the side menu and the grid at the nearest height, along the
 * tabs and the side menu, to a list row's button and into rows scrolled out
 * of view, to an item in line however far off centre; null when nothing is
 * that way. Node 8+.
 *
 *   node tools/test_tilt.js
 */
const assert = require('assert');
const path = require('path');
const { toward } = require(path.join(__dirname, '..', 'src', 'store_frame.js'));

// the Store tab: the side menu, the filter tabs and a grid of 5 x 3 tiles
const items = [];
['Store', 'Installed', 'USB', 'Settings'].forEach((label, k) => items.push({ label, x: 18, y: 10 + k * 150, w: 140, h: 134 }));
['All', 'Apps', 'Tools'].forEach((label, k) => items.push({ label, x: 1150 + k * 140, y: 10, w: 136, h: 56 }));
for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 5; c++) {
        items.push({ label: `t${r}${c}`, x: 180 + c * 322, y: 80 + r * 176, w: 306, h: 168 });
    }
}
const go = (list, label, dir) => {
    const k = toward(list, list.findIndex((i) => i.label === label), dir);
    return k === null ? null : list[k].label;
};
assert.deepStrictEqual([go(items, 't00', 'E'), go(items, 't01', 'W')], ['t01', 't00'], 'along a row');
assert.deepStrictEqual([go(items, 't00', 'S'), go(items, 't10', 'S'), go(items, 't20', 'N')], ['t10', 't20', 't10'], 'down and up a column');
assert.deepStrictEqual([go(items, 't13', 'S'), go(items, 't24', 'E')], ['t23', null], 'the column kept; nothing right of the last tile');
assert.deepStrictEqual([go(items, 't00', 'W'), go(items, 't10', 'W')], ['Installed', 'USB'], 'left of the grid: the side menu at the nearest height');
assert.deepStrictEqual([go(items, 'Installed', 'E'), go(items, 'Settings', 'E')], ['t00', 't20'], 'right of the side menu: the grid at the nearest height');
assert.deepStrictEqual([go(items, 'Store', 'S'), go(items, 'Settings', 'N'), go(items, 'Store', 'W')], ['Installed', 'USB', null], 'the side menu');
assert.deepStrictEqual([go(items, 'All', 'E'), go(items, 'Tools', 'W'), go(items, 't04', 'N')], ['Apps', 'Apps', 'Tools'], 'the tabs, and up to them');
assert.deepStrictEqual([go(items, 't00', 'N'), go(items, 'Store', 'N'), go(items, 'Tools', 'E')], [null, null, null], 'nothing more off to the side than ahead');

// a short last row and a wide item below narrow ones: in line counts however far the centres are apart
const short = items.filter((i) => !/^t2[2-4]$/.test(i.label)).concat([{ label: 'wide', x: 180, y: 620, w: 1610, h: 80 }]);
assert.deepStrictEqual([go(short, 't14', 'S'), go(short, 't21', 'S'), go(short, 'wide', 'N')], ['wide', 'wide', 't21'], 'in line: the nearest row first');

// Installed: rows with a button, the first two scrolled out of view
const rows = [];
for (let r = 0; r < 4; r++) {
    rows.push({ label: `row${r}`, x: 180, y: r * 120 - 160, w: 1400, h: 104 });
    rows.push({ label: `chip${r}`, x: 1400, y: r * 120 - 144, w: 160, h: 72 });
}
assert.deepStrictEqual([go(rows, 'row2', 'E'), go(rows, 'row2', 'S'), go(rows, 'chip2', 'S')], ['chip2', 'row3', 'chip3'], 'a row\'s button, the next row');
assert.deepStrictEqual([go(rows, 'row2', 'N'), go(rows, 'row1', 'N')], ['row1', 'row0'], 'up into rows out of view');
console.log('test_tilt: ok');
