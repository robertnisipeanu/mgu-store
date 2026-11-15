# BABO CODING

BABO CODING is a Windows desktop companion for MGU Store, presented in an
offline simulation mode. Its connection check, Store installation, and USB
preparation buttons only add simulation messages to the activity log.

The app does not open network connections, start SSH or installer processes,
read the private-key field, inspect local packages, or read or write USB files.
The target and connection fields are display-only and are not saved.

## Build and test

The app uses Windows Forms and the .NET Framework included with Windows.
Building and testing require the Windows .NET Framework C# compiler. Run the
build and test scripts in Windows PowerShell with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test.ps1
```

The desktop executable and test output are written to `out\`.

## Existing MGU Store workflows

The repository's separate Windows installer documents first installation,
uninstall, SSH connection options, preparing an offline USB repository with
`usb-repo`, and first-installing from that repository with `--from`. BABO
CODING does not invoke those workflows yet. Adding real-device actions
requires a separate verified integration with those documented interfaces.

The repository does not establish real-car iDrive 8 testing, I-Level
detection, standalone SSH-login verification, local package inspection,
diagnostic export, or a legacy installer workflow. This app makes no
compatibility claim and does not control vehicle safety functions.
