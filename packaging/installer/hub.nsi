; Integration Hub — Windows installer (W2.5)
;
; Built by packaging/installer/build.sh (`npm run installer:build`):
;   build.sh stages build/stage/ then:  makensis /DVERSION=x.y.z hub.nsi
;   → build/IntegrationHub-<version>-setup.exe
;
; What it does (docs/windows-desktop-installer.md §W2.5, packaging/README.md):
;   1. payload → $PROGRAMFILES64\IntegrationHub (node.exe + app/ workspace
;      sources + prod node_modules incl. the win32-x64 better-sqlite3
;      prebuild; the hub runs from source via tsx exactly like the Docker
;      image);
;   2. service via WinSW: IntegrationHub.exe (service-control shim) +
;      IntegrationHub.xml. A bare `sc.exe binPath=node.exe` cannot serve the
;      SCM control handshake (dies with error 1053); WinSW owns the SCM
;      protocol while supervision semantics stay in HubSupervisor;
;   3. firewall: inbound TCP rule for the ASTM device listener (profile
;      private — conservative LAN default, never public);
;   4. data dir %ProgramData%\IntegrationHub created by the service entry on
;      first boot (SQLite + state + logs) — then the W2 setup wizard runs;
;   5. uninstall: stop + delete the service FIRST, remove the payload, then
;      ask about the data dir (keep vs delete) — the W2 uninstall contract.

Unicode true
ManifestDPIAware true

; Standard headers (LogicLib → ${If}; nsDialogs → ${NSD_*}; FileFunc →
; ${FileExists}; MUI2 → MUI_HEADER_TEXT on the custom page).
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !error "pass /DVERSION=x.y.z (build.sh always does)"
!endif
!ifndef STAGE
  !define STAGE "build\stage"
!endif

; ------------------------------------------------------------------ metadata
; NSIS VIProductVersion requires strict X.X.X.X — strip any semver
; pre-release suffix (e.g. 0.1.0-rc.1 → 0.1.0.0) so pre-release tags can
; compile; the FULL version stays in the file name + ProductVersion key.
!searchparse /noerrors "${VERSION}" "-" NSIS_PREREL
!ifndef NSIS_PREREL
  !define NSIS_BASE "${VERSION}"
!else
  !searchparse /noerrors "${VERSION}" "" NSIS_BASE "-"
!endif
OutFile "build\IntegrationHub-${VERSION}-setup.exe"
Name "Integration Hub ${VERSION}"
VIProductVersion "${NSIS_BASE}.0"
VIAddVersionKey ProductName "Integration Hub"
VIAddVersionKey FileDescription "Integration Hub — local edge installer (W2.5)"
VIAddVersionKey LegalCopyright ""
VIAddVersionKey FileVersion "${NSIS_BASE}.0"
VIAddVersionKey ProductVersion "${VERSION}"

InstallDir "$PROGRAMFILES64\IntegrationHub"
InstallDirRegKey HKLM "Software\IntegrationHub" "InstallDir"
RequestExecutionLevel admin
ShowInstDetails show
ShowUnInstDetails show
SetCompressor /SOLID lzma

; ------------------------------------------------------------------- pages
Page directory
Page custom PortPage PortPageLeave
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

; ------------------------------------------------------------------- vars
Var DevicePort   ; ASTM listener (firewall rule + service env)
Var HttpPort     ; console/API (service env + shortcut)
Var dlg
Var hDev
Var hHttp
Var tmp

Function .onInit
  StrCpy $DevicePort "5000"
  StrCpy $HttpPort "3000"
FunctionEnd

; ------------------------------------------------------- port pick (custom)
Function PortPage
  !insertmacro MUI_HEADER_TEXT "Listener ports" "Ports the hub listens on; the device port is opened on the local network firewall profile."
  nsDialogs::Create 1018
  Pop $dlg
  ${NSD_CreateLabel} 0 0 100% 12u "Device listener port (ASTM/HL7 — analyzers connect here):"
  ${NSD_CreateText} 0 16u 60u 13u $DevicePort
  Pop $hDev
  ${NSD_CreateLabel} 0 40u 100% 12u "Console/API port (the browser address for the setup wizard):"
  ${NSD_CreateText} 0 56u 60u 13u $HttpPort
  Pop $hHttp
  nsDialogs::Show
