'use strict';
// Renderer screens (mgu-renderd, the idrive7-apps GPU overlay): head-unit targets and the element types.
// Shared by the browser (window.GPU) and the server (require). Each element type is one kit drawing
// (kit/gauges.js template or a canvas primitive); fields are its options as the editor shows them.
(function (root) {
    // HMI geometry the renderer's surface sits over. ID8: measured on the emulator's centre screen
    // (2880 x 960); ID7: kit/runtime/display.js (measured on a G20's 1920 x 720 HMI).
    // app: the part the HMI's own menus (title strip, back arrow, bottom bar) leave free. ID8: the HMI's side menu
    // (x < 288, some screens) is app area - apps draw over it and take its touch (renderd --touch-area 0,76,2880,764).
    const TARGETS = {
        id8: { label: 'iDrive 8 (2880 × 960)', w: 2880, h: 960, app: { x: 0, y: 76, w: 2880, h: 764 }, guides: [
            { label: 'HMI title + status strip', x: 0, y: 0, w: 2880, h: 76 },
            { label: 'status icons', x: 2370, y: 0, w: 510, h: 76 },
            { label: 'climate bar (always on)', x: 0, y: 840, w: 2880, h: 120 },
        ] },
        id7: { label: 'iDrive 7 (1920 × 720)', w: 1920, h: 720, app: { x: 84, y: 76, w: 1836, h: 520 }, guides: [
            { label: 'HMI title + status strip', x: 0, y: 0, w: 1920, h: 76 },
            { label: 'status icons', x: 1340, y: 0, w: 580, h: 76 },
            { label: 'back arrow', x: 0, y: 76, w: 84, h: 520 },
            { label: 'app image area (standard layout)', x: 124, y: 82, w: 1600, h: 520 },
            { label: 'HMI button bar', x: 0, y: 596, w: 1920, h: 124 },
        ] },
    };

    // A design is laid out once, in iDrive 8 pixels. On another head unit everything is scaled by the same
    // factor (fit to its width, anchored top left): iDrive 7 shows it at 2/3, 1920 x 640 of its 1920 x 720.
    const DESIGN = { w: 2880, h: 960 };
    const viewScale = (id) => { const t = TARGETS[id] || TARGETS.id8; return Math.min(t.w / DESIGN.w, t.h / DESIGN.h); };
    // that head unit's app area in design pixels (screen bgArea 'app': the background fills only this)
    const appArea = (id) => {
        const a = (TARGETS[id] || TARGETS.id8).app, s = viewScale(id);
        return { x: a.x / s, y: a.y / s, w: a.w / s, h: a.h / s };
    };

    // kit themes (kit/themes.js ids) and the theme colour names an option can use
    const THEMES = [['m_tricolour', 'M Tricolour'], ['m_red', 'M Red'], ['ice', 'Ice White'], ['amber', 'Amber']];
    const COLORS = ['', 'accent', 'accent2', 'text', 'dim', 'ok', 'warn', 'crit', 'cold', 'oil', 'bar', 'track', 'panelTop', 'bg'];
    const FONTS = ['label', 'bold', 'num', 'light', 'gear'];

    // field: [key, label, kind, default, extra]; kinds: text, num, int, bool, color, select (extra = options), lines,
    // icon (an HMI icon from the renderer's icon atlas, widgets.js), image (a PNG kept in the project as a data URL;
    // drawn stretched over the element - renderer protocol 3)
    const F = (key, label, kind, def, extra) => ({ key, label, kind, def, extra });
    const range = (min, max, value, unit, dec) => [F('label', 'Label', 'text', ''), F('unit', 'Unit', 'text', unit || ''),
        F('min', 'Lowest', 'num', min), F('max', 'Highest', 'num', max), F('value', 'Preview value', 'num', value),
        F('decimals', 'Decimals', 'int', dec || 0)];
    const SIZE = F('size', 'Text size (0 = fit)', 'int', 0);

    const ELEMENTS = {
        radial: { label: 'Dial', icon: '◔', box: [600, 600], round: true, fields: [...range(0, 8000, 3500, 'rpm'),
            F('ticks', 'Tick marks', 'int', 8), F('majorEvery', 'Number every n ticks', 'int', 1), F('tickDiv', 'Divide numbers by', 'num', 1000),
            F('redFrom', 'Red zone from', 'num', 6500), F('color', 'Arc colour', 'color', '')] },
        needle: { label: 'Needle dial', icon: '◷', box: [560, 560], round: true, fields: [...range(0, 300, 120, 'km/h'),
            F('ticks', 'Tick marks', 'int', 10), F('redFrom', 'Red from', 'num', 250)] },
        ring: { label: 'Ring', icon: '◯', box: [360, 360], round: true, fields: [...range(0, 100, 64, '%'),
            F('thick', 'Thickness', 'num', 22), F('color', 'Colour', 'color', '')] },
        bar: { label: 'Bar', icon: '▬', box: [900, 150], fields: [...range(0, 2.5, 1.1, 'bar', 2), F('color', 'Colour', 'color', '')] },
        segBar: { label: 'Segmented bar', icon: '▥', box: [1000, 190], fields: [...range(0, 8, 4.2, 'k rpm', 1),
            F('limit', 'Limit (red from)', 'num', 7), F('panel', 'On a panel', 'bool', true)] },
        stat: { label: 'Value card', icon: '▣', box: [480, 260], fields: [F('label', 'Label', 'text', 'Coolant'), F('value', 'Preview value', 'num', 88),
            F('unit', 'Unit', 'text', '°C'), F('decimals', 'Decimals', 'int', 0), F('sub', 'Small line', 'text', ''), F('size', 'Number size', 'int', 96),
            F('valueColor', 'Number colour', 'color', '')] },
        readout: { label: 'Big number', icon: '⑧', box: [420, 140], fields: [F('label', 'Label', 'text', 'Speed'), F('value', 'Preview value', 'num', 103),
            F('unit', 'Unit', 'text', 'km/h'), F('decimals', 'Decimals', 'int', 0), F('size', 'Size', 'int', 96),
            F('align', 'Align', 'select', 'left', ['left', 'center', 'right']), F('color', 'Colour', 'color', '')] },
        gear: { label: 'Gear', icon: 'D', box: [220, 240], fields: [F('gear', 'Gear (-1 R, 0 N)', 'int', 3),
            F('stage', 'Selector', 'select', '', ['', 'P', 'R', 'N', 'D']), F('color', 'Colour', 'color', '')] },
        shiftLights: { label: 'Shift lights', icon: '●', box: [1200, 60], fields: [F('n', 'Lights', 'int', 12), F('rpm', 'Preview rpm', 'num', 6200),
            F('shift', 'Shift at', 'num', 7000), F('range', 'Light up over (rpm)', 'num', 2000),
            F('style', 'Colours', 'select', 'gyr', ['gyr', 'f1', 'mono'])] },
        chart: { label: 'Line chart', icon: '📈', box: [1100, 420], fields: [F('yMin', 'Y lowest', 'num', 0), F('yMax', 'Y highest', 'num', 300),
            F('xMax', 'X highest', 'num', 10), F('yUnit', 'Y unit', 'text', 'kW'), F('xUnit', 'X unit', 'text', 's'),
            F('fill', 'Fill under the line', 'bool', true), F('color', 'Line colour', 'color', ''),
            F('target', 'Second line (target)', 'bool', false), F('legend', 'Legend (comma separated)', 'text', '')] },
        table: { label: 'Table', icon: '☷', box: [900, 260], fields: [F('columns', 'Columns (comma separated)', 'text', 'Sensor,Value,Unit'),
            F('rows', 'Rows (one per line, comma separated)', 'lines', 'Coolant,88,°C\nOil,96,°C\nIntake,34,°C'),
            F('size', 'Text size', 'int', 28), F('rowH', 'Row height', 'int', 48)] },
        tyres: { label: 'Tyres', icon: '⊞', box: [560, 520], fields: [F('label', 'Title', 'text', 'Tyres'), F('fl', 'Front left', 'num', 38),
            F('fr', 'Front right', 'num', 39), F('rl', 'Rear left', 'num', 41), F('rr', 'Rear right', 'num', 42), F('unit', 'Unit', 'text', '°C'),
            F('coldBelow', 'Cold below', 'num', 30), F('hotAbove', 'Hot above', 'num', 100)] },
        gmeter: { label: 'G-meter', icon: '⊕', box: [520, 520], round: true, fields: [F('max', 'Scale (g)', 'num', 1.5),
            F('lat', 'Preview lateral g', 'num', 0.6), F('long', 'Preview longitudinal g', 'num', -0.3)] },
        pill: { label: 'Badge', icon: '⬭', box: [180, 44], fields: [F('text', 'Text', 'text', 'DEMO'), F('color', 'Colour', 'color', 'warn'),
            F('size', 'Text size', 'int', 20)] },
        panel: { label: 'Panel', icon: '▭', box: [800, 400], fields: [F('title', 'Title', 'text', 'Engine')] },
        header: { label: 'App header + tabs', icon: '▔', box: [2880, 80], fields: [F('title', 'Title', 'text', 'M Vitals'),
            F('tabs', 'Tabs (comma separated)', 'text', 'Engine,Thermals,Chassis'), F('sel', 'Selected tab (0 = first)', 'int', 0)] },
        menuBar: { label: 'Button bar', icon: '▁', box: [2880, 48], fields: [F('buttons', 'Buttons (comma separated)', 'text', 'Next page,Previous page,Settings'),
            F('focus', 'iDrive focus on (-1 none)', 'int', -1), F('variant', 'Style', 'select', 'slim', ['slim', 'standard'])] },
        text: { label: 'Text', icon: 'T', box: [600, 80], fields: [F('text', 'Text', 'text', 'Hello'), F('size', 'Size', 'int', 48),
            F('font', 'Font', 'select', 'label', FONTS), F('align', 'Align', 'select', 'left', ['left', 'center', 'right']),
            F('color', 'Colour', 'color', 'text'), F('wrap', 'Wrap into the box (more lines, left aligned)', 'bool', false)] },
        rect: { label: 'Rectangle', icon: '■', box: [400, 200], fields: [F('color', 'Colour', 'color', 'panelTop'), F('radius', 'Corner radius', 'num', 16)] },
        line: { label: 'Line', icon: '╲', box: [400, 0], fields: [F('color', 'Colour', 'color', 'dim'), F('width', 'Width', 'num', 3)] },

        // app widgets (widgets.js)
        icon: { label: 'Icon', icon: '★', box: [120, 120], fields: [F('icon', 'Icon', 'icon', 'Settings'), F('color', 'Colour', 'color', 'text')] },
        image: { label: 'Picture', icon: '▨', box: [256, 256], fields: [F('src', 'Picture', 'image', ''), F('radius', 'Corner radius', 'num', 0)] },
        button: { label: 'Button', icon: '⏺', box: [560, 84], fields: [F('text', 'Text', 'text', 'Apply'), F('icon', 'Icon', 'icon', ''),
            F('style', 'Style', 'select', 'primary', ['primary', 'secondary', 'outline', 'ghost']), SIZE, F('radius', 'Corner radius', 'num', 16),
            F('color', 'Colour', 'color', '')] },
        roundButton: { label: 'Round button', icon: '◉', box: [120, 120], round: true, fields: [F('icon', 'Icon (none = arrow)', 'icon', 'Play'),
            F('style', 'Style', 'select', 'tinted', ['tinted', 'filled', 'ring', 'outline']), F('glow', 'Glow rings', 'bool', false), F('color', 'Colour', 'color', '')] },
        toggle: { label: 'Switch', icon: '⊶', box: [130, 72], fields: [F('on', 'On', 'bool', true), F('color', 'Colour', 'color', '')] },
        slider: { label: 'Slider', icon: '⊸', box: [800, 60], fields: [F('min', 'Lowest', 'num', 0), F('max', 'Highest', 'num', 100),
            F('value', 'Preview value', 'num', 40), F('unit', 'Unit', 'text', '%'), F('decimals', 'Decimals', 'int', 0),
            F('showValue', 'Show the value', 'bool', true), F('color', 'Colour', 'color', '')] },
        dropdown: { label: 'Drop-down', icon: '▾', box: [520, 84], fields: [F('text', 'Text', 'text', 'Comfort'), F('icon', 'Icon', 'icon', ''),
            F('open', 'Open (arrow up)', 'bool', false), SIZE] },
        tabs: { label: 'Tabs / chips', icon: '⊟', box: [1400, 84], fields: [F('items', 'Items (comma separated)', 'text', 'Comfort,Cluster,Lighting,Multimedia'),
            F('sel', 'Selected (0 = first)', 'int', 0), F('style', 'Style', 'select', 'joined', ['joined', 'chips', 'underline']), SIZE,
            F('color', 'Colour', 'color', '')] },
        field: { label: 'Text box', icon: '⌨', box: [700, 100], fields: [F('text', 'Text', 'text', 'Turn on the fog lights'),
            F('label', 'Small label (inside, top)', 'text', ''), F('caret', 'Typing cursor', 'bool', false), F('focus', 'Highlighted', 'bool', false),
            F('align', 'Align', 'select', 'left', ['left', 'center']), SIZE] },
        card: { label: 'Card', icon: '▢', box: [1000, 500], fields: [F('title', 'Title', 'text', 'Changes'), F('badge', 'Count badge', 'text', ''),
            F('link', 'Link text (right)', 'text', ''), F('selected', 'Highlighted', 'bool', false), F('radius', 'Corner radius', 'num', 20),
            F('size', 'Title size', 'int', 34), F('color', 'Highlight colour', 'color', '')] },
        tile: { label: 'Menu tile', icon: '▤', box: [616, 284], fields: [F('title', 'Title', 'text', 'Coding'), F('sub', 'Text', 'text', 'Personal settings'),
            F('icon', 'Icon', 'icon', 'Settings'), F('layout', 'Layout', 'select', 'side', ['side', 'stacked']), F('arrow', 'Arrow button', 'bool', true),
            F('selected', 'Highlighted', 'bool', false), SIZE, F('color', 'Colour', 'color', '')] },
        choice: { label: 'Choice card', icon: '◫', box: [590, 330], fields: [F('title', 'Title', 'text', '2WD'), F('sub', 'Text', 'text', 'Rear-wheel drive'),
            F('icon', 'Icon', 'icon', 'drivetrain'), F('selected', 'Selected', 'bool', true), SIZE, F('color', 'Colour', 'color', '')] },
        row: { label: 'Settings row', icon: '☰', box: [1700, 104], fields: [F('label', 'Text', 'text', 'Fold mirrors when locking'),
            F('sub', 'Small line', 'text', ''), F('subColor', 'Small line colour', 'color', ''), F('icon', 'Icon', 'icon', 'Doors'),
            F('control', 'Control (right)', 'select', 'toggle', ['none', 'toggle', 'dropdown', 'slider', 'value', 'chevron', 'button']),
            F('on', 'Switch on', 'bool', true), F('text', 'Drop-down / value / chevron text', 'text', ''), F('min', 'Slider lowest', 'num', 0),
            F('max', 'Slider highest', 'num', 100), F('value', 'Slider value', 'num', 70), F('unit', 'Slider unit', 'text', '°'),
            F('buttonIcon', 'Button icon', 'icon', 'Play'), F('boxed', 'On a card', 'bool', false), F('divider', 'Line below', 'bool', true), SIZE,
            F('color', 'Colour', 'color', '')] },
        list: { label: 'List', icon: '≣', box: [1400, 520], fields: [F('items', 'Rows, one per line: badge, title, small line', 'lines',
            '3, Engine electronics, 0x12 · 2 active\n1, Body domain controller, 0x40 · stored\n2, Dynamic stability control, 0x29 · 1 active'),
            F('sel', 'Selected row (-1 none)', 'int', -1), F('top', 'First row shown (scrolled)', 'int', 0), F('rowH', 'Row height', 'int', 104),
            F('chevron', 'Arrow on each row', 'bool', true), F('empty', 'Text when there are no rows', 'text', 'Nothing here'), SIZE,
            F('color', 'Colour', 'color', '')] },
        navRail: { label: 'Side menu', icon: '⋮', box: [240, 668], fields: [F('items', 'Items, one per line: Label, icon', 'lines',
            'Home, MainMenu\nGauges, AverageSpeed\nLighting, AmbientLight\nSettings, Settings'), F('sel', 'Selected (0 = first)', 'int', 0),
            F('direction', 'Direction', 'select', 'vertical', ['vertical', 'horizontal']), F('panel', 'Background', 'bool', true), SIZE,
            F('color', 'Colour', 'color', '')] },
        titleBar: { label: 'Title bar', icon: '▀', box: [2880, 96], fields: [F('title', 'Page title', 'text', 'Home'), F('right', 'Right text', 'text', ''),
            F('line', 'Line below', 'bool', true), F('size', 'Text size (0 = fit)', 'int', 0)] },
        metric: { label: 'Metric card', icon: '▦', box: [443, 230], fields: [F('label', 'Label', 'text', 'Oil temperature'), F('icon', 'Icon', 'icon', 'OilTemperature'),
            F('value', 'Preview value', 'num', 96), F('unit', 'Unit', 'text', '°C'), F('decimals', 'Decimals', 'int', 0), F('min', 'Bar lowest', 'num', 0),
            F('max', 'Bar highest', 'num', 150), F('bar', 'Bar', 'bool', true), F('size', 'Number size (0 = fit)', 'int', 0), F('color', 'Colour', 'color', '')] },
        progress: { label: 'Progress', icon: '▭', box: [900, 130], fields: [F('label', 'Label', 'text', 'Recording storage'), F('right', 'Right text', 'text', 'Free 82 GB'),
            F('sub', 'Small line', 'text', 'USB · 128 GB'), F('min', 'Lowest', 'num', 0), F('max', 'Highest', 'num', 100), F('value', 'Preview value', 'num', 36),
            F('percent', 'Show percent', 'bool', true), SIZE, F('color', 'Colour', 'color', '')] },
        swatches: { label: 'Colour swatches', icon: '◍', box: [700, 72], fields: [F('colors', 'Colours (comma separated)', 'text', '#ffffff,#f39c12,#2f6bff,#783cfe,#27ae60,#e1001a'),
            F('sel', 'Selected (-1 none)', 'int', 3), F('add', 'Plus button', 'bool', true)] },
        colorPicker: { label: 'Colour picker', icon: '◩', box: [820, 620], fields: [F('value', 'Colour (#rrggbb)', 'text', '#783cfe'), F('fields', 'R G B + hex boxes', 'bool', true)] },
        waveform: { label: 'Waveform', icon: '〰', box: [1240, 200], fields: [F('bars', 'Bars', 'int', 56), F('level', 'Loudness (0-1)', 'num', 0.8),
            F('gap', 'Gap in the middle (0-0.5)', 'num', 0.2), F('color', 'Colour', 'color', '')] },
        // the store's elements (store-widgets.js): renderer-drawn icons only - vector icons or pictures the app hands over
        appIcon: { label: 'App icon', icon: '▣', store: true, box: [300, 300], fields: [F('icon', 'Picture (key:name, from the app)', 'text', ''),
            F('vicon', 'Vector icon', 'vicon', 'gauge'), F('letter', 'Letter (no icon)', 'text', ''), F('kind', 'Kind', 'select', 'app', ['app', 'service']),
            F('colors', 'Colours (two, comma separated)', 'text', '#ff4b55,#a8101c'), F('badge', 'Badge', 'select', '', ['', 'installed', 'update', 'queued']),
            F('progress', 'Download progress (-1 none, 0-1)', 'num', -1)] },
        appGrid: { label: 'App grid', icon: '▦', store: true, box: [2380, 548], fields: [F('items', 'Tiles, one per line: title, small line, vector icon, colour', 'lines',
            'Car Data, Update 1.1.4, gauge, #ff4b55\nFault Codes, Installed, wrench, #ffc24d\nDrag Timer, 1.1.2 · 0.9 MB, stopwatch, #5fb4ff'),
            F('cols', 'Columns', 'int', 5), F('tileH', 'Tile height', 'int', 274), F('top', 'First row shown', 'int', 0), F('empty', 'Text when empty', 'text', 'No apps')] },
        appList: { label: 'App list', icon: '☰', store: true, box: [1280, 480], fields: [F('items', 'Rows, one per line: title, small line, right (chevron, trash, toggle:on, chip:Text; several: toggle:on+trash), vector icon', 'lines',
            'Car Data, 1.1.3 → 1.1.4, chip:Update, gauge\nFault Codes, 1.1.1, chevron, wrench'),
            F('rowH', 'Row height', 'int', 120), F('top', 'First row shown', 'int', 0), F('empty', 'Text when empty', 'text', 'Nothing here')] },
        chips: { label: 'Chips', icon: '⬭', store: true, box: [1200, 68], fields: [F('items', 'Chips: text|colour|dot; …', 'text', 'Version 1.1.4|text; 0.9 MB|text; App|#3d9bff'),
            F('align', 'Align', 'select', 'left', ['left', 'right'])] },
        sideNav: { label: 'Side menu (vector)', icon: '⋮', store: true, box: [300, 726], fields: [F('items', 'Items, one per line: Label, vector icon, badge', 'lines',
            'Store, grid\nInstalled, check, 2\nUSB, usb\nSettings, gear'), F('sel', 'Selected (0 = first)', 'int', 0)] },
        vbutton: { label: 'Button (vector icon)', icon: '⏺', store: true, box: [660, 120], fields: [F('text', 'Text', 'text', 'Install'), F('vicon', 'Vector icon', 'vicon', 'arrowDown'),
            F('style', 'Style', 'select', 'primary', ['primary', 'outline', 'tinted', 'round']), F('color', 'Colour', 'color', ''), F('disabled', 'Greyed out', 'bool', false), SIZE] },
        keyboard: { label: 'Keyboard', icon: '⌨', store: true, box: [2360, 518], fields: [F('shift', 'Capitals', 'bool', false)] },
        // the Store's own (src/store_elements.js)
        qr: { label: 'QR code', icon: '▦', store: true, box: [400, 400], fields: [F('text', 'Text', 'text', '')] },
        sheet: { label: 'Sheet (dims the screen)', icon: '▢', store: true, box: [1500, 520], fields: [F('dim', 'Dim (0-1)', 'num', 0.55), F('radius', 'Corner radius', 'num', 32)] },
    };
    // kit/vicons.js names (the editor's 'vicon' fields)
    const VICONS = ['grid', 'check', 'arrowDown', 'clock', 'back', 'chevron', 'plus', 'trash', 'lock', 'unlock', 'warning', 'gear', 'usb', 'refresh',
        'gauge', 'stopwatch', 'camera', 'phone', 'tether', 'display', 'route', 'wrench'];

    // reduce, not Object.fromEntries: this file also runs in apps on the car (Node 8)
    const defaults = (type) => ELEMENTS[type].fields.reduce((o, f) => { o[f.key] = f.def; return o; }, {});

    // ---- touch: the renderer's rules (mgu-renderd --touch), the same in the builder's Try mode and in the app ----
    // Element types with a behaviour of their own (server gpu.js / widgets.js TRY): what a touch does to them.
    const TOUCH = { toggle: 'a tap flips it', slider: 'dragging sets the value', tabs: 'a tap selects that tab',
        navRail: 'a tap selects that item', swatches: 'a tap selects that colour', dropdown: 'a tap opens / closes it',
        choice: 'a tap selects it (one choice card per screen)', tile: 'a tap highlights it (one tile per screen)',
        row: 'a tap flips its switch; its slider drags', header: 'a tap selects that tab', menuBar: 'a tap moves the focus there',
        list: 'dragging scrolls it; a tap selects that row (then its "when tapped")',
        appGrid: 'dragging scrolls it; a tap on a tile tells the app', appList: 'dragging scrolls it; a tap on a row or its control tells the app',
        sideNav: 'a tap selects that item and tells the app', keyboard: 'a tap types that key (the app fills its text box)' };
    Object.keys(TOUCH).forEach((k) => { ELEMENTS[k].touch = TOUCH[k]; });

    // onTap: what a tap (released on the element) does besides that
    const TAPS = [['', 'nothing more'], ['screen:', 'open screen…'], ['back', 'go back (the screen before)'],
        ['close', 'close the app (the HMI shows again)'], ['event:', 'app event… (the app code does it)']];
    function tapAction(s) {
        const m = /^(screen|event):(.+)$/.exec(s || '');
        if (m) return m[1] === 'screen' ? { open: m[2] } : { event: m[2] };
        return s === 'back' ? { back: true } : s === 'close' ? { close: true } : null;
    }

    const box = (c) => ({ x: c.x || 0, y: c.y || 0, w: c.w || 0, h: c.h || 0 });
    const inBox = (b, p) => p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;
    /** Takes touch: a behaviour of its own or an onTap, and not switched off (touch: false = display only). */
    const interactive = (c) => c.touch !== false && !(c.opts && c.opts.hidden) && !!((ELEMENTS[c.gpu] || {}).touch || c.onTap);

    /** The element a touch at p (design px) goes to: the top one that takes touch, or -1. */
    function elementAt(st, p) {
        const cs = st.components || [];
        for (let i = cs.length - 1; i >= 0; i--) if (interactive(cs[i]) && inBox(box(cs[i]), p)) return i;
        return -1;
    }

    /**
     * Where the screen takes touch from the HMI, design px. An opaque background hides the HMI there, so the whole
     * app area (a tap on the background must not reach the HMI's hidden list); see-through: the elements that take
     * touch. A touch anywhere else goes to the HMI - and closes the app (the user went back to the HMI).
     */
    function claims(st, view) {
        if (st.bg !== 'none') return [appArea(view)];
        return (st.components || []).filter(interactive).map(box);
    }
    const claimed = (st, view, p) => claims(st, view).some((b) => inBox(b, p));

    const api = { TARGETS, DESIGN, viewScale, appArea, THEMES, COLORS, FONTS, ELEMENTS, VICONS, defaults,
        TAPS, tapAction, box, inBox, interactive, elementAt, claims, claimed };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GPU = api;
})(this);
