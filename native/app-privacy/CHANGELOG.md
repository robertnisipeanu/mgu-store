# app-privacy changelog

## 1.6.2

- iDrive 7: MainApp 8.2.8 is patched too, with 8.3.2's edits but for the update-availability sweep, which 8.2.8 does not have (issue #83). The tool's JSON names it `8.2.8` in `mainapp`. MainApp 8.3.2 and 8.1.1 are patched exactly as before.

## 1.6.1

- iDrive 8: MainApp-21 9.2.15 is patched too, with the same effect as on 9.3.4: our apps are left out of its backend app inventory and updates, app-repository queries and downloads, release notes requests, platform analytics, corrupt-app reports and DiagOap readout, and a crashed one is only restarted. The tool's JSON names it `9.2.15` in `mainapp`. MainApp-21 9.3.4 is patched exactly as before.

## 1.6.0

- iDrive 7: MainApp 8.1.1 is patched too, with the same effect as on 8.3.2: our apps are left out of its backend app inventory, backend-triggered and autonomous updates, app-repository queries and downloads and corrupt-app reports, and a crashed one is only restarted. 8.1.1 has no platform analytics or DiagOap readout to filter. The tool's JSON names the MainApp release in `mainapp`. MainApp 8.3.2 is patched exactly as before.
- Requires the deploy tool 0.6.3, which installs apps on MainApp 8.1.1.

## 1.5.0

- iDrive 7: MainApp gives a local-only app's keychain creation (`CertificateManager.js`) 125 s instead of 35 s, so the deploy tool's longer wait and its diagnosis can finish. Stock apps are unchanged. iDrive 8 is unchanged.

## 1.4.0

- iDrive 8: MainApp-21 (`/usr/lib/oap-mainapp21`) is patched too, at the next start of the head unit. Our apps are left out of its backend app inventory, app-repository queries and downloads, release-notes request, install/crash/start/stop analytics, corrupt-app reports and DiagOap readout. A crashed local-only app is only restarted, with the same 5 restarts in 10 minutes as on iDrive 7; one left stopped can be started again from its tile. On iDrive 8 the tool never asks for MainApp-21 to be restarted (`nextStart` in its JSON instead). iDrive 7 is unchanged.

## 1.3.0

- A local-only app that crashes is only restarted: its data is kept, it stays installed and its tile stays enabled. After 5 restarts in 10 minutes, the next crash leaves it stopped until it is started again (its tile, MainApp, or the next boot); deaths while the head unit shuts down do not count. Other apps keep MainApp's crash recovery.