FunctionEnd

Function PortPageLeave
  ${NSD_GetText} $hDev $DevicePort
  ${NSD_GetText} $hHttp $HttpPort
  IntOp $tmp $DevicePort + 0          ; garbage coerces to 0 → caught below
  ${If} $tmp < 1
  ${OrIf} $tmp > 65535
    MessageBox MB_ICONEXCLAMATION "Device port must be a number between 1 and 65535."
    Abort
  ${EndIf}
  IntOp $DevicePort $tmp + 0
  IntOp $tmp $HttpPort + 0
  ${If} $tmp < 1
  ${OrIf} $tmp > 65535
    MessageBox MB_ICONEXCLAMATION "Console port must be a number between 1 and 65535."
    Abort
  ${EndIf}
  IntOp $HttpPort $tmp + 0
FunctionEnd

; --------------------------------------------------------------- install
Section "Install"
  SetOutPath "$INSTDIR"

  ; Upgrade path: stop + unregister an existing service before overwriting.
  ${If} ${FileExists} "$INSTDIR\IntegrationHub.exe"
    DetailPrint "Stopping existing Integration Hub service…"
    nsExec::ExecToLog '"$INSTDIR\IntegrationHub.exe" stop'
    Pop $tmp
    nsExec::ExecToLog '"$INSTDIR\IntegrationHub.exe" uninstall'
    Pop $tmp
    Sleep 1500
  ${EndIf}

  ; 1. Payload: node.exe + WinSW shim at the root, app/ beside them.
  File "/oname=node.exe" "${STAGE}\payload\node.exe"
  File "/oname=IntegrationHub.exe" "${STAGE}\payload\WinSW-x64.exe"

  ; Service definition written by the installer itself — the ports were just
  ; picked on the custom page (the template lives beside this script as
  ; service.xml.tpl; the test suite pins the two files in sync).
  DetailPrint "Writing the service definition (ports $DevicePort / $HttpPort)…"
  FileOpen $tmp "$INSTDIR\IntegrationHub.xml" w
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Cannot write the service definition to $INSTDIR."
    Abort
  ${EndIf}
  FileWrite $tmp '<service>$\r$\n'
  FileWrite $tmp '  <id>integration-hub</id>$\r$\n'
  FileWrite $tmp '  <name>Integration Hub (local)</name>$\r$\n'
  FileWrite $tmp '  <description>Healthcare device integration hub - local edge service</description>$\r$\n'
  FileWrite $tmp '  <env name="NODE_ENV" value="production"/>$\r$\n'
  FileWrite $tmp '  <env name="HUB_DATA_DIR" value="%ProgramData%\\IntegrationHub"/>$\r$\n'
  FileWrite $tmp '  <env name="PORT" value="$HttpPort"/>$\r$\n'
  FileWrite $tmp '  <env name="DEVICE_PORT" value="$DevicePort"/>$\r$\n'
  FileWrite $tmp '  <env name="HUB_LOCAL_SETUP" value="1"/>$\r$\n'
!ifdef ORTHANC
  ; W3 bundle: point the hub at the colocated Orthanc REST endpoint so the
  ; imaging wiring (MWL monitor + modality health) is on from the first boot.
  ; The REST server answers only the hub's localhost (RemoteAccessAllowed=false
  ; in the config written below).
  FileWrite $tmp '  <env name="ORTHANC_URL" value="http://127.0.0.1:8042"/>$\r$\n'
