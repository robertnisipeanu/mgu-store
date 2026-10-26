'use strict';
/**
 * The Store's renderer screens, in iDrive 8 design pixels (2880 x 960; the
 * Store scales them into iDrive 8's box, src/store_compact.js lays the same
 * screens out for iDrive 7's). store,
 * app, confirm (the sheet), installed, usb and settings are IterioDev's App
 * Manager 2 screens (mgu-app-store apps/oap-appmanager/renderer/screens.json
 * @ 4d5f508, the HMI UI builder's export of projects/app-manager.json) with the Store's labels; source, accounts, login and phone
 * are the Store's own in the same frame. Each element is drawn by
 * am_gpu.js; src/store_ui.js gives their values.
 */
module.exports = {
 "design": {
  "w": 2880,
  "h": 960
 },
 "screens": [
  {
   "name": "store",
   "kind": "gpu",
   "title": "App Manager",
   "theme": "m_tricolour",
   "bg": "theme",
   "bgArea": "app",
   "components": [
    {
     "name": "nav",
     "rtype": "gpu",
     "gpu": "sideNav",
     "x": 126,
     "y": 114,
     "w": 300,
     "h": 726,
     "opts": {
      "items": "",
      "sel": 0
     }
    },
    {
     "name": "title",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 138,
     "w": 1200,
     "h": 90,
     "opts": {
      "text": "Store",
      "size": 72,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "subtitle",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 227,
     "w": 1300,
     "h": 43,
     "opts": {
      "text": "",
      "size": 34,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "filter",
     "rtype": "gpu",
     "gpu": "tabs",
     "x": 1500,
     "y": 140,
     "w": 760,
     "h": 92,
     "opts": {
      "items": "All,Apps,Tools",
      "sel": 0,
      "style": "joined",
      "size": 34
     }
    },
    {
     "name": "online",
     "rtype": "gpu",
     "gpu": "chips",
     "x": 1980,
     "y": 146,
     "w": 860,
     "h": 84,
     "opts": {
      "items": "",
      "align": "right"
     }
    },
    {
     "name": "grid",
     "rtype": "gpu",
     "gpu": "appGrid",
     "x": 460,
     "y": 292,
     "w": 2380,
     "h": 548,
     "opts": {
      "items": "",
      "cols": 5,
      "tileH": 274,
      "empty": ""
     }
    }
   ],
   "entry": true
  },
  {
   "name": "app",
   "kind": "gpu",
   "title": "App Manager",
   "theme": "m_tricolour",
   "bg": "theme",
   "bgArea": "app",
   "components": [
    {
     "name": "nav",
     "rtype": "gpu",
     "gpu": "sideNav",
     "x": 126,
     "y": 114,
     "w": 300,
     "h": 726,
     "opts": {
      "items": "",
      "sel": 0
     }
    },
    {
     "name": "back",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 480,
     "y": 138,
     "w": 96,
     "h": 96,
     "opts": {
      "text": "",
      "vicon": "back",
      "style": "round",
      "color": "#f4f7fb"
     },
     "onTap": "event:back"
    },
    {
     "name": "icon",
     "rtype": "gpu",
     "gpu": "appIcon",
     "x": 630,
     "y": 150,
     "w": 300,
     "h": 300,
     "opts": {
      "vicon": "gauge",
      "colors": "#ff4b55,#a8101c",
      "badge": "update"
     }
    },
    {
     "name": "name",
     "rtype": "gpu",
     "gpu": "text",
     "x": 1000,
     "y": 161,
     "w": 1200,
     "h": 120,
     "opts": {
      "text": "",
      "size": 96,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "author",
     "rtype": "gpu",
     "gpu": "text",
     "x": 1004,
     "y": 272,
     "w": 1100,
     "h": 50,
     "opts": {
      "text": "",
      "size": 40,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "facts",
     "rtype": "gpu",
     "gpu": "chips",
     "x": 1000,
     "y": 352,
     "w": 1080,
     "h": 68,
     "opts": {
      "items": ""
     }
    },
    {
     "name": "desc",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 470,
     "w": 1560,
     "h": 340,
     "opts": {
      "text": "",
      "size": 40,
      "wrap": true,
      "color": "text"
     }
    },
    {
     "name": "panel",
     "rtype": "gpu",
     "gpu": "rect",
     "x": 2100,
     "y": 136,
     "w": 740,
     "h": 700,
     "opts": {
      "color": "panelTop",
      "radius": 28
     }
    },
    {
     "name": "instLabel",
     "rtype": "gpu",
     "gpu": "text",
     "x": 2140,
     "y": 187,
     "w": 340,
     "h": 43,
     "opts": {
      "text": "",
      "size": 34,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "instValue",
     "rtype": "gpu",
     "gpu": "text",
     "x": 2140,
     "y": 239,
     "w": 340,
     "h": 80,
     "opts": {
      "text": "",
      "size": 64,
      "font": "num",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "availLabel",
     "rtype": "gpu",
     "gpu": "text",
     "x": 2500,
     "y": 187,
     "w": 300,
     "h": 43,
     "opts": {
      "text": "",
      "size": 34,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "availValue",
     "rtype": "gpu",
     "gpu": "text",
     "x": 2500,
     "y": 239,
     "w": 300,
     "h": 80,
     "opts": {
      "text": "",
      "size": 64,
      "font": "num",
      "align": "left",
      "color": "#3d9bff"
     }
    },
    {
     "name": "note1",
     "rtype": "gpu",
     "gpu": "text",
     "x": 2140,
     "y": 364,
     "w": 660,
     "h": 40,
     "opts": {
      "text": "",
      "size": 32,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "note2",
     "rtype": "gpu",
     "gpu": "text",
     "x": 2140,
     "y": 410,
     "w": 660,
     "h": 40,
     "opts": {
      "text": "",
      "size": 32,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "note3",
     "rtype": "gpu",
     "gpu": "text",
     "x": 2140,
     "y": 474,
     "w": 660,
     "h": 40,
     "opts": {
      "text": "",
      "size": 32,
      "font": "label",
      "align": "left",
      "color": "#ffb020"
     }
    },
    {
     "name": "progress",
     "rtype": "gpu",
     "gpu": "progress",
     "x": 2140,
     "y": 560,
     "w": 660,
     "h": 124,
     "opts": {
      "label": "Downloading",
      "right": "42 %",
      "sub": "0.8 of 2.0 MB",
      "value": 42,
      "percent": false,
      "size": 34,
      "hidden": true
     }
    },
    {
     "name": "primary",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 2140,
     "y": 562,
     "w": 660,
     "h": 120,
     "opts": {
      "text": "",
      "vicon": "arrowDown",
      "style": "primary",
      "color": "#3d9bff"
     },
     "onTap": "event:primary"
    },
    {
     "name": "secondary",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 2140,
     "y": 702,
     "w": 660,
     "h": 106,
     "opts": {
      "text": "",
      "vicon": "trash",
      "style": "outline"
     },
     "onTap": "event:secondary"
    }
   ]
  },
  {
   "name": "confirm",
   "kind": "gpu",
   "title": "App Manager",
   "theme": "m_tricolour",
   "bg": "theme",
   "bgArea": "app",
   "components": [
    {
     "name": "nav",
     "rtype": "gpu",
     "gpu": "sideNav",
     "x": 126,
     "y": 114,
     "w": 300,
     "h": 726,
     "opts": {
      "items": "",
      "sel": 0
     }
    },
    {
     "name": "sheet",
     "rtype": "gpu",
     "gpu": "sheet",
     "x": 900,
     "y": 250,
     "w": 1500,
     "h": 520,
     "opts": {}
    },
    {
     "name": "icon",
     "rtype": "gpu",
     "gpu": "appIcon",
     "x": 960,
     "y": 310,
     "w": 150,
     "h": 150,
     "opts": {
      "vicon": "gauge",
      "colors": "#ff4b55,#a8101c"
     }
    },
    {
     "name": "title",
     "rtype": "gpu",
     "gpu": "text",
     "x": 1150,
     "y": 325,
     "w": 1200,
     "h": 70,
     "opts": {
      "text": "",
      "size": 56,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "text",
     "rtype": "gpu",
     "gpu": "text",
     "x": 1150,
     "y": 401,
     "w": 1200,
     "h": 45,
     "opts": {
      "text": "",
      "size": 36,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "now",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 960,
     "y": 560,
     "w": 680,
     "h": 130,
     "opts": {
      "text": "Restart now",
      "vicon": "refresh",
      "style": "primary",
      "color": "#3d9bff"
     },
     "onTap": "event:restartNow"
    },
    {
     "name": "later",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 1660,
     "y": 560,
     "w": 680,
     "h": 130,
     "opts": {
      "text": "At the next start",
      "vicon": "clock",
      "style": "outline"
     },
     "onTap": "event:later"
    },
    {
     "name": "note",
     "rtype": "gpu",
     "gpu": "text",
     "x": 960,
     "y": 716,
     "w": 1380,
     "h": 38,
     "opts": {
      "text": "",
      "size": 30,
      "font": "label",
      "align": "center",
      "color": "dim"
     }
    }
   ]
  },
  {
   "name": "installed",
   "kind": "gpu",
   "title": "App Manager",
   "theme": "m_tricolour",
   "bg": "theme",
   "bgArea": "app",
   "components": [
    {
     "name": "nav",
     "rtype": "gpu",
     "gpu": "sideNav",
     "x": 126,
     "y": 114,
     "w": 300,
     "h": 726,
     "opts": {
      "items": "",
      "sel": 1
     }
    },
    {
     "name": "title",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 138,
     "w": 1200,
     "h": 90,
     "opts": {
      "text": "Installed",
      "size": 72,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "subtitle",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 227,
     "w": 1300,
     "h": 43,
     "opts": {
      "text": "",
      "size": 34,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "updateAll",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 2300,
     "y": 140,
     "w": 540,
     "h": 100,
     "opts": {
      "text": "",
      "vicon": "arrowDown",
      "style": "primary",
      "color": "#3d9bff"
     },
     "onTap": "event:updateAll"
    },
    {
     "name": "appsLabel",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 292,
     "w": 400,
     "h": 38,
     "opts": {
      "text": "APPS",
      "size": 30,
      "font": "bold",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "apps",
     "rtype": "gpu",
     "gpu": "appList",
     "x": 480,
     "y": 336,
     "w": 1280,
     "h": 480,
     "opts": {
      "items": "",
      "rowH": 120,
      "empty": "No apps installed"
     }
    },
    {
     "name": "svcLabel",
     "rtype": "gpu",
     "gpu": "text",
     "x": 1840,
     "y": 292,
     "w": 600,
     "h": 38,
     "opts": {
      "text": "HEAD-UNIT TOOLS",
      "size": 30,
      "font": "bold",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "services",
     "rtype": "gpu",
     "gpu": "appList",
     "x": 1840,
     "y": 336,
     "w": 1000,
     "h": 480,
     "opts": {
      "items": "",
      "rowH": 150
     }
    }
   ]
  },
  {
   "name": "usb",
   "kind": "gpu",
   "title": "App Manager",
   "theme": "m_tricolour",
   "bg": "theme",
   "bgArea": "app",
   "components": [
    {
     "name": "nav",
     "rtype": "gpu",
     "gpu": "sideNav",
     "x": 126,
     "y": 114,
     "w": 300,
     "h": 726,
     "opts": {
      "items": "",
      "sel": 2
     }
    },
    {
     "name": "title",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 138,
     "w": 1200,
     "h": 90,
     "opts": {
      "text": "USB",
      "size": 72,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "subtitle",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 227,
     "w": 1300,
     "h": 43,
     "opts": {
      "text": "",
      "size": 34,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "grid",
     "rtype": "gpu",
     "gpu": "appGrid",
     "x": 460,
     "y": 292,
     "w": 2380,
     "h": 548,
     "opts": {
      "items": "",
      "cols": 5,
      "tileH": 274,
      "empty": ""
     }
    }
   ]
  },
  {
   "name": "settings",
   "kind": "gpu",
   "title": "App Manager",
   "theme": "m_tricolour",
   "bg": "theme",
   "bgArea": "app",
   "components": [
    {
     "name": "nav",
     "rtype": "gpu",
     "gpu": "sideNav",
     "x": 126,
     "y": 114,
     "w": 300,
     "h": 726,
     "opts": {
      "items": "",
      "sel": 3
     }
    },
    {
     "name": "title",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 138,
     "w": 1200,
     "h": 90,
     "opts": {
      "text": "Settings",
      "size": 72,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "reposLabel",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 292,
     "w": 600,
     "h": 38,
     "opts": {
      "text": "SOURCES",
      "size": 30,
      "font": "bold",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "repos",
     "rtype": "gpu",
     "gpu": "appList",
     "x": 480,
     "y": 336,
     "w": 1260,
     "h": 390,
     "opts": {
      "items": "",
      "rowH": 130
     }
    },
    {
     "name": "addRepo",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 480,
     "y": 736,
     "w": 1260,
     "h": 94,
     "opts": {
      "text": "Add source",
      "vicon": "plus",
      "style": "tinted",
      "color": "#3d9bff"
     },
     "onTap": "event:addRepo"
    },
    {
     "name": "connPanel",
     "rtype": "gpu",
     "gpu": "rect",
     "x": 1840,
     "y": 336,
     "w": 1000,
     "h": 494,
     "opts": {
      "color": "panelTop",
      "radius": 28
     }
    },
    {
     "name": "connLabel",
     "rtype": "gpu",
     "gpu": "text",
     "x": 1880,
     "y": 368,
     "w": 600,
     "h": 38,
     "opts": {
      "text": "ACCESS",
      "size": 30,
      "font": "bold",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "access",
     "rtype": "gpu",
     "gpu": "appList",
     "x": 1880,
     "y": 412,
     "w": 920,
     "h": 260,
     "opts": {
      "items": [],
      "rowH": 120
     }
    },
    {
     "name": "unit",
     "rtype": "gpu",
     "gpu": "text",
     "x": 1880,
     "y": 668,
     "w": 920,
     "h": 40,
     "opts": {
      "text": "",
      "size": 32,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "versions",
     "rtype": "gpu",
     "gpu": "text",
     "x": 1880,
     "y": 714,
     "w": 920,
     "h": 38,
     "opts": {
      "text": "",
      "size": 28,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "checkNow",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 1880,
     "y": 764,
     "w": 440,
     "h": 56,
     "opts": {
      "text": "Check now",
      "vicon": "refresh",
      "style": "outline",
      "size": 26
     },
     "onTap": "event:checkNow"
    },
    {
     "name": "restart",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 2340,
     "y": 764,
     "w": 460,
     "h": 56,
     "opts": {
      "text": "Restart head unit",
      "vicon": "refresh",
      "style": "outline",
      "size": 26
     },
     "onTap": "event:restart"
    },
    {
     "name": "note",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 227,
     "w": 1300,
     "h": 43,
     "opts": {
      "text": "",
      "size": 34,
      "font": "label",
      "align": "left",
      "color": "#ffb020"
     }
    }
   ]
  },
  {
   "kind": "gpu",
   "name": "source",
   "theme": "m_tricolour",
   "bg": "theme",
   "components": [
    {
     "name": "nav",
     "rtype": "gpu",
     "gpu": "sideNav",
     "x": 126,
     "y": 114,
     "w": 300,
     "h": 726,
     "opts": {
      "items": "Store, grid\nInstalled, check\nUSB, usb\nSettings, gear",
      "sel": 0
     }
    },
    {
     "name": "back",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 480,
     "y": 138,
     "w": 96,
     "h": 96,
     "opts": {
      "text": "",
      "vicon": "back",
      "style": "round",
      "color": "#f4f7fb"
     },
     "onTap": "event:back"
    },
    {
     "name": "icon",
     "rtype": "gpu",
     "gpu": "appIcon",
     "x": 630,
     "y": 150,
     "w": 220,
     "h": 220,
     "opts": {
      "vicon": "lock",
      "kind": "service",
      "colors": "#3a4352,#232a35"
     }
    },
    {
     "name": "name",
     "rtype": "gpu",
     "gpu": "text",
     "x": 900,
     "y": 161,
     "w": 1200,
     "h": 110,
     "opts": {
      "text": "",
      "size": 80,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "state",
     "rtype": "gpu",
     "gpu": "text",
     "x": 904,
     "y": 262,
     "w": 1100,
     "h": 50,
     "opts": {
      "text": "",
      "size": 40,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "facts",
     "rtype": "gpu",
     "gpu": "chips",
     "x": 900,
     "y": 340,
     "w": 1180,
     "h": 68,
     "opts": {
      "items": []
     }
    },
    {
     "name": "desc",
     "rtype": "gpu",
     "gpu": "text",
     "x": 480,
     "y": 470,
     "w": 1560,
     "h": 300,
     "opts": {
      "text": "",
      "size": 40,
      "font": "label",
      "align": "left",
      "color": "#ffb020",
      "wrap": true
     }
    },
    {
     "name": "panel",
     "rtype": "gpu",
     "gpu": "rect",
     "x": 2100,
     "y": 136,
     "w": 740,
     "h": 700,
     "opts": {
      "color": "panelTop",
      "radius": 28
     }
    },
    {
     "name": "appLabel",
     "rtype": "gpu",
     "gpu": "text",
     "x": 2140,
     "y": 180,
     "w": 660,
     "h": 48,
     "opts": {
      "text": "Install on GitHub",
      "size": 38,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "appQr",
     "rtype": "gpu",
     "gpu": "qr",
     "x": 2240,
     "y": 250,
     "w": 460,
     "h": 460,
     "opts": {
      "text": ""
     }
    },
    {
     "name": "appUrl",
     "rtype": "gpu",
     "gpu": "text",
     "x": 2140,
     "y": 730,
     "w": 660,
     "h": 36,
     "opts": {
      "text": "",
      "size": 26,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "remove",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 480,
     "y": 720,
     "w": 520,
     "h": 106,
     "opts": {
      "text": "Remove",
      "vicon": "trash",
      "style": "outline"
     },
     "onTap": "event:remove"
    }
   ]
  },
  {
   "kind": "gpu",
   "name": "accounts",
   "theme": "m_tricolour",
   "bg": "theme",
   "components": [
    {
     "name": "nav",
     "rtype": "gpu",
     "gpu": "sideNav",
     "x": 126,
     "y": 114,
     "w": 300,
     "h": 726,
     "opts": {
      "items": "Store, grid\nInstalled, check\nUSB, usb\nSettings, gear",
      "sel": 0
     }
    },
    {
     "name": "back",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 480,
     "y": 138,
     "w": 96,
     "h": 96,
     "opts": {
      "text": "",
      "vicon": "back",
      "style": "round",
      "color": "#f4f7fb"
     },
     "onTap": "event:back"
    },
    {
     "name": "title",
     "rtype": "gpu",
     "gpu": "text",
     "x": 610,
     "y": 138,
     "w": 1200,
     "h": 90,
     "opts": {
      "text": "Accounts",
      "size": 72,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "status",
     "rtype": "gpu",
     "gpu": "text",
     "x": 610,
     "y": 227,
     "w": 1600,
     "h": 43,
     "opts": {
      "text": "",
      "size": 34,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "list",
     "rtype": "gpu",
     "gpu": "appList",
     "x": 610,
     "y": 292,
     "w": 1500,
     "h": 400,
     "opts": {
      "items": [],
      "rowH": 120,
      "empty": "None"
     }
    },
    {
     "name": "signIn",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 610,
     "y": 724,
     "w": 760,
     "h": 106,
     "opts": {
      "text": "Sign in with GitHub",
      "vicon": "plus",
      "style": "primary",
      "color": "#3d9bff"
     },
     "onTap": "event:signIn"
    },
    {
     "name": "addToken",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 1400,
     "y": 724,
     "w": 560,
     "h": 106,
     "opts": {
      "text": "Add token",
      "vicon": "plus",
      "style": "outline"
     },
     "onTap": "event:addToken"
    }
   ]
  },
  {
   "kind": "gpu",
   "name": "login",
   "theme": "m_tricolour",
   "bg": "theme",
   "components": [
    {
     "name": "nav",
     "rtype": "gpu",
     "gpu": "sideNav",
     "x": 126,
     "y": 114,
     "w": 300,
     "h": 726,
     "opts": {
      "items": "Store, grid\nInstalled, check\nUSB, usb\nSettings, gear",
      "sel": 0
     }
    },
    {
     "name": "back",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 480,
     "y": 138,
     "w": 96,
     "h": 96,
     "opts": {
      "text": "",
      "vicon": "back",
      "style": "round",
      "color": "#f4f7fb"
     },
     "onTap": "event:back"
    },
    {
     "name": "title",
     "rtype": "gpu",
     "gpu": "text",
     "x": 610,
     "y": 138,
     "w": 1600,
     "h": 90,
     "opts": {
      "text": "Sign in with GitHub",
      "size": 72,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "qr",
     "rtype": "gpu",
     "gpu": "qr",
     "x": 610,
     "y": 290,
     "w": 520,
     "h": 520,
     "opts": {
      "text": ""
     }
    },
    {
     "name": "code",
     "rtype": "gpu",
     "gpu": "text",
     "x": 1220,
     "y": 330,
     "w": 1400,
     "h": 140,
     "opts": {
      "text": "",
      "size": 120,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "url",
     "rtype": "gpu",
     "gpu": "text",
     "x": 1224,
     "y": 500,
     "w": 1400,
     "h": 50,
     "opts": {
      "text": "",
      "size": 40,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "status",
     "rtype": "gpu",
     "gpu": "text",
     "x": 1224,
     "y": 580,
     "w": 1400,
     "h": 50,
     "opts": {
      "text": "",
      "size": 38,
      "font": "label",
      "align": "left",
      "color": "dim"
     }
    },
    {
     "name": "cancel",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 1220,
     "y": 700,
     "w": 520,
     "h": 106,
     "opts": {
      "text": "Cancel",
      "style": "outline"
     },
     "onTap": "event:cancel"
    }
   ]
  },
  {
   "kind": "gpu",
   "name": "phone",
   "theme": "m_tricolour",
   "bg": "theme",
   "components": [
    {
     "name": "nav",
     "rtype": "gpu",
     "gpu": "sideNav",
     "x": 126,
     "y": 114,
     "w": 300,
     "h": 726,
     "opts": {
      "items": "Store, grid\nInstalled, check\nUSB, usb\nSettings, gear",
      "sel": 0
     }
    },
    {
     "name": "back",
     "rtype": "gpu",
     "gpu": "vbutton",
     "x": 480,
     "y": 138,
     "w": 96,
     "h": 96,
     "opts": {
      "text": "",
      "vicon": "back",
      "style": "round",
      "color": "#f4f7fb"
     },
     "onTap": "event:back"
    },
    {
     "name": "title",
     "rtype": "gpu",
     "gpu": "text",
     "x": 610,
     "y": 138,
     "w": 1200,
     "h": 90,
     "opts": {
      "text": "Phone access",
      "size": 72,
      "font": "bold",
      "align": "left",
      "color": "text"
     }
    },
    {
     "name": "toggleRow",
     "rtype": "gpu",
     "gpu": "appList",
     "x": 610,
     "y": 292,
     "w": 1100,
     "h": 120,
     "opts": {
      "items": [],
      "rowH": 120
     }
    },
    {
     "name": "url",
     "rtype": "gpu",
     "gpu": "text",
     "x": 610,
     "y": 450,
     "w": 1100,
     "h": 200,
     "opts": {
      "text": "",
      "size": 34,
      "font": "label",
      "align": "left",
      "color": "dim",
      "wrap": true
     }
    },
    {
     "name": "error",
     "rtype": "gpu",
     "gpu": "text",
     "x": 610,
     "y": 680,
     "w": 1100,
     "h": 120,
     "opts": {
      "text": "",
      "size": 34,
      "font": "label",
      "align": "left",
      "color": "#ffb020",
      "wrap": true
     }
    },
    {
     "name": "qr",
     "rtype": "gpu",
     "gpu": "qr",
     "x": 1900,
     "y": 220,
     "w": 600,
     "h": 600,
     "opts": {
      "text": ""
     }
    }
   ]
  }
 ]
};