!endif
!ifdef UPDATES
  ; W4 update delivery: the in-hub agent polls UPDATE_SOURCE for signed
  ; manifests (Ed25519, UPDATE_PUBLIC_KEY pins the signing key) and stages
  ; desired.json; the service process IS the HubSupervisor, so the swap is
  ; health-gated + auto-rollback WITHOUT touching the SCM registration.
  FileWrite $tmp '  <env name="UPDATE_SOURCE" value="${UPDATE_SOURCE}"/>$\r$\n'
  FileWrite $tmp '  <env name="UPDATE_PUBLIC_KEY" value="${UPDATE_PUBLIC_KEY}"/>$\r$\n'
!endif
  FileWrite $tmp '  <executable>%BASE%\\node.exe</executable>$\r$\n'
  FileWrite $tmp '  <arguments>--import tsx %BASE%\\app\\packages\\server\\src\\service-cli.ts</arguments>$\r$\n'
  FileWrite $tmp '  <workingdirectory>%BASE%\\app</workingdirectory>$\r$\n'
  FileWrite $tmp '  <startmode>Automatic</startmode>$\r$\n'
  FileWrite $tmp '  <onfailure action="restart" delay="5 sec"/>$\r$\n'
  FileWrite $tmp '  <onfailure action="restart" delay="10 sec"/>$\r$\n'
  FileWrite $tmp '  <onfailure action="restart" delay="30 sec"/>$\r$\n'
  FileWrite $tmp '  <resetfailure>86400</resetfailure>$\r$\n'
  FileWrite $tmp '  <stoptimeout>20 sec</stoptimeout>$\r$\n'
  FileWrite $tmp '  <stopparentprocessfirst>false</stopparentprocessfirst>$\r$\n'
  FileWrite $tmp '  <log mode="roll-by-size">$\r$\n'
  FileWrite $tmp '    <logpath>%ProgramData%\\IntegrationHub\\logs</logpath>$\r$\n'
  FileWrite $tmp '    <sizeThreshold>10240</sizeThreshold>$\r$\n'
  FileWrite $tmp '    <keepFiles>8</keepFiles>$\r$\n'
  FileWrite $tmp '  </log>$\r$\n'
  FileWrite $tmp '</service>$\r$\n'
  FileClose $tmp
  SetOutPath "$INSTDIR\app"
  File /r "${STAGE}\payload\app\*.*"

!ifdef ORTHANC
  ; ------------------------------------------------------------- W3 Orthanc
  ; The AGPL imaging engine as its OWN Windows service (adjacent process,
  ; REST-only contact with the hub — §3.2/§7.5.5). Own shim, own config,
  ; own data dir under %ProgramData%.
  SetOutPath "$INSTDIR\orthanc"
  File "/oname=Orthanc.exe" "${STAGE}\payload\orthanc\Orthanc.exe"
  File "/oname=OrthancHub.exe" "${STAGE}\payload\WinSW-x64.exe"
  CreateDirectory "$INSTDIR\orthanc\plugins"
  CreateDirectory "$INSTDIR\orthanc\worklists"
  File "/oname=plugins\ModalityWorklists.dll" "${STAGE}\payload\orthanc\ModalityWorklists.dll"

  DetailPrint "Writing the Orthanc service configuration…"
  FileOpen $tmp "$INSTDIR\orthanc\orthanc.json" w
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Cannot write the Orthanc configuration to $INSTDIR\orthanc."
    Abort
  ${EndIf}
  ; REST stays localhost-only (the hub is the only client); DICOM 4242 must
  ; accept C-STORE/C-FIND from the facility modalities on the LAN.
  FileWrite $tmp '{$\r$\n'
  FileWrite $tmp '  "Name": "IntegrationHub-Orthanc",$\r$\n'
  FileWrite $tmp '  "DicomAet": "INTEGRATIONHUB",$\r$\n'
  FileWrite $tmp '  "DicomPort": 4242,$\r$\n'
  FileWrite $tmp '  "HttpPort": 8042,$\r$\n'
  FileWrite $tmp '  "RemoteAccessAllowed": false,$\r$\n'
  FileWrite $tmp '  "AuthenticationEnabled": false,$\r$\n'
  FileWrite $tmp '  "Plugins": ["$INSTDIR\\orthanc\\plugins"],$\r$\n'
  FileWrite $tmp '  "StorageDirectory": "$COMMONPROGRAMDATA\\IntegrationHub\\orthanc\\storage",$\r$\n'
  FileWrite $tmp '  "IndexDirectory": "$COMMONPROGRAMDATA\\IntegrationHub\\orthanc\\index",$\r$\n'
  FileWrite $tmp '  "Worklists": { "Enabled": true, "Database": "$INSTDIR\\orthanc\\worklists" }$\r$\n'
  FileWrite $tmp '}$\r$\n'
  FileClose $tmp
  CreateDirectory "$COMMONPROGRAMDATA\IntegrationHub\orthanc\storage"
  CreateDirectory "$COMMONPROGRAMDATA\IntegrationHub\orthanc\index"

  FileOpen $tmp "$INSTDIR\orthanc\OrthancHub.xml" w
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Cannot write the Orthanc service definition."
    Abort
  ${EndIf}
  FileWrite $tmp '<service>$\r$\n'
  FileWrite $tmp '  <id>integration-hub-orthanc</id>$\r$\n'
  FileWrite $tmp '  <name>Integration Hub Orthanc (local)</name>$\r$\n'
  FileWrite $tmp '  <description>AGPL DICOM engine for Integration Hub - adjacent REST service</description>$\r$\n'
  FileWrite $tmp '  <executable>%BASE%\\Orthanc.exe</executable>$\r$\n'
  FileWrite $tmp '  <arguments>%BASE%\\orthanc.json</arguments>$\r$\n'
  FileWrite $tmp '  <workingdirectory>%BASE%</workingdirectory>$\r$\n'
  FileWrite $tmp '  <startmode>Automatic</startmode>$\r$\n'
  FileWrite $tmp '  <onfailure action="restart" delay="5 sec"/>$\r$\n'
  FileWrite $tmp '  <onfailure action="restart" delay="10 sec"/>$\r$\n'
  FileWrite $tmp '  <stoptimeout>20 sec</stoptimeout>$\r$\n'
  FileWrite $tmp '  <log mode="roll-by-size">$\r$\n'
  FileWrite $tmp '    <logpath>%ProgramData%\\IntegrationHub\\logs</logpath>$\r$\n'
  FileWrite $tmp '    <sizeThreshold>10240</sizeThreshold>$\r$\n'
  FileWrite $tmp '    <keepFiles>8</keepFiles>$\r$\n'
  FileWrite $tmp '  </log>$\r$\n'
  FileWrite $tmp '</service>$\r$\n'
  FileClose $tmp
!endif

  ; 2. Firewall: inbound TCP for the device listener on the private profile
  ;    (conservative LAN default — analyzers live on the local network; the
  ;    rule is deliberately NOT created for the public profile).
  DetailPrint "Firewall rule for the device listener (TCP $DevicePort, private profile)…"
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Integration Hub device listener" dir=in action=allow protocol=TCP localport=$DevicePort profile=private'
  Pop $tmp
!ifdef ORTHANC
  ; Modalities C-STORE/C-FIND the imaging engine on the LAN — DICOM port in,
  ; same conservative private profile (never public).
  DetailPrint "Firewall rule for the DICOM listener (TCP 4242, private profile)…"
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Integration Hub DICOM listener" dir=in action=allow protocol=TCP localport=4242 profile=private'
  Pop $tmp
!endif

  ; 3. Register + start the service(s) (WinSW serves the SCM protocol).
  ;    A FAILED registration must fail the installer — a silent miss here
  ;    produces an installed payload with NO service (found by the W5
  ;    smoke drill on the hosted x64 runner), so every result code is
  ;    checked and any failure aborts with a visible message.
!ifdef ORTHANC
  DetailPrint "Registering the Orthanc (imaging) service…"
  nsExec::ExecToLog '"$INSTDIR\orthanc\OrthancHub.exe" install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Registering the Orthanc service FAILED (exit $0). See the installer log."
    Abort
  ${EndIf}
  nsExec::ExecToLog '"$INSTDIR\orthanc\OrthancHub.exe" start'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Starting the Orthanc service FAILED (exit $0). See the installer log."
    Abort
  ${EndIf}
!endif
  DetailPrint "Registering the Integration Hub service…"
  nsExec::ExecToLog '"$INSTDIR\IntegrationHub.exe" install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Registering the Integration Hub service FAILED (exit $0). See the installer log for the WinSW output."
    Abort
  ${EndIf}
  nsExec::ExecToLog '"$INSTDIR\IntegrationHub.exe" start'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Starting the Integration Hub service FAILED (exit $0). See the installer log for the WinSW output."
    Abort
  ${EndIf}

  ; 4. Start-menu shortcuts: the console (the setup wizard runs there on
  ;    first boot) and the uninstaller.
  CreateDirectory "$SMPROGRAMS\Integration Hub"
  CreateShortCut "$SMPROGRAMS\Integration Hub\Integration Hub Console.lnk" "http://127.0.0.1:$HttpPort/"
  CreateShortCut "$SMPROGRAMS\Integration Hub\Uninstall Integration Hub.lnk" "$INSTDIR\uninstall.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\IntegrationHub" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\IntegrationHub" "DisplayName" "Integration Hub"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\IntegrationHub" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\IntegrationHub" "DisplayVersion" "${VERSION}"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\IntegrationHub" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\IntegrationHub" "NoRepair" 1
SectionEnd

; -------------------------------------------------------------- uninstall
Section "Uninstall"
  ; Order matters (the W2 contract): the service(s) are stopped and
  ; unregistered BEFORE anything touches the payload or the data dir.
!ifdef ORTHANC
  nsExec::ExecToLog '"$INSTDIR\orthanc\OrthancHub.exe" stop'
  Pop $tmp
  nsExec::ExecToLog '"$INSTDIR\orthanc\OrthancHub.exe" uninstall'
  Pop $tmp
!endif
  nsExec::ExecToLog '"$INSTDIR\IntegrationHub.exe" stop'
  Pop $tmp
  nsExec::ExecToLog '"$INSTDIR\IntegrationHub.exe" uninstall'
  Pop $tmp
  Sleep 1500

  DetailPrint "Removing the firewall rule…"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Integration Hub device listener"'
  Pop $tmp
!ifdef ORTHANC
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Integration Hub DICOM listener"'
  Pop $tmp
!endif

  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\IntegrationHub.exe"
  Delete "$INSTDIR\IntegrationHub.xml"
  Delete "$INSTDIR\uninstall.exe"
!ifdef ORTHANC
  RMDir /r "$INSTDIR\orthanc"
!endif
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\Integration Hub\Integration Hub Console.lnk"
  Delete "$SMPROGRAMS\Integration Hub\Uninstall Integration Hub.lnk"
  RMDir "$SMPROGRAMS\Integration Hub"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\IntegrationHub"
  DeleteRegKey HKLM "Software\IntegrationHub"

  ; Data dir: keep (backup first!) vs delete — the operator decides.
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Delete the hub data directory?$\r$\n$\r$\n$COMMONPROGRAMDATA\IntegrationHub$\r$\n$\r$\nYes  = delete (results, audit, setup are LOST)$\r$\nNo   = keep it (back it up first — copy the folder while the service is stopped)" \
    IDYES DeleteData IDNO KeepData
DeleteData:
  DetailPrint "Deleting the data directory…"
  RMDir /r "$COMMONPROGRAMDATA\IntegrationHub"
  Goto DataDone
KeepData:
  DetailPrint "Data directory kept: $COMMONPROGRAMDATA\IntegrationHub"
DataDone:
SectionEnd
